export type TaskStatus = 'pending' | 'in_progress' | 'completed';

export interface PersistedTask {
  content: string;
  status: TaskStatus;
  priority?: 'high' | 'medium' | 'low';
  /** Explicit current marker; normally derived from in_progress, but persisted for reload fidelity. */
  current: boolean;
}

export type TaskLists = Record<string, PersistedTask[]>;
export const TASK_LISTS_KEY = 'kirolex-task-lists-v1';

const STATUS = new Set<TaskStatus>(['pending', 'in_progress', 'completed']);

/** Accept ACP plan entries as untrusted input and keep only the native Task contract. */
export function normalizeTaskList(raw: unknown): PersistedTask[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((value): PersistedTask[] => {
    if (!value || typeof value !== 'object') return [];
    const item = value as Record<string, unknown>;
    const content = typeof item.content === 'string'
      ? item.content.trim()
      : (item.content && typeof item.content === 'object' && typeof (item.content as Record<string, unknown>).text === 'string'
        ? String((item.content as Record<string, unknown>).text).trim()
        : '');
    if (!content) return [];
    const status = STATUS.has(item.status as TaskStatus) ? item.status as TaskStatus : 'pending';
    const priority = item.priority === 'high' || item.priority === 'medium' || item.priority === 'low'
      ? item.priority
      : undefined;
    return [{ content, status, current: item.current === true || status === 'in_progress', ...(priority ? { priority } : null) }];
  });
}

export function parseTaskLists(text: string | null | undefined): TaskLists {
  if (!text) return {};
  try {
    const raw = JSON.parse(text) as Record<string, unknown>;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out: TaskLists = {};
    for (const [sessionId, list] of Object.entries(raw)) {
      const normalized = normalizeTaskList(list);
      if (sessionId && normalized.length) out[sessionId] = normalized;
    }
    return out;
  } catch {
    return {};
  }
}

export function updateTaskLists(current: TaskLists, sessionId: string, raw: unknown): TaskLists {
  if (!sessionId) return current;
  const next = { ...current };
  const normalized = normalizeTaskList(raw);
  if (normalized.length) next[sessionId] = normalized;
  else delete next[sessionId];
  return next;
}

export function serializeTaskLists(lists: TaskLists): string {
  return JSON.stringify(lists);
}
