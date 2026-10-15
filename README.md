# ⚡ KiroLex

A desktop chat client for [Kiro CLI](https://github.com/aws/kiro-cli), built with Electron + React + TypeScript.

KiroLex provides a native GUI for interacting with Kiro CLI's Agent Communication Protocol (ACP), offering multi-session management, per-session model routing, and a rich chat experience.

![License](https://img.shields.io/badge/license-MIT-blue.svg)

## Features

### Chat
- **Streaming responses** with real-time markdown rendering (GFM + syntax highlighting)
- **File attachments** — drag & drop or paste images from clipboard
- **Tool call visualization** — see agent actions with approve/deny permission dialogs
- **Per-session message queue** — follow-ups sent while an agent is busy queue automatically, render as editable/cancellable/reorderable cards, and run FIFO when the turn finishes (optional merge mode)
- **Loop mode** — repeatedly re-send a prompt at configurable intervals
- **Usage tracking** — view context window usage and credit consumption per session

### Sessions
- **Multi-session** — run multiple conversations in parallel, each with independent context
- **Per-session model selection** — switch models per session; each session runs its own kiro-cli process, so switching one chat never disturbs another. The list comes from `kiro-cli chat --list-models` and is cached, so a retired model name is never hardcoded here
- **Session folders** — organize sessions into collapsible folders
- **Drag & drop reordering** — rearrange sessions and move them between folders
- **Duplicate session** — fork a conversation with full history injected as context
- **Cross-session context** — link sessions to share context from one conversation into another
- **Rename / Delete** with confirmation dialogs
- **Unread indicators** — see which background sessions received new responses

### Workspace & files
- **Split view** — up to 4 chats side by side (`1x1` / `1x2` / `2x1` / `2x2`), each a full pane with its own composer, queue and attachments; dividers are draggable and an empty slot keeps its grid cell so filling it later does not move the other panes
- **Workspace browser** — browse the local filesystem and open files in an in-app tabbed viewer. Deliberately NOT tied to a chat: reading a directory or a file never requires a connected backend
- **File-changes panel** — per turn, the files the agent edited (with diffs) and the commands it ran; paths that no longer resolve are struck through instead of silently doing nothing when clicked
- **Image size capping** — every image handed to the model is downscaled to 1500px first. Bedrock rejects a *whole conversation* when any image in it exceeds 2000px on a side, and that rejection is permanent for that backend session, so this is prevention rather than recovery

### Desktop
- **System tray** — minimize to tray, restore on double-click
- **Single instance** — a second launch focuses the existing window instead of starting a rival process
- **Splash screen** — shown until the renderer has hydrated its sessions from disk
- **Proxy support** — auto-detects system proxy settings (Windows registry / macOS shell profile)
- **Resizable sidebar** with collapse toggle
- **Customizable font size** via settings dialog

## Platform support

| Platform | State |
|---|---|
| macOS (arm64) | Primary development target; everything here is exercised on it, and `npm run package:mac` produces a working unsigned `.app`/`.dmg` |
| Windows | Designed for, not currently verified end to end. The kiro-cli lookup covers `%LOCALAPPDATA%`/`%APPDATA%` install layouts, proxy detection reads the registry, and `node_modules/.bin/*.cmd` shims are used for `dev:hot`. Known gap: a `dev:hot` hot-restart cannot release kiro-cli session locks gracefully, because Windows has no POSIX signals (see `scripts/dev-hot.mjs`) |
| Linux | Untested. Nothing is known to be macOS-only beyond the traffic-light window styling, which is already platform-guarded |

## Where state lives

Everything durable is under `~/.kirolex/`, **not** in `localStorage`. The renderer is
loaded from two different origins (`file://` for a normal start, `http://localhost:5173`
in dev), and `localStorage` is origin-scoped — so anything kept there was silently lost
on every switch between `npm start` and `npm run dev:hot`.

```
~/.kirolex/
├── sessions/<id>/       # record.json (title, model, project, pin/archive) +
│                        # transcript.jsonl + history.md per chat
├── trash/               # deleted chats, kept 30 days before being aged out
├── ui-state.json        # UI state: project groups, split layout + sizes, panel
│                        # widths, settings, drafts, open file tabs, usage gauges
├── config.json          # agent profiles, executor cap, last workspace directory
├── logs/                # main.log (app) and dev-hot.log (dev supervisor)
├── capped/              # 1500px copies of oversized images (originals untouched)
├── pasted/              # clipboard screenshots
└── memory/              # preferences / projects / history injected into new chats
```


## Prerequisites

- [Kiro CLI](https://github.com/aws/kiro-cli). It is located in this order: `KIRO_CLI_PATH`,
  then the known install layouts (`%LOCALAPPDATA%\Kiro-Cli`, `%LOCALAPPDATA%\Programs\kiro-cli`,
  `%APPDATA%\kiro-cli` on Windows; `~/.local/bin`, `/usr/local/bin`, `/opt/homebrew/bin`
  on macOS/Linux), and finally the bare name on `PATH`. Both the chat executor and the
  helper commands (`--list-models`, `--list-sessions`, `agent list`, `/usage`) use the
  same resolver, so an install reachable only via `KIRO_CLI_PATH` works for all of them.
- Node.js >= 18

## Installation

```bash
git clone https://github.com/xenobe/kirolex.git
cd kirolex
npm install
```

## Development

```bash
npm run dev:hot   # recommended
```

`scripts/dev-hot.mjs` supervises three things: Vite for renderer HMR, `tsc --watch` for
the main process, and Electron itself — relaunched when `dist/main` changes. It skips
no-op rebuilds (identical output = no restart) and **waits for an in-flight turn to
finish** before restarting, so a code change never kills a running answer. Vite and
Electron start in parallel; the main process retries `loadURL` because either can win
the race. Supervisor output goes to both the terminal and `~/.kirolex/logs/dev-hot.log`.

```bash
npm run dev       # plain: Vite + Electron, no hot restart, no turn-awareness
npm start         # run the built app (file:// origin)
```

## Build

```bash
npm run build
```

Compiles TypeScript and bundles the renderer with Vite. Output goes to `dist/`.

## Package

```bash
npm run package:mac        # macOS .dmg + .zip (arm64)
npm run package:mac:dir    # macOS .app only, no disk image — fastest check
npm run package            # Windows portable directory (--win --dir)
npm run package:installer  # Windows installer
```

macOS builds are unsigned on purpose (`build.mac.identity: null`): with no Developer ID
configured, electron-builder would otherwise fail the whole run trying to sign. Set it
to a real identity when there is one. Linux has no target configured yet.

## Tests

```bash
npm test         # node --test "tests/**/*.test.ts"
npm run test:watch
```

**No test dependency is installed.** Node >= 23 strips TypeScript types natively, so the
built-in `node:test` runner executes the `.ts` sources directly — no Jest, no Vitest, no
transform step, nothing to keep in sync with the Vite config.

The trade-off this buys and its limit: the runner covers **pure modules only**, because
it cannot render React or provide Electron's `window`/`ipcRenderer`. The intricate logic
is therefore extracted into dependency-free modules so it can be tested at all:

| Module | Covered rules |
|---|---|
| `src/renderer/splitLayout.ts` | dragged proportions carried across a pane-count change; an empty slot occupying its real grid cell and inheriting the row above, so adding a pane moves nothing |
| `src/main/imagePaths.ts` | which image paths are found in outgoing text — POSIX and Windows, spaces and CJK, tool-call records, trailing punctuation |
| `src/main/acp-client.ts` | kiro-cli lookup order (`KIRO_CLI_PATH` first, then the Windows and macOS/Linux install layouts) |

Anything involving a live kiro-cli, a real window or the filesystem layout is still
verified by hand against `~/.kirolex/logs/main.log`.

## Built-in Commands

Type these in the chat input:

| Command | Description |
|---------|-------------|
| `/usage` | Show current token usage and credit consumption |
| `/stop` | Force interrupt the agent and reconnect |

## Tech Stack

- **Electron** — desktop shell, IPC, tray, clipboard
- **React 18** — UI components
- **Vite** — bundler and dev server
- **TypeScript** — full type safety across main and renderer
- **react-markdown** + remark-gfm + rehype-highlight — rich message rendering
- **@dnd-kit** — drag and drop for session management
- **kiro-cli ACP** — JSON-RPC communication with the AI agent

## Architecture

```
scripts/
└── dev-hot.mjs           # dev supervisor: Vite + tsc --watch + turn-aware Electron restart

tests/                    # node:test suites over the pure modules (see Tests above)

src/
├── main/
│   ├── index.ts          # Electron main: IPC handlers, tray, proxy, ui-state, history priming
│   ├── acp-client.ts     # JSON-RPC client wrapping the kiro-cli subprocess; kiro-cli lookup
│   ├── imagePaths.ts     # pure: find image paths in outgoing text (POSIX + Windows)
│   ├── sessionStore.ts   # durable per-chat records and transcripts under ~/.kirolex/sessions
│   ├── config.ts         # agent profiles, remote targets, model fallback order
│   ├── logger.ts         # file + console logging (~/.kirolex/logs/main.log)
│   └── preload.ts        # context bridge exposing kiroApi and the ui-state snapshot
└── renderer/
    ├── App.tsx           # root component, split layout, file viewer, state orchestration
    ├── uiStore.ts        # localStorage-shaped API backed by ~/.kirolex/ui-state.json
    ├── splitLayout.ts    # pure: split-pane geometry (carried sizes, empty-cell rules)
    ├── hooks/
    │   ├── useAcp.ts         # core hook: sessions, streaming, hydration, queues, loops
    │   └── useFeatureFlags.ts # live feature switches owned by the main process
    ├── components/
    │   ├── ChatArea.tsx       # messages, composer, per-turn plan/file/command panels
    │   ├── Sidebar.tsx        # session tree, projects, folders, drag & drop
    │   ├── SettingsDialog.tsx # fonts, split grid, feature switches
    │   ├── ConfirmDialog.tsx  # in-app confirm; replaces window.confirm (which blocks)
    │   ├── PermissionBar.tsx  # inline tool approve/deny (replaced the modal dialog)
    │   ├── WorkspacePanel.tsx # session-independent local file browser
    │   ├── ContextPanel.tsx   # file/text context attachments
    │   ├── MemoryDialog.tsx   # preferences / projects / history viewer
    │   ├── ErrorBoundary.tsx  # keeps a render crash from blanking the whole window
    │   └── Icons.tsx          # inline SVG icon set
    └── styles/
        └── global.css    # full UI styling
```

## License

[MIT](./LICENSE)
