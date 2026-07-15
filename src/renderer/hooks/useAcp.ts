import { useState, useCallback, useEffect, useRef } from 'react';
import type { Message, ToolCall, Session, SessionFolder } from '../App';

type ConnectionStatus = 'disconnected' | 'connecting' | 'connected';

interface PermissionRequest {
  requestId: number;
  sessionId: string;
  tool?: string;
  description?: string;
}

export function useAcp() {
  const [status, setStatus] = useState<ConnectionStatus>('disconnected');
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<Session[]>(() => {
    // Load persisted sessions
    try {
      const saved = localStorage.getItem('kirolex-sessions');
      if (saved) return JSON.parse(saved);
    } catch {}
    return [];
  });
  const [folders, setFolders] = useState<SessionFolder[]>(() => {
    try {
      const saved = localStorage.getItem('kirolex-folders');
      if (saved) return JSON.parse(saved);
    } catch {}
    return [];
  });
  // Projects: explicit, user-created grouping (write-once memory scope §6.4).
  // A project is just a name; membership is a session's projectId.
  const [projects, setProjects] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem('kirolex-projects');
      if (saved) return JSON.parse(saved);
    } catch {}
    return [];
  });
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(() => {
    try {
      return localStorage.getItem('kirolex-last-session') || null;
    } catch {}
    return null;
  });
  const [messages, setMessages] = useState<Message[]>([]);
  // Session IDs currently streaming (supports parallel streaming across models)
  const [streamingIds, setStreamingIds] = useState<string[]>([]);
  // Session IDs whose per-session executor is ATTACHED this run (design §3).
  // Drives the live/dormant sidebar dot; a persisted session is dormant until
  // it is opened and its executor attaches.
  const [attachedSessionIds, setAttachedSessionIds] = useState<string[]>([]);
  // Session IDs whose executor is currently ATTACHING (spawn/connect in flight).
  // Drives the "connecting" flash dot.
  const [connectingSessionIds, setConnectingSessionIds] = useState<string[]>([]);
  const [permissionRequest, setPermissionRequest] = useState<PermissionRequest | null>(null);
  const [activeToolCall, setActiveToolCall] = useState<string | null>(null);
  const [usage, setUsage] = useState<{ contextPercent: number; credits: number; turnMs?: number } | null>(null);
  // Cross-session context sync: the current session's linked sources (0..n).
  // Persistent per-session; each send injects only each source's NEW messages.
  const [contextLinks, setContextLinks] = useState<{ sourceId: string; sourceTitle: string }[]>([]);

  const currentMessageRef = useRef<string>('');
  const toolCallsRef = useRef<Map<string, ToolCall>>(new Map());
  const currentSessionRef = useRef<string | null>(null);
  const messagesCacheRef = useRef<Map<string, Message[]>>(new Map());
  const streamingIdsRef = useRef<Set<string>>(new Set());
  // Attached-executor set (mirrors attachedSessionIds state).
  const attachedIdsRef = useRef<Set<string>>(new Set());
  // Connecting (attaching) set (mirrors connectingSessionIds state).
  const connectingRef = useRef<Set<string>>(new Set());
  // When sessionId is missing from an update, use the last session we prompted
  // (not the currently viewed session). This prevents stale chunks from a
  // previous session bleeding into a newly created session.
  const lastPromptedSessionRef = useRef<string | null>(null);
  // Per-session usage (credits/context), keyed by sessionId
  const usageMapRef = useRef<Map<string, { contextPercent: number; credits: number; turnMs?: number }>>(new Map());
  // Maps sessionId -> model, so every call can route to the right kiro-cli process
  const sessionModelRef = useRef<Map<string, string>>(new Map());
  // Per-target-session context links: targetId -> array of { sourceId, sourceTitle, syncedCount }.
  // Each source keeps its own high-water mark so every send only forwards that
  // source's delta (new messages). A target can sync from multiple sources.
  const contextLinksRef = useRef<Map<string, { sourceId: string; sourceTitle: string; syncedCount: number }[]>>(new Map());
  // Duplicated sessions awaiting backend context injection on their first send.
  // Keyed by the duplicate's pending id -> the source session's message history.
  // On the first real send, this history is injected as a <hidden> priming block
  // so the freshly-created kiro-cli session inherits the full conversation context.
  const duplicateHistoryRef = useRef<Map<string, Message[]>>(new Map());
  // In-flight session creations, keyed by the pending tempId -> Promise<realId>.
  // Lets a send that happens before connection completes await the SAME creation
  // instead of racing a duplicate (which lost the message).
  const creatingRef = useRef<Map<string, Promise<string>>>(new Map());
  const DEFAULT_MODEL = 'claude-opus-4.6';

  // Always-fresh mirror of sessions for reads inside async callbacks (closures
  // otherwise capture a stale sessions array). Used to resolve a session's
  // authoritative projectId at prompt time.
  const sessionsRef = useRef<Session[]>([]);
  sessionsRef.current = sessions;
  const projectForSession = (sid: string | null): string | undefined =>
    sid ? sessionsRef.current.find((s) => s.id === sid)?.projectId : undefined;

  const persistContextLinks = () => {
    try {
      localStorage.setItem(
        'kirolex-context-links',
        JSON.stringify(Array.from(contextLinksRef.current.entries()))
      );
    } catch {}
  };

  const refreshContextLinks = (sid: string | null) => {
    const arr = contextLinksRef.current.get(sid || '') || [];
    setContextLinks(arr.map((l) => ({ sourceId: l.sourceId, sourceTitle: l.sourceTitle })));
  };

  const addStreaming = (sid: string) => {
    if (!sid) return;
    if (!streamingIdsRef.current.has(sid)) {
      streamingIdsRef.current.add(sid);
      setStreamingIds(Array.from(streamingIdsRef.current));
    }
  };
  const removeStreaming = (sid: string | null) => {
    if (!sid) return;
    if (streamingIdsRef.current.delete(sid)) {
      setStreamingIds(Array.from(streamingIdsRef.current));
    }
  };

  const addAttached = (sid: string) => {
    if (!sid) return;
    if (!attachedIdsRef.current.has(sid)) {
      attachedIdsRef.current.add(sid);
      setAttachedSessionIds(Array.from(attachedIdsRef.current));
    }
  };
  const removeAttached = (sid: string | null) => {
    if (!sid) return;
    if (attachedIdsRef.current.delete(sid)) {
      setAttachedSessionIds(Array.from(attachedIdsRef.current));
    }
  };

  const markConnecting = (sid: string | null) => {
    if (!sid) return;
    if (!connectingRef.current.has(sid)) {
      connectingRef.current.add(sid);
      setConnectingSessionIds(Array.from(connectingRef.current));
    }
  };
  const clearConnecting = (sid: string | null) => {
    if (!sid) return;
    if (connectingRef.current.delete(sid)) {
      setConnectingSessionIds(Array.from(connectingRef.current));
    }
  };

  const modelForSession = (sid: string | null): string => {
    if (!sid) return DEFAULT_MODEL;
    return sessionModelRef.current.get(sid) || DEFAULT_MODEL;
  };

  // Populate sessionModelRef from persisted sessions on init
  useEffect(() => {
    for (const s of sessions) {
      if (s.model && s.model !== 'auto') sessionModelRef.current.set(s.id, s.model);
    }
  }, []);

  // Load messages cache from localStorage on init and restore last session messages
  useEffect(() => {
    try {
      const saved = localStorage.getItem('kirolex-messages-cache');
      if (saved) {
        const entries: [string, Message[]][] = JSON.parse(saved);
        messagesCacheRef.current = new Map(entries);
        // Restore messages for last session
        const lastSid = localStorage.getItem('kirolex-last-session');
        if (lastSid) {
          const cached = messagesCacheRef.current.get(lastSid);
          if (cached && cached.length > 0) {
            setMessages(cached);
          }
        }
      }
    } catch {}
    // Load persisted context links and reflect the current session's links
    try {
      const savedLinks = localStorage.getItem('kirolex-context-links');
      if (savedLinks) {
        const entries: [string, any][] = JSON.parse(savedLinks);
        // Normalize: earlier versions stored a single object per target
        const normalized: [string, { sourceId: string; sourceTitle: string; syncedCount: number }[]][] =
          entries.map(([k, v]) => [k, Array.isArray(v) ? v : [v]]);
        contextLinksRef.current = new Map(normalized);
        const lastSid = localStorage.getItem('kirolex-last-session');
        const arr = lastSid ? contextLinksRef.current.get(lastSid) : undefined;
        if (arr) setContextLinks(arr.map((l) => ({ sourceId: l.sourceId, sourceTitle: l.sourceTitle })));
      }
    } catch {}
  }, []);

  // Eager-attach existing sessions at startup so switching is instant — no
  // click-then-wait-to-connect. Spawning an executor per chat is bounded by the
  // backend cap (MAX_CONCURRENT_SESSIONS = 8) with no LRU eviction, so we attach
  // the MOST RECENT sessions first and reserve one slot for a brand-new chat.
  // Runs once, concurrent + best-effort (skips failures), and never changes the
  // current view. Attached-but-unselected chats stay dormant (dot rule), so this
  // does not light everything green.
  const eagerAttachedRef = useRef(false);
  useEffect(() => {
    if (eagerAttachedRef.current) return;
    eagerAttachedRef.current = true;
    const EXECUTOR_CAP_FALLBACK = 8; // used only if the cap fetch fails
    const lastSid = localStorage.getItem('kirolex-last-session');
    const ordered = sessions.filter((s) => s && !String(s.id).startsWith('pending_') && !s.archived);
    // Land-on session first (so it's live immediately), then existing recency order.
    ordered.sort((a, b) => (a.id === lastSid ? -1 : b.id === lastSid ? 1 : 0));
    let cancelled = false;
    (async () => {
      try {
        // Brief settle so the current-session restore lands; then warm behind splash.
        await window.kiroApi.splashStatus?.('Loading session history…');
        await new Promise((r) => setTimeout(r, 200));
        if (cancelled) return;
        // Warm count = the auto-sized executor cap (computed in main from host
        // RAM/CPU) minus one reserved slot so "New chat" can always attach.
        let cap = EXECUTOR_CAP_FALLBACK;
        try { cap = (await window.kiroApi.getExecutorCap()) || EXECUTOR_CAP_FALLBACK; } catch {}
        const limit = Math.max(1, cap - 1);
        const toAttach = ordered.slice(0, limit);
        const total = toAttach.length;
        let done = 0;
        try { await window.kiroApi.splashStatus?.(total ? `Connecting sessions… (0/${total})` : 'Preparing…'); } catch {}
        // Full-concurrent reconnect: mark every candidate connecting up front (so
        // they ALL flash immediately, not one-at-a-time), then spawn executors in
        // parallel. Bounded by the backend cap (MAX_CONCURRENT_SESSIONS); trades a
        // larger startup spike for a much faster warm-up.
        await Promise.all(
          toAttach.map(async (s) => {
            if (cancelled || attachedIdsRef.current.has(s.id)) return;
            markConnecting(s.id);
            try {
              await window.kiroApi.loadSession(s.id, '~', modelForSession(s.id));
              addAttached(s.id);
            } catch {
              // best-effort: cap reached, connect failure, or unloadable session
            } finally {
              clearConnecting(s.id);
              done += 1;
              try { await window.kiroApi.splashStatus?.(`Connecting sessions… (${done}/${total})`); } catch {}
            }
          })
        );
      } finally {
        if (!cancelled) {
          // The landed-on (current) chat must be live before we reveal — if its
          // concurrent warm-up failed/was missed, retry it once so the default
          // selection is never shown in the 'alert' (red) state.
          const cur = currentSessionRef.current;
          const curArchived = !!sessions.find((s) => s.id === cur)?.archived;
          if (cur && !attachedIdsRef.current.has(cur) && !curArchived) {
            markConnecting(cur);
            try {
              await window.kiroApi.loadSession(cur, '~', modelForSession(cur));
              addAttached(cur);
            } catch {
              /* genuinely unresumable — will attach on next interaction */
            } finally {
              clearConnecting(cur);
            }
          }
          // Let React commit the attached state and paint before revealing, so
          // there's no 1-frame red flash on the current chat.
          await new Promise((r) => setTimeout(r, 120));
          try { await window.kiroApi.reveal?.(); } catch {}
        }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Keep ref in sync with state, persist last session.
  useEffect(() => {
    currentSessionRef.current = currentSessionId;
    if (currentSessionId) {
      try {
        localStorage.setItem('kirolex-last-session', currentSessionId);
      } catch {}
    }
  }, [currentSessionId]);

  // Cache messages for current session whenever they change.
  // Debounce localStorage writes to avoid blocking main thread during streaming.
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (currentSessionId && messages.length > 0) {
      messagesCacheRef.current.set(currentSessionId, messages);
      // Debounce: only write to localStorage after 2s of inactivity
      if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
      persistTimerRef.current = setTimeout(() => {
        try {
          const entries = Array.from(messagesCacheRef.current.entries()).slice(-20);
          localStorage.setItem('kirolex-messages-cache', JSON.stringify(entries));
        } catch {}
      }, 2000);
    }
  }, [messages, currentSessionId]);

  // Flush pending persist on unmount
  useEffect(() => {
    return () => {
      if (persistTimerRef.current) {
        clearTimeout(persistTimerRef.current);
        try {
          const entries = Array.from(messagesCacheRef.current.entries()).slice(-20);
          localStorage.setItem('kirolex-messages-cache', JSON.stringify(entries));
        } catch {}
      }
    };
  }, []);

  // Persist sessions whenever they change
  useEffect(() => {
    try {
      localStorage.setItem('kirolex-sessions', JSON.stringify(sessions));
    } catch {}
  }, [sessions]);

  // Persist folders whenever they change
  useEffect(() => {
    try {
      localStorage.setItem('kirolex-folders', JSON.stringify(folders));
    } catch {}
  }, [folders]);

  // Persist projects whenever they change
  useEffect(() => {
    try {
      localStorage.setItem('kirolex-projects', JSON.stringify(projects));
    } catch {}
  }, [projects]);

  // Seed the projects list from any projectIds already present on sessions.
  useEffect(() => {
    const fromSessions = Array.from(
      new Set(sessions.map((s) => s.projectId).filter(Boolean) as string[])
    );
    if (fromSessions.length) {
      setProjects((prev) => Array.from(new Set([...prev, ...fromSessions])));
    }
  }, []);

  useEffect(() => {
    if (!window.kiroApi) return;

    const removeUpdate = window.kiroApi.onUpdate((data: any) => {
      if (!data?.update) return;
      const { update, sessionId } = data;

      // Route updates strictly by sessionId. If the backend fails to supply one,
      // fall back to the last session we prompted (NOT the currently viewed session).
      // This prevents late-arriving chunks from a previous session bleeding into
      // a newly created/switched-to session.
      const targetSid = sessionId || lastPromptedSessionRef.current;
      if (!targetSid) return; // No session context at all, discard
      const isActiveSession = targetSid === currentSessionRef.current;

      switch (update.sessionUpdate) {
        case 'agent_message_chunk': {
          const text = update.content?.text || '';

          // Safety: only write to active session if it's actually streaming.
          // This prevents stale chunks from leaking into a freshly created session.
          if (isActiveSession && streamingIdsRef.current.has(targetSid)) {
            setMessages((prev) => {
              const last = prev[prev.length - 1];
              // Always append to the last assistant message during streaming
              if (last?.role === 'assistant') {
                return [
                  ...prev.slice(0, -1),
                  { ...last, content: last.content + text },
                ];
              } else {
                // Create new assistant message
                return [
                  ...prev,
                  {
                    id: update.messageId || `msg_${Date.now()}`,
                    role: 'assistant',
                    content: text,
                    toolCalls: [],
                    timestamp: Date.now(),
                  },
                ];
              }
            });
          } else if (targetSid) {
            // Buffer message for background session (or active session that isn't streaming)
            const cached = messagesCacheRef.current.get(targetSid) || [];
            const last = cached[cached.length - 1];
            if (last?.role === 'assistant') {
              const updated = [...cached.slice(0, -1), { ...last, content: last.content + text }];
              messagesCacheRef.current.set(targetSid, updated);
            } else {
              messagesCacheRef.current.set(targetSid, [
                ...cached,
                { id: update.messageId || `msg_${Date.now()}`, role: 'assistant' as const, content: text, timestamp: Date.now() },
              ]);
            }
          }
          break;
        }

        case 'tool_call': {
          const tc: ToolCall = {
            toolCallId: update.toolCallId,
            title: update.title || 'Tool call',
            status: update.status || 'pending',
          };
          toolCallsRef.current.set(update.toolCallId, tc);
          // Only surface the active tool for the session being viewed
          if (isActiveSession) setActiveToolCall(tc.title);
          break;
        }

        case 'tool_call_update': {
          const existing = toolCallsRef.current.get(update.toolCallId);
          if (existing) {
            existing.status = update.status;
            if (update.content?.[0]?.content?.text) {
              existing.content = update.content[0].content.text;
            }
            toolCallsRef.current.set(update.toolCallId, existing);

            if (isActiveSession) {
              if (update.status === 'completed' || update.status === 'failed') {
                // Clear after a brief moment
                setTimeout(() => setActiveToolCall(null), 800);
              } else {
                setActiveToolCall(existing.title);
              }
            }
          }
          break;
        }

        case 'permission_request': {
          setPermissionRequest({
            requestId: update.requestId,
            sessionId: sessionId,
            tool: update.tool?.name || update.toolName,
            description: update.description || update.tool?.description,
          });
          break;
        }

        case 'user_message_chunk': {
          // During session replay — only write to live messages if this is
          // the active session AND we initiated a load for it.
          const text = update.content?.text || '';
          if (isActiveSession && targetSid === lastPromptedSessionRef.current) {
            setMessages((prev) => {
              const last = prev[prev.length - 1];
              if (last?.role === 'user' && last.id === update.messageId) {
                return [...prev.slice(0, -1), { ...last, content: last.content + text }];
              }
              return [...prev, {
                id: update.messageId || `user_${Date.now()}`,
                role: 'user',
                content: text,
                timestamp: Date.now(),
              }];
            });
          } else if (targetSid) {
            // Buffer into the correct session's cache
            const cached = messagesCacheRef.current.get(targetSid) || [];
            const last = cached[cached.length - 1];
            if (last?.role === 'user' && last.id === update.messageId) {
              messagesCacheRef.current.set(targetSid, [...cached.slice(0, -1), { ...last, content: last.content + text }]);
            } else {
              messagesCacheRef.current.set(targetSid, [...cached, {
                id: update.messageId || `user_${Date.now()}`,
                role: 'user' as const,
                content: text,
                timestamp: Date.now(),
              }]);
            }
          }
          break;
        }

        case 'usage_update': {
          // Standard ACP usage update (may not be sent by kiro-cli)
          break;
        }

        case '_kiro_internal': {
          // Handle kiro-specific metadata (per-session usage)
          if (update.method === '_kiro.dev/metadata' && sessionId) {
            const turnCredits = update.meteringUsage?.[0]?.value || 0;
            const prev = usageMapRef.current.get(sessionId);
            const next = {
              contextPercent: update.contextUsagePercentage || 0,
              credits: (prev?.credits || 0) + turnCredits,
              turnMs: update.turnDurationMs,
            };
            usageMapRef.current.set(sessionId, next);
            // Only update the visible usage if this is the session being viewed
            if (isActiveSession) setUsage(next);
          }
          break;
        }

        default:
          break;
      }
    });

    const removeError = window.kiroApi.onError((error: any) => {
      console.error('ACP error:', error);
    });

    const removeDisconnected = window.kiroApi.onDisconnected((data?: any) => {
      // A per-session executor process disconnected. Clear that session's
      // streaming/loop state (design §3: one process per session).
      const sid = data?.sessionId;
      if (sid) {
        streamingIdsRef.current.delete(sid);
        removeAttached(sid); // executor gone -> dormant
        clearConnecting(sid);
      } else {
        streamingIdsRef.current.clear();
        attachedIdsRef.current.clear();
        setAttachedSessionIds([]);
        connectingRef.current.clear();
        setConnectingSessionIds([]);
      }
      setStreamingIds(Array.from(streamingIdsRef.current));
    });

    // Seam hook A (design §11): a session's executor attached and is ready for
    // its first prompt. Mark it live and reflect its (write-once) projectId.
    const removeSessionReady = window.kiroApi.onSessionReady((data) => {
      const sid = data?.sessionId;
      if (!sid) return;
      clearConnecting(sid);
      if (data.projectId) {
        setSessions((prev) =>
          prev.map((s) => (s.id === sid && !s.projectId ? { ...s, projectId: data.projectId } : s))
        );
      }
    });

    return () => {
      removeUpdate();
      removeError();
      removeDisconnected();
      removeSessionReady();
    };
  }, []);

  const connect = useCallback(async (model: string) => {
    setStatus('connecting');
    setConnectionError(null);
    try {
      await window.kiroApi.connect({ model });
      setStatus('connected');
    } catch (err: any) {
      setStatus('disconnected');
      setConnectionError(err?.message || 'Failed to connect');
    }
  }, []);

  const disconnect = useCallback(async () => {
    await window.kiroApi.disconnect();
    setStatus('disconnected');
    setCurrentSessionId(null);
  }, []);

  const newSession = useCallback(async (cwd: string, model: string = DEFAULT_MODEL, projectId?: string) => {
    await connect(model);

    // KiroLex-owned session id, stable from creation (never a pending swap).
    // Main maps kiro-cli's backend session id to this id internally.
    const id = `s_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    currentSessionRef.current = id;
    sessionModelRef.current.set(id, model);
    setCurrentSessionId(id);
    setMessages([]);
    currentMessageRef.current = '';
    toolCallsRef.current.clear();
    setUsage(null);
    setActiveToolCall(null);
    setContextLinks([]);

    if (projectId) setProjects((prev) => (prev.includes(projectId) ? prev : [...prev, projectId]));

    setSessions((prev) => [
      { id, title: 'New Chat', model, projectId, timestamp: Date.now() },
      ...prev,
    ]);
    markConnecting(id); // flash while the executor spawns

    // Register the in-flight creation so a send before connect finishes awaits
    // this same attach (id is already stable, so no swap — just gate readiness).
    const createPromise = (async (): Promise<string> => {
      try {
        await window.kiroApi.newSession(id, cwd, model, projectId);
        clearConnecting(id);
        // Executor is spawned, but the dot stays DORMANT until first use —
        // sendMessage marks it live ("live on first use"). A freshly created
        // chat you haven't sent to must not glow green.
      } catch {
        clearConnecting(id);
      } finally {
        creatingRef.current.delete(id);
      }
      return id;
    })();
    creatingRef.current.set(id, createPromise);
    return id;
  }, [connect]);

  // Duplicate a session: create a full copy at the same folder level, preserving
  // all messages and context. The backend kiro-cli session is NOT created yet;
  // the copied history is injected as a <hidden> priming block on the first send
  // (reusing the same context-rebuild pattern used for stale sessions), so the
  // model treats the duplicate as a seamless continuation with full context.
  const duplicateSession = useCallback((sessionId: string): string | undefined => {
    const src = sessions.find((s) => s.id === sessionId);
    if (!src) return undefined;

    const srcMsgs = messagesCacheRef.current.get(sessionId) || [];
    const newId = `pending_dup_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const copied = srcMsgs.map((m) => ({ ...m }));

    // Copy messages into the duplicate's display cache and persist
    messagesCacheRef.current.set(newId, copied);
    try {
      const entries = Array.from(messagesCacheRef.current.entries()).slice(-20);
      localStorage.setItem('kirolex-messages-cache', JSON.stringify(entries));
    } catch {}

    // Stash the history for backend context injection on the first send
    if (copied.length > 0) {
      duplicateHistoryRef.current.set(newId, copied);
    }

    // Copy the per-session model routing
    const model = sessionModelRef.current.get(sessionId) || DEFAULT_MODEL;
    sessionModelRef.current.set(newId, model);

    // Copy this session's own usage snapshot for display continuity
    const srcUsage = usageMapRef.current.get(sessionId);
    if (srcUsage) usageMapRef.current.set(newId, { ...srcUsage });

    // Copy context-sync links (each restarts its high-water mark at 0 so the
    // duplicate re-forwards the linked sources' history on its first send)
    const links = contextLinksRef.current.get(sessionId);
    if (links && links.length > 0) {
      contextLinksRef.current.set(newId, links.map((l) => ({ ...l, syncedCount: 0 })));
      persistContextLinks();
    }

    // Insert the duplicate right after the source, in the same folder
    setSessions((prev) => {
      const dup: Session = {
        id: newId,
        title: `dup:${src.title}`,
        model,
        folderId: src.folderId ?? null,
        timestamp: Date.now(),
      };
      const idx = prev.findIndex((s) => s.id === sessionId);
      if (idx === -1) return [dup, ...prev];
      const next = [...prev];
      next.splice(idx + 1, 0, dup);
      return next;
    });

    return newId;
  }, [sessions]);

  const switchSession = useCallback(async (sessionId: string) => {
    currentSessionRef.current = sessionId; // sync immediately to avoid leaked updates
    setCurrentSessionId(sessionId);
    currentMessageRef.current = '';
    toolCallsRef.current.clear();
    // Reflect this session's persistent context-sync links (if any)
    refreshContextLinks(sessionId);
    // Restore this session's own usage; clear the tool indicator
    setUsage(usageMapRef.current.get(sessionId) || null);
    setActiveToolCall(null);

    // Restore from local cache instantly
    const cached = messagesCacheRef.current.get(sessionId);
    setMessages(cached || []);

    // Attach the executor on switch so the SELECTED chat becomes live (green dot)
    // and is ready to prompt — regardless of whether messages are cached. (Archived
    // chats stay inert.) loadSession resumes the backend session WITHOUT re-streaming
    // history, so cached messages are never duplicated.
    const isArchived = !!sessions.find((s) => s.id === sessionId)?.archived;
    const needsLoad = !attachedIdsRef.current.has(sessionId) || !cached || cached.length === 0;
    if (!isArchived && needsLoad) {
      try {
        lastPromptedSessionRef.current = sessionId;
        markConnecting(sessionId); // flash while the executor attaches
        await window.kiroApi.loadSession(sessionId, '~', modelForSession(sessionId));
        addAttached(sessionId);
      } catch {
        // Session might not be loadable
      } finally {
        clearConnecting(sessionId);
      }
    }
  }, [sessions]);

  const sendMessage = useCallback(async (prompt: any[], localResponse?: string, attachments?: any[], model?: string) => {
    let sid = currentSessionId;
    const activeModel = model || modelForSession(sid);

    // Archived chats are inert: never attach an executor or prompt. They become
    // chattable only after being moved out of the archive (unarchived). The
    // composer is also disabled in the UI; this is the hard safety net.
    if (sid) {
      const curSess = sessions.find((s) => s.id === sid);
      if (curSess?.archived) return;
    }

    const textContent = prompt.find(p => p.type === 'text' && !p.text.startsWith('<hidden>'))?.text || '';

    // Show user message immediately in UI
    setMessages((prev) => [
      ...prev,
      { id: `user_${Date.now()}`, role: 'user', content: textContent, attachments, timestamp: Date.now() },
    ]);

    if (localResponse) {
      setMessages((prev) => [
        ...prev,
        { id: `msg_${Date.now()}`, role: 'assistant', content: localResponse, timestamp: Date.now() },
      ]);
      return;
    }

    // If no session or session is pending, create a real one
    if (!sid || sid.startsWith('pending_')) {
      // Capture the pending id first: a duplicated session stashes its source
      // history under this id and needs it injected once the real session exists.
      const pendingId = sid;
      // If a creation is already in flight for this pending session (e.g. the
      // New Chat dialog just created it), await THAT creation instead of racing
      // a duplicate — otherwise the message lands on an orphaned session.
      if (pendingId && creatingRef.current.has(pendingId)) {
        try {
          sid = await creatingRef.current.get(pendingId)!;
          currentSessionRef.current = sid;
          sessionModelRef.current.set(sid, activeModel);
          setCurrentSessionId(sid);
        } catch { /* fall through to create below */ }
      }
      if (!sid || sid.startsWith('pending_')) {
        const newId = `s_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        try {
          await window.kiroApi.newSession(newId, '~', activeModel, projectForSession(pendingId));
          const prevId = sid;
          sid = newId;
          currentSessionRef.current = sid;
          sessionModelRef.current.set(sid, activeModel);
          setCurrentSessionId(sid);
          addAttached(sid);
          if (prevId && prevId.startsWith('pending_')) {
            setSessions((prev) => prev.map((s) => s.id === prevId ? { ...s, id: sid! } : s));
          } else {
            setSessions((prev) => [
              { id: sid!, title: 'New Chat', model: activeModel, timestamp: Date.now() },
              ...prev,
            ]);
          }
        } catch (err: any) {
          setConnectionError(err?.message || 'Failed to create session');
          return;
        }
      }

      // Duplicated session: inject the copied conversation history into the new
      // backend session as a single <hidden> priming block so the model has the
      // full prior context on this very first message.
      const dupHistory = pendingId ? duplicateHistoryRef.current.get(pendingId) : undefined;
      if (dupHistory) {
        duplicateHistoryRef.current.delete(pendingId!);
        if (dupHistory.length > 0) {
          const body = dupHistory
            .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
            .join('\n\n');
          prompt = [
            {
              type: 'text',
              text: `<hidden>这是一个复制出来的会话，下面是它此前的完整对话历史。请把这些内容当作我们当前对话的已有上下文，在此基础上无缝继续，不要重复或复述这些历史：\n\n${body}</hidden>`,
            },
            ...prompt,
          ];
        }
      }
    }

    // Cross-session context sync: if this session is linked to one or more
    // sources, inject each source's NEW messages (delta since last sync) as a
    // single <hidden> block. Migrate link key if the id changed (pending -> real).
    if (currentSessionId && currentSessionId !== sid && contextLinksRef.current.has(currentSessionId)) {
      const moved = contextLinksRef.current.get(currentSessionId)!;
      contextLinksRef.current.delete(currentSessionId);
      contextLinksRef.current.set(sid!, moved);
      persistContextLinks();
    }
    const links = sid ? (contextLinksRef.current.get(sid) || []) : [];
    if (links.length > 0) {
      const sections: string[] = [];
      let changed = false;
      const updated: { sourceId: string; sourceTitle: string; syncedCount: number }[] = [];
      for (const link of links) {
        // Authoritative source: the durable transcript (uncapped, survives
        // restart, keyed by the stable KiroLex id). Fall back to the renderer
        // cache only if the transcript is empty/unreadable (e.g. a brand-new
        // source with nothing persisted yet).
        let srcMsgs: { role: string; content: string }[] = [];
        try {
          const t = await window.kiroApi.readTranscript(link.sourceId);
          srcMsgs = Array.isArray(t) && t.length > 0
            ? t
            : (messagesCacheRef.current.get(link.sourceId) || []);
        } catch {
          srcMsgs = messagesCacheRef.current.get(link.sourceId) || [];
        }
        const delta = srcMsgs.slice(link.syncedCount);
        if (delta.length > 0) {
          const body = delta
            .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
            .join('\n\n');
          sections.push(`【${link.sourceTitle}】\n${body}`);
          changed = true;
          updated.push({ ...link, syncedCount: srcMsgs.length });
        } else {
          updated.push(link);
        }
      }
      if (sections.length > 0) {
        prompt = [
          {
            type: 'text',
            text: `<hidden>下面是我提供给你参考的背景对话记录（来自我之前的几段对话），请把它们当作我们当前对话的已知信息，在回答我接下来的问题时加以利用：\n\n${sections.join('\n\n')}</hidden>`,
          },
          ...prompt,
        ];
      }
      if (changed) {
        contextLinksRef.current.set(sid!, updated);
        persistContextLinks();
      }
    }

    // Ensure the executor is attached before prompting: a just-created chat's
    // spawn may still be in flight (creatingRef). id is stable, so just wait.
    if (sid && creatingRef.current.has(sid)) {
      try { await creatingRef.current.get(sid); } catch {}
    }

    addStreaming(sid!);
    addAttached(sid!); // first use -> live
    lastPromptedSessionRef.current = sid;

    try {
      await window.kiroApi.prompt(sid, prompt, activeModel, projectForSession(sid));
    } catch (err: any) {
      // Not attached (dormant/reopened this run) -> attach the SAME session
      // (main resumes its kiro-cli session; the KiroLex id stays stable) and retry once.
      try {
        await window.kiroApi.loadSession(sid, '~', activeModel);
        await window.kiroApi.prompt(sid, prompt, activeModel, projectForSession(sid));
      } catch (retryErr: any) {
        setMessages((prev) => [
          ...prev,
          { id: `err_${Date.now()}`, role: 'assistant', content: `⚠️ ${retryErr?.message || 'Failed to send message.'}`, timestamp: Date.now() },
        ]);
      }
    } finally {
      // Prompt resolves at turn end (stopReason) - clear this session's streaming
      removeStreaming(sid);
    }

    // Update session title from first message
    setSessions((prev) =>
      prev.map((s) =>
        s.id === sid && s.title === 'New Chat'
          ? { ...s, title: textContent.slice(0, 40) || 'New Chat' }
          : s
      )
    );
  }, [currentSessionId]);

  const cancelStream = useCallback(async () => {
    if (currentSessionId) {
      await window.kiroApi.cancel(currentSessionId, modelForSession(currentSessionId));
      removeStreaming(currentSessionId);
    }
  }, [currentSessionId]);

  // Force-interrupt everything and reconnect, preserving the current view
  const forceStop = useCallback(async (model: string) => {
    // Clear all streaming state immediately
    streamingIdsRef.current.clear();
    setStreamingIds([]);
    // Try to cancel current turn
    if (currentSessionId) {
      try { await window.kiroApi.cancel(currentSessionId, modelForSession(currentSessionId)); } catch {}
    }
    // Kill all kiro-cli processes (interrupts all in-flight output)
    setStatus('connecting');
    try { await window.kiroApi.disconnect(); } catch {}
    // Reconnect (keeps currentSessionId; it becomes stale and will be
    // transparently recreated with context on the next message)
    try {
      await window.kiroApi.connect({ model });
      setStatus('connected');
    } catch (err: any) {
      setStatus('disconnected');
      setConnectionError(err?.message || 'Failed to reconnect');
    }
  }, [currentSessionId]);

  const deleteSession = useCallback(async (sessionId: string) => {
    setSessions((prev) => prev.filter((s) => s.id !== sessionId));
    // Drop any pending duplicate-history awaiting injection for this session
    duplicateHistoryRef.current.delete(sessionId);
    // Clear local message cache
    messagesCacheRef.current.delete(sessionId);
    try {
      const entries = Array.from(messagesCacheRef.current.entries()).slice(-20);
      localStorage.setItem('kirolex-messages-cache', JSON.stringify(entries));
    } catch {}
    // Clean up context links: drop this session's own links and remove it as a
    // source from any other session (its message cache is now gone).
    let linksChanged = contextLinksRef.current.delete(sessionId);
    for (const [target, arr] of contextLinksRef.current) {
      const filtered = arr.filter((l) => l.sourceId !== sessionId);
      if (filtered.length !== arr.length) {
        if (filtered.length > 0) contextLinksRef.current.set(target, filtered);
        else contextLinksRef.current.delete(target);
        linksChanged = true;
      }
    }
    if (linksChanged) persistContextLinks();
    // Refresh the current session's link indicator (a source may have been removed)
    refreshContextLinks(currentSessionRef.current);
    // Delete session files from disk
    try {
      await window.kiroApi.deleteSession(sessionId);
    } catch {}
    if (currentSessionId === sessionId) {
      setCurrentSessionId(null);
      setMessages([]);
    }
  }, [currentSessionId]);

  const renameSession = useCallback((sessionId: string, title: string) => {
    setSessions((prev) =>
      prev.map((s) => s.id === sessionId ? { ...s, title } : s)
    );
  }, []);

  const reorderSessions = useCallback((newSessions: Session[]) => {
    setSessions(newSessions);
  }, []);

  const createFolder = useCallback((name: string) => {
    const folder: SessionFolder = {
      id: `folder_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      name,
      collapsed: false,
    };
    setFolders((prev) => [...prev, folder]);
    return folder.id;
  }, []);

  const deleteFolder = useCallback((folderId: string) => {
    setFolders((prev) => prev.filter((f) => f.id !== folderId));
    // Move sessions in this folder back to root
    setSessions((prev) =>
      prev.map((s) => s.folderId === folderId ? { ...s, folderId: null } : s)
    );
  }, []);

  const renameFolder = useCallback((folderId: string, name: string) => {
    setFolders((prev) =>
      prev.map((f) => f.id === folderId ? { ...f, name } : f)
    );
  }, []);

  const toggleFolder = useCallback((folderId: string) => {
    setFolders((prev) =>
      prev.map((f) => f.id === folderId ? { ...f, collapsed: !f.collapsed } : f)
    );
  }, []);

  const moveSessionToFolder = useCallback((sessionId: string, folderId: string | null) => {
    setSessions((prev) =>
      prev.map((s) => s.id === sessionId ? { ...s, folderId } : s)
    );
  }, []);

  // Change a session's model. Updates routing; the next message runs on the new
  // model's process (stale-session retry transparently recreates it with context).
  const changeSessionModel = useCallback((sessionId: string, model: string) => {
    sessionModelRef.current.set(sessionId, model);
    setSessions((prev) =>
      prev.map((s) => s.id === sessionId ? { ...s, model } : s)
    );
    // Warm up the client for this model silently (don't touch global status)
    window.kiroApi.connect({ model }).catch(() => {});
  }, []);

  // Assign a session to a project — WRITE-ONCE (design §6.4). Allowed only for
  // an unassigned (null/undefined) session; a pending session has no durable
  // record yet, so it is rejected until its real id exists.
  const assignProject = useCallback(async (sessionId: string, projectId: string) => {
    const pid = projectId.trim();
    if (!pid || sessionId.startsWith('pending_')) return;
    const target = sessions.find((s) => s.id === sessionId);
    if (target?.projectId) return; // already assigned — write-once
    try {
      await window.kiroApi.assignProject(sessionId, pid);
      setSessions((prev) =>
        prev.map((s) => (s.id === sessionId ? { ...s, projectId: pid } : s))
      );
      setProjects((prev) => (prev.includes(pid) ? prev : [...prev, pid]));
    } catch (err) {
      console.error('assignProject failed:', err);
    }
  }, [sessions]);

  // Move a session to another project (or unassign with null). Not write-once —
  // an explicit user move. Backend resets the executor so the new project's
  // memory scope is used (no stale mixing); here we just update the sidebar's
  // grouping. No-op when the target equals the current project.
  const moveSession = useCallback(async (sessionId: string, projectId: string | null) => {
    if (sessionId.startsWith('pending_')) return;
    const pid = projectId && projectId.trim() ? projectId.trim() : null;
    const target = sessions.find((s) => s.id === sessionId);
    const current = target?.projectId ?? null;
    if (current === pid) return; // no change -> no executor reset
    try {
      await window.kiroApi.moveSession(sessionId, pid);
      setSessions((prev) =>
        prev.map((s) => (s.id === sessionId ? { ...s, projectId: pid ?? undefined, archived: false } : s))
      );
      if (pid) setProjects((prev) => (prev.includes(pid) ? prev : [...prev, pid]));
      // UI polish: the backend reset (detached) this chat's executor. Reconnect
      // it now with a connecting flash so it comes back live under the NEW
      // project's memory scope, instead of silently going dormant until the next
      // send. Best-effort — if reconnect fails, the next send re-attaches.
      markConnecting(sessionId);
      try {
        await window.kiroApi.loadSession(sessionId, '~', modelForSession(sessionId));
        addAttached(sessionId);
      } catch {
        /* stays dormant; next send will attach */
      } finally {
        clearConnecting(sessionId);
      }
    } catch (err) {
      console.error('moveSession failed:', err);
    }
  }, [sessions]);

  // Archive / unarchive a session. Archiving hides it from the main list, frees
  // its executor slot (backend detaches), and switches away if it was current.
  // Unarchiving just restores it to the list (attaches lazily on next open).
  const archiveSession = useCallback(async (sessionId: string, archived: boolean) => {
    if (sessionId.startsWith('pending_')) return;
    try {
      await window.kiroApi.archiveSession(sessionId, archived);
      setSessions((prev) =>
        prev.map((s) => (s.id === sessionId
          ? { ...s, archived, ...(archived ? { projectId: undefined } : {}) }
          : s))
      );
      if (archived) {
        removeAttached(sessionId);
        clearConnecting(sessionId);
        // If we archived the chat we're viewing, jump to the most recent
        // non-archived session and WARM it (so it isn't left showing red).
        if (currentSessionRef.current === sessionId) {
          const next = sessions.find((s) => s.id !== sessionId && !s.archived);
          if (next) {
            setCurrentSessionId(next.id);
            if (!attachedIdsRef.current.has(next.id)) {
              markConnecting(next.id);
              try {
                await window.kiroApi.loadSession(next.id, '~', modelForSession(next.id));
                addAttached(next.id);
              } catch {
                /* next interaction will attach */
              } finally {
                clearConnecting(next.id);
              }
            }
          } else {
            setCurrentSessionId(null);
          }
        }
      } else {
        // Unarchive: warm it up now so it doesn't sit in the 'alert' (not-
        // connected) state — attach the executor (connecting -> warm/idle).
        if (!attachedIdsRef.current.has(sessionId)) {
          markConnecting(sessionId);
          try {
            await window.kiroApi.loadSession(sessionId, '~', modelForSession(sessionId));
            addAttached(sessionId);
          } catch {
            /* next select/send will attach */
          } finally {
            clearConnecting(sessionId);
          }
        }
      }
    } catch (err) {
      console.error('archiveSession failed:', err);
    }
  }, [sessions]);

  // Create an (initially empty) project. Sessions join by drag-assign (§6.4).
  const createProject = useCallback((name: string) => {
    const n = name.trim();
    if (!n) return;
    setProjects((prev) => (prev.includes(n) ? prev : [...prev, n]));
  }, []);

  // Rename a PROJECT (explicit admin op): relabel the project and bulk-update
  // every member session's projectId (durable via setProject).
  const renameProject = useCallback((oldName: string, newName: string) => {
    const n = newName.trim();
    if (!n || n === oldName) return;
    sessions.forEach((s) => {
      if (s.projectId === oldName) window.kiroApi.setProject(s.id, n).catch(() => {});
    });
    setProjects((prev) => Array.from(new Set(prev.map((p) => (p === oldName ? n : p)))));
    setSessions((prev) => prev.map((s) => (s.projectId === oldName ? { ...s, projectId: n } : s)));
  }, [sessions]);

  // Delete a PROJECT: fully clear it — delete every member chat, delete the
  // project's memory directory, and remove the label. (A later same-name project
  // therefore starts fresh with no inherited memory or chats.)
  const deleteProject = useCallback((name: string) => {
    const members = sessions.filter((s) => s.projectId === name);
    members.forEach((s) => { deleteSession(s.id); });
    window.kiroApi.deleteProjectMemory(name).catch(() => {});
    setProjects((prev) => prev.filter((p) => p !== name));
  }, [sessions, deleteSession]);

  // Pin/unpin a session (pinned sessions sort to the top of their group).
  const togglePin = useCallback((sessionId: string) => {
    setSessions((prev) =>
      prev.map((s) => (s.id === sessionId ? { ...s, pinned: !s.pinned } : s))
    );
  }, []);

  // Clear a conversation's VISIBLE history (messages + local cache). Used by
  // /clear so the KiroLex view empties in step with the backend context reset.
  const clearConversation = useCallback((sessionId?: string | null) => {
    const sid = sessionId || currentSessionRef.current;
    if (!sid) { setMessages([]); return; }
    messagesCacheRef.current.set(sid, []);
    try {
      const entries = Array.from(messagesCacheRef.current.entries()).slice(-20);
      localStorage.setItem('kirolex-messages-cache', JSON.stringify(entries));
    } catch {}
    if (sid === currentSessionRef.current) setMessages([]);
  }, []);

  // Toggle a source session in the current session's context-sync set. Adding a
  // source starts it at syncedCount 0 (first send includes its existing history);
  // toggling it off removes it. Links are persistent and per-session.
  const toggleContextSource = useCallback((sourceSessionId: string) => {
    const target = currentSessionRef.current;
    if (!target || !sourceSessionId || sourceSessionId === target) return;
    const arr = contextLinksRef.current.get(target) || [];
    const exists = arr.some((l) => l.sourceId === sourceSessionId);
    let next: { sourceId: string; sourceTitle: string; syncedCount: number }[];
    if (exists) {
      next = arr.filter((l) => l.sourceId !== sourceSessionId);
    } else {
      const sourceTitle =
        sessions.find((s) => s.id === sourceSessionId)?.title || 'another session';
      next = [...arr, { sourceId: sourceSessionId, sourceTitle, syncedCount: 0 }];
    }
    if (next.length > 0) contextLinksRef.current.set(target, next);
    else contextLinksRef.current.delete(target);
    persistContextLinks();
    setContextLinks(next.map((l) => ({ sourceId: l.sourceId, sourceTitle: l.sourceTitle })));
  }, [sessions]);


  const respondPermission = useCallback(async (granted: boolean) => {
    if (permissionRequest) {
      await window.kiroApi.respondPermission(
        permissionRequest.requestId,
        granted,
        permissionRequest.sessionId
      );
      setPermissionRequest(null);
    }
  }, [permissionRequest]);

  // Derived: current view is streaming if the current session is in the streaming set
  const isStreaming = currentSessionId !== null && streamingIds.includes(currentSessionId);

  return {
    status,
    connectionError,
    sessions,
    currentSessionId,
    messages,
    isStreaming,
    streamingIds,
    attachedSessionIds,
    connectingSessionIds,
    activeToolCall,
    usage,
    permissionRequest,
    connect,
    disconnect,
    forceStop,
    newSession,
    duplicateSession,
    switchSession,
    deleteSession,
    renameSession,
    reorderSessions,
    folders,
    createFolder,
    deleteFolder,
    renameFolder,
    toggleFolder,
    moveSessionToFolder,
    changeSessionModel,
    assignProject,
    moveSession,
    archiveSession,
    projects,
    createProject,
    renameProject,
    deleteProject,
    togglePin,
    clearConversation,
    sendMessage,
    cancelStream,
    respondPermission,
    contextLinks,
    toggleContextSource,
  };
}
