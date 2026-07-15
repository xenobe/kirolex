# Session Architecture Design: Durable Sessions, Swappable Executors

Status: DRAFT — pending review
Branch: `feature/remote-ssh-sessions`
Author: Kiro (agent), directed by Yinan

## 1. Problem Statement

The current codebase has two divergent session models, neither of which supports
the new requirements:

- **Local `main` (4c9e42f)**: one `AcpClient` process per session, keyed by
  `sessionId`, in a `Map<sessionId, SessionEntry>` capped at
  `MAX_CONCURRENT_SESSIONS = 8`. Simple, no cross-session routing bugs by
  construction, but a session's identity is tied 1:1 to its process for life.
- **origin/main (his, `019d873`)**: one `AcpClient` process **per model**, keyed
  by model name, in a `Map<model, AcpClient>`. Multiple sessions of the same
  model share one process; `sessionId` is just an identifier the shared process
  hands out via `client.newSession()`. Requires careful update-routing
  (`lastPromptedSessionRef`, `streamingIdsRef`) to avoid cross-session message
  bleed — the exact bug his `cbdba14`/`e3da2ee`/`e8346cb` commits fixed.

New requirements that neither model satisfies:

1. **Migrate a session between local and remote** without losing its
   conversation.
2. **No conversation lost by accident** — durable, crash-safe persistence.
3. **Context engineering baked in** — memory injection and cross-session
   context links are first-class, not bolted on.

## 2. Core Design Principle

**Decouple session identity/state from the process that executes it.**

- A **Session** is a durable record: identity, transcript, target profile,
  context-engineering state. It survives app restarts, process crashes, and
  target migrations.
- An **Executor** is a live `AcpClient` process bound to a session
  *temporarily*. A session has zero or one live executor at any time.
  Attaching/detaching an executor is a first-class operation, not an
  implementation detail of connect/disconnect.

This directly enables migration: detach the old executor (transcript is
already durable, nothing to save), create a new executor against the new
target, attach it, replay recent context as a priming message.

## 3. Why Per-Session Executors (Not Per-Model, Like `origin/main`)

Model-shared executors make "migrate this one session" ambiguous — if three
sessions share one process and you want to move *one* of them to a remote
host, the other two are still using that same process; you cannot cleanly detach
just one without either (a) killing the process for all three, or (b) building
a second layer of indirection that model-sharing doesn't currently have.

Per-session executors keep the mental model simple: exactly one session ↔ one
process, ever. The cost is more processes (one per open tab, as today), which
is already bounded by `MAX_CONCURRENT_SESSIONS`.

Decision: **keep per-session executors**, extend with a decoupled lifecycle
(attach/detach) rather than adopting per-model sharing.

## 4. Data Model

```ts
interface SessionRecord {
  id: string;                    // stable sessionId, survives migration
  createdAt: number;
  updatedAt: number;
  title: string;                 // user-facing label (renameable)

  // Durable transcript -- source of truth, not a cache.
  // Written through (not write-behind) on every message boundary.
  transcript: Message[];

  // Current target. Mutable -- migration = changing this + reattaching.
  profile: AgentProfileRef;      // { kind:'local', projectId } | { kind:'remote', sshHost, sshPort, identityFile, remoteWorkdir, projectId }

  // Project identity for the layered memory store (§6.3). WRITE-ONCE:
  // set at creation, OR assigned once for a chat that has none (null → project).
  // NEVER changed project→project, never un-set. Immutable once non-null.
  // Carried UNCHANGED across model/host swaps and migration.
  // (lives on the profile; shown here for reference)

  // Context engineering: no per-session links -- sharing is via the layered,
  // project-scoped shared memory store (§6). Tracks last injection only.
  lastMemoryInjection?: { charCount: number; at: number };

  // Lifecycle.
  executorState: 'detached' | 'attaching' | 'attached' | 'disconnected' | 'error';
  lastExecutorError?: string;

  // Set while attached to a REMOTE executor; lets reconnect() (§5.1) re-attach
  // the SAME live process after a transient link loss instead of replaying.
  remoteExecutorHandle?: { sshHost: string; pid?: number; sessionHandle?: string };
}
```

`SessionRecord` lives on disk at `~/.kirolex/sessions/<id>/record.json` +
`transcript.jsonl` (append-only, one line per message — durable-by-construction,
no risk of losing a mid-write JSON file to a crash).

## 5. Executor Lifecycle (State Machine)

```
detached --[attach(profile)]--> attaching --[connect ok]--> attached
attached --[detach()]--> detached
attached --[transient link loss, remote proc ALIVE]--> disconnected
disconnected --[reconnect(): re-attach SAME live proc]--> attached
disconnected --[remote proc confirmed DEAD]--> detached
attaching --[connect fail]--> error --[retry: attach()]--> attaching
attached --[local proc dies unexpectedly]--> detached  (transcript already durable)
```

Note the two distinct recovery paths — **reconnect** (§5.1, preferred when the
underlying process still lives) and **migrate/replay** (§5.2, a fresh process).
Conflating them is a design error: reconnect preserves live backend state,
replay does not.

- `attach(sessionId, profile)`: spins up a fresh `AcpClient` for `profile`,
  wires `update`/`error`/`disconnected` events to route by `sessionId`
  (per-session process, so no shared-process routing ambiguity), sets
  `executorState='attached'`.
- `detach(sessionId)`: gracefully disconnects the `AcpClient`, sets
  `executorState='detached'`. Transcript is untouched — it was already durable.

### 5.1 Reconnect to Live Process (MUST implement — first-class path)

The common failure mode for a remote session is a **transient link loss**
(network blip, laptop sleep/wake, VPN reconnect) where the remote kiro-cli
process is **still running** on the host. In that case the correct action is to
**re-attach to that same live process**, NOT to tear it down and replay:

- On link loss to a remote executor, transition `attached → disconnected`
  (do NOT kill the remote process; it keeps running server-side). Surface a
  `↻ Reconnect` affordance in the UI (coral state dot).
- `reconnect(sessionId)`: re-establish the SSH channel to the *same* remote
  process (by pid/socket/session-handle recorded when it was first attached),
  re-subscribe to its ACP event stream, transition `disconnected → attached`.
  **No transcript replay** — the live process already holds full backend state
  (tool-call state, cached reads, MCP connections, its own session context).
  Where the backend is kiro-cli and the live process is unrecoverable but its
  native session store survives on that *same host*, prefer kiro-cli's native
  `--resume-id <sessionId>` (see §5.3) over transcript-replay — it restores the
  backend's own persisted state, higher fidelity than replay.
- Only if reconnect **fails** because the remote process is confirmed gone
  (host rebooted, process killed, session-handle invalid) does the session fall
  back to `detached`, at which point re-`attach()` + replay (§5.2) is the
  recovery — accepting the loss of live backend state as unavoidable in that case.
- Reconnect applies to remote executors; a local executor whose process dies is
  genuinely gone (no "still alive elsewhere" case) → `detached` directly.

### 5.2 Migrate / Fresh-Attach with Replay

- **Migration** = `detach(id)` then `attach(id, newProfile)` — the transcript
  and `id` never change, only the underlying process and its target.
- On a fresh attach (migration, or reconnect-fallback after the old process
  died), the last N transcript messages are replayed as a `<hidden>` priming
  block so the new process inherits the *conversation* it never saw live (same
  technique his `6ac964e` duplicate-session commit already uses — reusable here).
- Explicit limitation: replay reconstructs the **conversation text only**, NOT
  the prior process's live backend state. This is a genuine downgrade vs.
  reconnect (§5.1) and is why reconnect is always preferred when the process
  is still alive.

### 5.3 Recovery Mechanism Selection (LOCKED)

Two persistence sources exist, with opposite strengths. The choice between them
is decided by the recovery scenario, not by preference:

| Source | Fidelity | Portable across host? | Portable across backend? | Use for |
|---|---|---|---|---|
| kiro-cli native `--resume-id` | High (real backend state) | **No** — cwd-scoped + host-locked | **No** — kiro-cli only | Reconnect / same-target resume |
| KiroLex transcript store (`~/.kirolex/sessions/`) | Medium (text only) | **Yes** — self-contained file | **Yes** — backend-agnostic | **Migration (LOCKED)** |

**Decision (locked):**

- **Reconnect / resume on the SAME target** → prefer kiro-cli native
  `--resume-id` when the backend is kiro-cli and its native session survives on
  that host (highest fidelity). Falls back to transcript-replay if native resume
  is unavailable (non-kiro-cli backend, or native session gone).
- **Migration (local↔remote, or any target change)** → **always the KiroLex
  transcript store**, never native resume. Native `--resume-id` is cwd-scoped
  and host-locked — it structurally *cannot* cross machines, so it is disqualified
  for migration by construction. The portable, backend-agnostic transcript is the
  only mechanism that crosses host/backend boundaries, so it is the **locked
  migration mechanism**.

Rationale for locking the transcript store as the migration mechanism: it is the
sole persistence layer decoupled from both the execution host and the backend
identity. kiro-cli native resume (best for reconnect) is precisely the *least*
migration-capable because that same host/cwd coupling is what gives it fidelity.
The two are complementary, not competing — each owns the scenario the other
cannot serve.

## 6. Context Engineering (Layered, Project-Scoped Shared Memory)

Context is shared **through a layered, project-scoped shared-memory store**, NOT
through direct session-to-session links. With N peer sessions (the per-session
model, §3), direct A→B links would be an N×N problem (cycles, staleness,
"which of my sessions should this follow?"). Routing all context through a
shared store instead scales (N reads/writes, not N²), avoids cycles by
construction, and matches MeshClaw's memory model — which is the correct
reference for *this* layer (unlike the connection layer, which is native
per-session, not MeshClaw's hub-spoke).

### 6.1 Two memory layers

- **Global layer** — applies to every session in every project. Universal
  preferences (style, tools) + global lessons ("always X", "never Y").
- **Project layer** — applies only to sessions within one project. Project
  context/decisions/blockers, project-scoped conversation history, and
  project-scoped lessons.

Both are injected into a session's first prompt (after creation OR
reattachment) as a hidden block, tracked via `lastMemoryInjection` so it fires
once per attach-cycle, not per message. A session receives:
`global ⊕ project(this session's project)`.

### 6.2 Two complementary sharing mechanisms

Context sharing has **two mechanisms that coexist** — they solve different
problems and are not mutually exclusive:

**(a) Project memory pool — the DEFAULT (implicit, eventual, project-scoped).**
Sessions in the same project share context *implicitly* by reading (and, via
consolidation, writing) the same project memory layer (§6.1). Sessions in
unrelated projects share only the global layer. This is the primary mechanism:
zero user setup, bounded to within-project, scales to many peers (N reads of one
store, not N² links), acyclic by construction. Sharing is eventual — a session
sees pooled updates at its next lifecycle boundary (§6.4), not live.
Answers: "sessions working on the same project should accumulate and share
context automatically, over time."

**(b) Explicit live link — OPTIONAL power-user layer (explicit, live, pairwise).**
Ported from his `aa29e2a` design: a session may explicitly link one or more
*source* sessions; on each send, only that source's new messages (high-water
`syncedCount` delta) are injected as a hidden user-framed reference block. This
is **live** (per-send), **explicit** (user picks the pair), and **verbatim**
(raw messages, not distilled). It is NOT project-scoped — you can link any
session to any other on purpose.
Answers: "I want THIS session to watch THAT specific session's live output right
now" (e.g. a monitor session tracking a worker).

**How they coexist without conflict:**
- Different triggers: pool injects at lifecycle boundaries (§6.4); explicit link
  injects a delta on every send.
- Different representation: pool carries distilled/consolidated project memory;
  explicit link carries raw verbatim message deltas. So even if a source session
  is both in a target's project pool AND explicitly linked, the two blocks are
  different representations, not exact duplicates (low double-count risk; can be
  deduped later if noticed).
- Default vs opt-in: every session gets the pool for free; the explicit link is
  an off-by-default control the user turns on for a specific pair.
- Scaling: the pool is the answer for the many-peer default; explicit links stay
  sparse by nature (a user only wires a few on purpose), so N² never materializes.

Both are roadmap (post-PR-#1). The pool is the primary design; the explicit link
is retained as an optional feature carried over from his implementation.

### 6.3 Project identity and the local↔remote cwd-mismatch

The project layer is keyed by **project identity**. Default project identity =
the session's **working directory basename**, which aligns with kiro-cli's own
native session store (also cwd-scoped, §5.3).

Problem: a local session in `~/code/projectA` and a remote session in
`/home/ec2-user/projectA` are the *same logical project* but have different
absolute cwd strings — a naive `cwd` key would split their shared memory into
two, defeating within-project sharing across the local↔remote boundary (exactly
the migration case, §5.2).

Resolution — a **stable `projectId` on the profile**, decoupled from the raw
absolute path:

- `AgentProfileRef` carries an explicit `projectId` (string). Default derivation
  when unset: `basename(cwd)` (so `~/code/projectA` and `/home/ec2-user/projectA`
  both derive `projectA` and share one project memory layer).
- On **migration** (§5.2) the `projectId` is carried over unchanged even though
  the cwd changes — the migrated remote session keeps the same project memory as
  its local origin. This is the load-bearing rule that makes local↔remote
  same-project sharing work.
- Basename collisions (two unrelated `build` dirs) are possible; the user may
  override `projectId` explicitly to disambiguate or to bind a differently-named
  local and remote directory to the same project. Explicit `projectId` always
  wins over the basename default.
- The project memory store lives at `~/.kirolex/memory/projects/<projectId>/`
  (project layer) alongside `~/.kirolex/memory/global/` (global layer).

Note: kiro-cli's *native* session store remains keyed by its own absolute cwd
(outside our control, §5.3) — so native `--resume-id` is still same-host/same-cwd
only. Our `projectId` layer is KiroLex's own memory abstraction on top, and is
what bridges the local↔remote same-project case that native cwd-keying cannot.

### 6.4 Injection timing, swaps, compaction, and removal

**Injection triggers (when a session receives memory):** at lifecycle
boundaries only — `{ session created, reattached, post-compaction, one-time
null→project assignment }`. NOT on every send (that is the explicit-link
mechanism's job, §6.2b). Tracked via `lastMemoryInjection`.

**Session dimension swaps — model/host YES, project WRITE-ONCE:**
- **model or host swap: allowed anytime.** A process is bound to `(model, host)`
  and cannot change them in place, so a swap = tear down this session's executor,
  spawn a new one with the new model/host, replay transcript (§5.2 mechanism).
  Memory re-injects as part of the reattach. `projectId` is carried UNCHANGED.
- **project swap: DISALLOWED.** `projectId` is write-once (§4). The only allowed
  project transition is `null → project` (assigning an unassigned chat to a
  project, once). Reasons:
  - `null → project` is *additive* — the chat previously had only global memory;
    assignment just adds the project layer going forward. No conflict, clean.
  - `project X → project Y` would be *replacement* — the old project's context is
    already in the live conversation and cannot be un-injected (§6.4 removal), so
    it would leave a context mix. Disallowing it avoids the mess entirely.
  - A chat that "should" belong to a different project = start a new chat there.
- A session with **no `projectId`** (unassigned/scratch chat) receives only the
  global layer. On one-time assignment, the project layer begins injecting at the
  next lifecycle boundary — cleanly, since only global was present before.

**Updates to the pool while a session runs** are eventual: a running session
keeps its snapshot until its next lifecycle boundary. Live mid-session pool
updates are deliberately NOT done (don't scale; cause context to shift under the
user). A delta-before-next-prompt refresh is a possible future upgrade, not default.

**Compaction is an injection trigger.** Compaction (`/compact` or automatic)
compresses oldest context first — which is exactly where the injected memory
block sits, so it gets summarized away. Therefore treat post-compaction as a
re-injection point. Compaction affects only the *live model context*; it never
touches the durable `transcript.jsonl` (§7), which retains full history.

**Removal from shared memory** (editing/deleting a global or project entry)
takes effect only for FUTURE injections — next attach / new session /
post-compaction. It does NOT retract from a running session: once injected, the
content is in that session's live context and cannot be un-injected. Hard
removal from a running session requires detaching/restarting it. No live
retraction path exists.

### 6.5 Consolidation (LATER PR — not in PR #1)

Memory has two halves. PR #1 ships only the first; consolidation is the second,
deferred to a later PR:

1. **Injection** (read memory → into the prompt) — PR #1. Reads the layered
   `global ⊕ project` files and injects them at lifecycle boundaries (§6.4).
2. **Consolidation** (conversations → written into memory, automatically) —
   later PR. A background transform that reads a session's raw
   `transcript.jsonl` and distills it into the structured memory files, so the
   store fills itself instead of being hand-maintained.

Planned KiroLex consolidation (mirrors MeshClaw's mechanism):
- **Triggers**: after ~N messages per session (update project context /
  preferences) and after an idle interval (write a dated project-history summary
  + extract lessons). Exact thresholds TBD at build time.
- **Input**: the durable `transcript.jsonl` (already the source of truth — this
  is why the store contract matters: consolidation is just another *reader* of
  it, requiring no change to PR #1's foundation, per §12).
- **Output**: appends/updates entries in the project layer
  (`~/.kirolex/memory/projects/<projectId>/`) and, for universal rules, the
  global layer. Explicit "remember X" writes immediately (no wait for the timer).
- **Cost**: consolidation needs an extra LLM summarization call per trigger —
  which is precisely why it is deferred (PR #1's injection is pure file I/O, no
  model call). Distillation prompt-engineering also lives here.

Until consolidation ships, the memory files are hand-maintained (or written on
explicit "remember X"); injection (§6.4) works regardless.

### 6.6 MeshClaw vs KiroLex — memory comparison

For the *memory* layer specifically (distinct from the connection layer, where
they diverge — KiroLex peer-sessions vs MeshClaw hub + ephemeral subagents),
the two are close cousins. MeshClaw is the correct reference for this layer.

| Dimension | KiroLex (this design) | MeshClaw |
|---|---|---|
| Layered store | global ⊕ project | prefs/projects/history/lessons |
| Scoping | project (`projectId`, write-once) | workspace |
| Injection | at lifecycle boundaries (§6.4) | into prompt |
| Consolidation engine | deferred to later PR (§6.5) | core (≈30-msg / ≈3h-idle) |
| History decay tiers | planned with consolidation | explicit 4-tier (14/60/180/365d) |
| Cross-session sharing | pool (default) + optional explicit live links (§6.2b) | pool only (no explicit pairwise links) |
| Memory modes | not designed (possible later) | Persistent / Incognito / Temporary |
| Vector/semantic memory | not designed | optional (local embeddings) |
| Removal / consistency semantics | explicit (eventual, no live retraction, §6.4) | consolidation-driven, not detailed |

Two takeaways: (1) **consolidation** is the main thing MeshClaw has that KiroLex
defers — it is the self-maintaining transform, not a storage necessity; (2) on
**sharing**, KiroLex is a superset — it keeps the pool (MeshClaw's model) AND
adds the optional explicit live link (§6.2b) that MeshClaw lacks.

## 7. Durability Guarantees

The durability rule is asymmetric by message role — this is deliberate:

- **User messages are persisted the instant they are sent.** You never lose
  what you typed. This is the load-bearing guarantee.
- **Assistant responses are persisted only when FULLY complete.** A partial /
  in-flight response interrupted by a crash, SSH drop, or app quit is
  **discarded, never written**. On recovery the last user message sits
  un-answered; the user simply re-sends (or edits) it to restart that turn.
  Rationale: a persisted half-response would be misleading context on any
  later replay, and the user explicitly does not want in-flight responses
  preserved.
- Consequence: `transcript.jsonl` only ever contains complete messages — no
  partial-assistant records to reconcile, which also simplifies replay (§5.2)
  and reconnect (§5.1).
- `SessionRecord.executorState` reflects reality on disk — on app start, any
  session found `attached` from a prior run is treated as `detached` (local) or
  `disconnected` (remote, pending a reconnect probe), never assumed live.
- No conversation is deleted implicitly. Deleting a session is an explicit
  user action (existing `acp:delete-session` IPC), separate from
  detach/migrate/reconnect.

## 8. Concurrency Cap

`MAX_CONCURRENT_SESSIONS` now caps **attached executors**, not total sessions.
A user can have unlimited `detached` (dormant, fully persisted) sessions; only
N can be `attached` (live process) simultaneously. Opening a session beyond
the cap while others are attached prompts to detach one first (replacing
today's hard reject-with-error).

## 9. Open Questions for Review

1. **Session replay on remote reattach**: RESOLVED (see §5.3) — hybrid locked.
   Prefer kiro-cli native `--resume-id` for reconnect/same-target resume where
   available (highest fidelity); use the portable KiroLex transcript store for
   migration (host/backend-crossing), which is the locked migration mechanism.
   Native resume is disqualified for migration (cwd-scoped + host-locked).
2. **Context sharing model**: RESOLVED (see §6) — two complementary mechanisms.
   Primary/default = layered, project-scoped shared-memory pool (implicit,
   eventual, acyclic, scales to many peers). Optional power-user layer = explicit
   live pairwise links (his `aa29e2a`, per-send verbatim deltas). They coexist:
   different triggers, different representation, pool is default / links are
   opt-in. Cycle risk applies only to explicit links, which stay sparse by nature.
3. **Migration UX**: does migrating a session pop a confirmation (since it
   interrupts any in-flight response), or is it only allowed when
   `executorState !== 'attaching'`?

## 10. What This Replaces / Where It Lives

This design supersedes both:
- The `sessionClients: Map<sessionId, SessionEntry>` in local `main` (extends
  it with attach/detach + durable transcript-as-source-of-truth).
- His `clients: Map<model, AcpClient>` model-sharing approach (not adopted;
  per-session executors kept for migration clarity, per section 3).

Implementation lands in `src/main/index.ts` (executor lifecycle + IPC),
`src/main/sessionStore.ts` (new — durable record read/write, replacing ad-hoc
disk writes), and `src/renderer/hooks/useAcp.ts` (attach/detach/migrate calls,
replacing direct connect/disconnect).

## 11. PR Sequencing

The design ships across multiple PRs. Each later PR builds on PR #1's foundation
and requires no rework of it (see §12 forward-compat check).

### PR #1 — Foundation: session management + basic memory (NOT remote)

Scope (the load-bearing base every later PR depends on):
- **Per-session executor model** — replace his `Map<model, AcpClient>` with
  `Map<sessionId, {client, profile}>` (§3). One process per session, isolated.
- **Durable session store** — `~/.kirolex/sessions/<id>/{record.json,
  transcript.jsonl}` with the three-way separation + `schemaVersion` durability
  contract (§4, §7). Append-only transcript, asymmetric durability (user msg
  instant / assistant only-when-complete / in-flight discarded).
- **`projectId` on the profile** — write-once dimension (§4, §6.4).
- **Basic memory injection** — global ⊕ project layer injected at lifecycle
  boundaries (§6.1, §6.4). Layering yes; consolidation engine deferred.
- **The two seam hooks** — "session ready for first prompt" lifecycle event +
  `projectId` on profile — so later work attaches without touching orchestration.
- **model/host swap** = executor respawn + transcript replay (§5.2 mechanism),
  reused later by migration.
- **UI (intrinsic to the foundation):**
  - Per-session state dot (live/attached vs dormant/detached) driven by
    `executorState` — his version has no session-state indicator.
  - Project label + one-time `null→project` assignment control (write-once rule
    enforced in UI; no re-assign once set).
  - Sidebar grouping by project (unassigned chats in their own group).

Explicitly OUT of PR #1 (later PRs): remote SSH + "Run on" form, migration UI
(⇄ Migrate) + reconnect UI (↻ Reconnect), native `--resume-id`, layered-memory
consolidation engine + memory editor dialog, explicit live links (§6.2b),
liveness probing/states.

### Later PRs (each rides on PR #1, additive only)

- **PR: Remote SSH sessions** — `profile.remote` + `buildSshArgs` + provisioning
  scripts + NewSessionDialog remote form. (Files already scaffolded on the
  current branch; re-home to a later branch.)
- **PR: Migration** — local↔remote via detach + attach-new-profile + transcript
  replay; `projectId` carried unchanged.
- **PR: Reconnect-to-live** — `disconnected` state + native `--resume-id`
  hybrid (§5.1, §5.3).
- **PR: Memory consolidation** — auto-distill transcripts into the layered store
  (MeshClaw-style), + optional explicit live links (§6.2b).

## 12. Forward-Compatibility Check (PR #1 vs planned designs)

Confirms PR #1's foundation needs no rework for any later PR:

| Later feature | Rides on PR #1 via | Rework to PR #1? |
|---|---|---|
| Remote SSH | `profile.remote` field (additive) + per-session executor already spawns per-profile | None |
| Migration | detach/attach (already in executor lifecycle) + transcript store + `projectId` carried | None |
| Reconnect-to-live | `remoteExecutorHandle` field + `disconnected` state (additive to enum) | None |
| Memory consolidation | reads durable `transcript.jsonl` (already the source of truth) + writes memory store (separate dir) | None |
| Explicit live links | optional field on record.json (additive) | None |
| Layered memory | project layer keyed by `projectId` (already first-class) | None |

Why no rework: PR #1 lays (a) per-session executors with attach/detach lifecycle,
(b) the durable store with the append-only + `schemaVersion` + 3-way-separation
contract, (c) `projectId` first-class + write-once, (d) the two seam hooks. Every
later feature is additive against these — new optional fields, new state-enum
values, new subscribers to existing events, or a separate store. Nothing later
restructures the foundation.
