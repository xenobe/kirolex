import { createPortal } from 'react-dom';
import { uiGet, uiSet, uiRemove } from '../uiStore';
import React, { useRef, useEffect, useLayoutEffect, useState, useCallback, useMemo, memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import hljs from 'highlight.js';
import { isFeatureOn, useFeatureFlags } from '../hooks/useFeatureFlags';
import 'highlight.js/styles/github-dark.css';
import type { Message, AttachedFile, QueuedMessage, ToolCall, PlanEntry, FileDiff } from '../App';
import type { SlashCommand, PermissionRequest } from '../hooks/useAcp';
import { IconAppendMessage, IconCopy, IconEdit, IconFork, IconPaperclip, IconQueue, IconRobot, IconSteer } from './Icons';
import { ConfirmDialog, ConfirmRequest } from './ConfirmDialog';
import { PermissionBar } from './PermissionBar';
import { visit } from 'unist-util-visit';

// U+2318 has no glyph in the Windows/Linux font stack and renders as a tofu box,
// so name the modifier for the actual platform instead of showing both.
const MOD_KEY =
  typeof navigator !== 'undefined' && navigator.platform.toUpperCase().includes('MAC')
    ? '⌘'
    : 'Ctrl';

// Make links/paths in messages clickable: URLs open in the browser, file/dir
// paths open in the OS (via app:open-external). Applied to every markdown render.
// Format a model's context window token count for the selector: 1000000 -> "1M",
// 272000 -> "272k". Keeps one decimal only when it isn't a whole million.
function fmtContextWindow(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return '';
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000;
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
  }
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`;
  return String(tokens);
}
const mdUrlTransform = (url: string) => (/^javascript:/i.test(url) ? '' : url);
// Inline code that looks like a file path (ends in a known extension) becomes a
// clickable link that opens the file — covers kiro's file references (usually in
// `backticks`) and diff paths mentioned in prose.
const FILE_TOKEN_RE = /^(?:[A-Za-z]:\\[^\n\r\t<>|?*]+|~?\/[^\n\r\t<>|?*]+|[^\/\n\r\t<>|?*]+(?:\/[^\/\n\r\t<>|?*]+)+)\.[A-Za-z0-9]{1,8}$/u;
const URL_RE = /^(https?:|mailto:|tel:)/i;
// Open a file path inside KiroLex's own viewer (not the OS default app). App
// listens for this event and shows the in-app file modal. URLs still go external.
function openPathInApp(target: string) {
  window.dispatchEvent(new CustomEvent('kirolex:open-file', { detail: { path: target } }));
}
// Existence cache so a file path is only stat'd once across the whole transcript.
// 'pending' while the async check is in flight; a path that doesn't exist is
// rendered as plain text (no dead link) instead of a clickable reference.
const pathExistsCache = new Map<string, boolean>();
const pathExistsInflight = new Map<string, Promise<boolean>>();
function usePathExists(path: string): 'pending' | 'yes' | 'no' {
  const cached = pathExistsCache.get(path);
  const [state, setState] = useState<'pending' | 'yes' | 'no'>(
    cached === undefined ? 'pending' : cached ? 'yes' : 'no',
  );
  useEffect(() => {
    if (pathExistsCache.has(path)) {
      setState(pathExistsCache.get(path) ? 'yes' : 'no');
      return;
    }
    let live = true;
    let p = pathExistsInflight.get(path);
    if (!p) {
      p = Promise.resolve(window.kiroApi.pathExists?.(path) ?? true).then((ok) => {
        pathExistsCache.set(path, !!ok);
        pathExistsInflight.delete(path);
        return !!ok;
      });
      pathExistsInflight.set(path, p);
    }
    p.then((ok) => { if (live) setState(ok ? 'yes' : 'no'); });
    return () => { live = false; };
  }, [path]);
  return state;
}
// Renders a file/dir path as a clickable in-app reference ONLY when it exists on
// disk; otherwise (or while checking) it renders as plain text so broken links
// never appear. Used for both linkified prose paths (<a>) and inline file tokens.
const FileRef = ({ path, as, className, children }: {
  path: string; as: 'a' | 'code'; className?: string; children: React.ReactNode;
}) => {
  const exists = usePathExists(path);
  if (exists !== 'yes') {
    // Not (yet) known to exist -> plain, non-clickable text.
    return as === 'code'
      ? <code className={className}>{children}</code>
      : <span>{children}</span>;
  }
  if (as === 'code') {
    return (
      <code className="md-file-link" title="在 KiroLex 内打开文件" onClick={() => openPathInApp(path)}>
        {children}
      </code>
    );
  }
  return (
    <a
      href="#"
      className="md-link"
      onClick={(e: React.MouseEvent) => { e.preventDefault(); openPathInApp(path); }}
    >
      {children}
    </a>
  );
};
const MD_COMPONENTS = {
  a: ({ href, children }: any) => {
    // Real URLs always open externally. A linkified file/dir path only becomes a
    // clickable in-app link when it actually exists on disk (else plain text).
    if (href && URL_RE.test(href)) {
      return (
        <a
          href={href}
          className="md-link"
          onClick={(e: React.MouseEvent) => { e.preventDefault(); void window.kiroApi.openExternal?.(href); }}
        >
          {children}
        </a>
      );
    }
    if (!href) return <span>{children}</span>;
    return <FileRef path={href} as="a">{children}</FileRef>;
  },
  // Fenced code blocks had NO copy button -- only user-message blocks and pasted
  // blobs did. A one-line URL in a code fence was therefore unselectable in
  // practice: it overflows horizontally, so dragging to select it scrolls away.
  // react-markdown renders <pre><code>…</code></pre>, so the button belongs on the
  // <pre> wrapper, where it can read the block's exact source from the code child.
  pre: ({ children, ...props }: any) => {
    const codeEl: any = Array.isArray(children) ? children[0] : children;
    const kids = codeEl?.props?.children;
    const text = Array.isArray(kids) ? kids.join('') : String(kids ?? '');
    return <MdCodeBlock text={text} preProps={props}>{children}</MdCodeBlock>;
  },
  code: ({ className, children, ...props }: any) => {
    const raw = Array.isArray(children) ? children.join('') : String(children ?? '');
    const isBlock = !!className || raw.includes('\n');
    const text = raw.trim();
    if (!isBlock && FILE_TOKEN_RE.test(text)) {
      // Only clickable when the file exists on disk (else plain inline code).
      return <FileRef path={text} as="code" className="md-file-link">{children}</FileRef>;
    }
    return <code className={className} {...props}>{children}</code>;
  },
};
/** Inline thumbnail for an image attachment.
 *
 *  Attachments used to render as `📁 Screenshot 1` -- an icon and a name, so a
 *  pasted screenshot gave no idea WHAT was sent. `preview` (a data URL) only exists
 *  for the paste that created it and is deliberately NOT persisted in the
 *  transcript, so after a reload there is nothing to show; the bytes are read back
 *  from disk on demand instead, cached per path so a re-render never re-reads. */
const thumbCache = new Map<string, string>();
const AttachmentThumb: React.FC<{ file: AttachedFile; sessionId: string | null; onOpen?: (path: string) => void }> = ({ file, sessionId, onOpen }) => {
  const [src, setSrc] = useState<string | null>(file.preview || thumbCache.get(file.path) || null);
  useEffect(() => {
    if (src || !file.isImage || !file.path) return;
    let cancelled = false;
    void (async () => {
      try {
        // Session-free read FIRST. This used to call workspaceRead(sessionId, path),
        // which throws "This chat is not connected." whenever the chat has no live
        // kiro-cli -- so a dormant chat (or any chat rendering before its executor
        // attached) showed 🖼️ + the file name instead of the picture, permanently,
        // because nothing retried. Reading bytes off disk needs no backend.
        const direct = await window.kiroApi.readImageDataUrl?.(file.path);
        if (!cancelled && direct?.dataUrl) { thumbCache.set(file.path, direct.dataUrl); setSrc(direct.dataUrl); return; }
        // Fallback for remote sessions, where the file lives on the other host and
        // only the session-scoped reader can fetch it.
        if (!sessionId) return;
        const res = await window.kiroApi.workspaceRead?.(sessionId, file.path);
        if (!cancelled && res?.image && res.dataUrl) { thumbCache.set(file.path, res.dataUrl); setSrc(res.dataUrl); }
      } catch { /* leave the icon fallback in place */ }
    })();
    return () => { cancelled = true; };
  }, [file.path, file.isImage, sessionId, src]);
  if (!file.isImage) return null;
  if (!src) return <span className="message-attachment-icon">🖼️</span>;
  return (
    <img
      className="message-attachment-thumb"
      src={src}
      alt={file.name}
      title={`${file.name} — 点击查看原图`}
      onClick={onOpen ? () => onOpen(file.path) : undefined}
    />
  );
};

/** A fenced code block with a hover Copy button. Copies the block's SOURCE, not
 *  the rendered/highlighted DOM, so a long single-line value comes back intact. */
const MdCodeBlock: React.FC<{ text: string; preProps?: any; children?: React.ReactNode }> = ({ text, preProps, children }) => {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    }).catch(() => {});
  };
  return (
    <div className="md-code-wrap">
      <button type="button" className="md-code-copy" onClick={copy} title="复制这段代码">
        {copied ? '已复制' : '复制'}
      </button>
      <pre {...preProps}>{children}</pre>
    </div>
  );
};

// Linkify absolute file/dir paths in plain text. Tightened to avoid matching prose
// like "/update/delete": require a Windows path, a path under a known root, or a
// path ending in a file extension.
const PATH_RE = /(?:[A-Za-z]:\\[^\s"'`)]+|\/(?:Users|home|tmp|var|etc|opt|usr|private|Applications|mnt|srv|root)\/[^\n\r\t<>|"'`]*?\.[A-Za-z0-9]{1,8}(?=[\s)"'`,，。；;：]|$)|(?:\/[\p{L}\p{N}._\-]+)+\.[A-Za-z0-9]{1,8})/gu;
function remarkLinkifyPaths() {
  return (tree: any) => {
    // Cast: this visitor RETURNS a new index to skip the nodes it just spliced in,
    // which is valid unist-util-visit behaviour but does not fit the strict
    // BuildVisitor<'text'> overload (it types `index` as number, never null). The
    // cast is what removes a long-standing TS2769 here without changing behaviour.
    visit(tree, 'text', ((node: any, index: number | null, parent: any) => {
      if (!parent || index == null || parent.type === 'link') return;
      const value: string = node.value || '';
      PATH_RE.lastIndex = 0;
      if (!PATH_RE.test(value)) return;
      PATH_RE.lastIndex = 0;
      const kids: any[] = [];
      let last = 0;
      let m: RegExpExecArray | null;
      while ((m = PATH_RE.exec(value))) {
        if (m.index > last) kids.push({ type: 'text', value: value.slice(last, m.index) });
        kids.push({ type: 'link', url: m[0], children: [{ type: 'text', value: m[0] }] });
        last = m.index + m[0].length;
      }
      if (last < value.length) kids.push({ type: 'text', value: value.slice(last) });
      parent.children.splice(index, 1, ...kids);
      return index + kids.length;
    }) as any);
  };
}
const MD_REMARK = [remarkGfm, remarkLinkifyPaths];

const PROMPT_SUGGESTIONS = [
  '解释这个项目是做什么的，整体结构是怎样的',
  '找出并修复当前目录里的 bug',
  '为主要模块补充单元测试',
  '总结最近的 git 改动',
  '审查这段代码有没有安全问题',
];

type KiroAgentSource = 'built-in' | 'global' | 'local';

interface KiroAgentOption {
  name: string;
  isDefault: boolean;
  source: KiroAgentSource;
}

interface AgentConfigEditorState {
  agentName: string;
  path: string;
  content: string;
  initialContent: string;
  error?: string;
}

interface JsonValidationIssue {
  message: string;
  line: number;
  column: number;
}

function validateAgentConfigJson(content: string): JsonValidationIssue | null {
  try {
    const parsed = JSON.parse(content);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {
        message: 'Agent configuration must be a JSON object.',
        line: 1,
        column: 1,
      };
    }
    return null;
  } catch (error: any) {
    const message = error?.message || String(error);
    const explicitLocation = message.match(/line\s+(\d+)\s+column\s+(\d+)/i);
    if (explicitLocation) {
      return {
        message,
        line: Number(explicitLocation[1]),
        column: Number(explicitLocation[2]),
      };
    }

    const positionMatch = message.match(/position\s+(\d+)/i);
    const position = positionMatch
      ? Math.min(Number(positionMatch[1]), content.length)
      : content.length;
    const before = content.slice(0, position);
    const line = before.split('\n').length;
    const lastNewline = before.lastIndexOf('\n');
    return {
      message,
      line,
      column: position - lastNewline,
    };
  }
}

// Throttled markdown renderer: only re-renders markdown every N ms during streaming
const ThrottledMarkdown: React.FC<{ content: string; interval?: number }> = ({ content, interval = 150 }) => {
  const [rendered, setRendered] = useState(content);
  const lastUpdateRef = useRef(Date.now());
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const now = Date.now();
    const elapsed = now - lastUpdateRef.current;

    if (elapsed >= interval) {
      setRendered(content);
      lastUpdateRef.current = now;
    } else {
      // Schedule an update for when the interval expires
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        setRendered(content);
        lastUpdateRef.current = Date.now();
      }, interval - elapsed);
    }

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [content, interval]);

  // Final flush: when content stops changing, ensure we show the latest
  useEffect(() => {
    return () => {
      setRendered(content);
    };
  }, []);

  return (
    <ReactMarkdown remarkPlugins={MD_REMARK} rehypePlugins={[rehypeHighlight]} components={MD_COMPONENTS as any} urlTransform={mdUrlTransform}>
      {rendered}
    </ReactMarkdown>
  );
};

/** Static markdown with EXACTLY the chat renderers: external links open in the
 *  system browser via openExternal, and file paths become clickable FileRefs.
 *  Exported so the file/report viewer renders .md instead of dumping raw source
 *  (a plain <pre> showed no formatting and made every URL unclickable). */
export const MarkdownView: React.FC<{ content: string }> = ({ content }) => (
  <ReactMarkdown
    remarkPlugins={MD_REMARK}
    rehypePlugins={[rehypeHighlight]}
    components={MD_COMPONENTS as any}
    urlTransform={mdUrlTransform}
  >
    {content}
  </ReactMarkdown>
);

// ---- Pasted text blobs -------------------------------------------------------
// Folding is decided by PROVENANCE, not by content shape: a paste this size gets
// swapped for a placeholder and stored on disk (same model as a pasted image),
// while anything you TYPE is never folded no matter how it looks.
//
// Thresholds: folding must only trigger on genuinely BULKY pastes. The previous
// values (>=3 lines or >=200 chars) folded a SINGLE-LINE 777-char stack trace into
// a placeholder, which reads as "paste is broken" -- you pasted an error message
// and the composer showed you a marker instead. A single line is one visible,
// wrapping thing; hiding it helps nobody. So the char trigger now REQUIRES more
// than one line, and a lone line only folds when it is large enough to genuinely
// swamp the composer (minified JSON, a base64 blob).
const PASTE_MIN_LINES = 6;
const PASTE_MIN_CHARS = 1200;
/** A single line only folds past this — well beyond any readable error message. */
const PASTE_SINGLE_LINE_MIN_CHARS = 4000;
/** `[ 粘贴 #1 · 42 行 ]` — the only thing that lands in the message text. */
const PASTE_PLACEHOLDER_RE = /\[ 粘贴 #(\d+) · (\d+) 行 \]/g;
function pastePlaceholder(seq: number, lines: number): string {
  return `[ 粘贴 #${seq} · ${lines} 行 ]`;
}
function shouldCapturePaste(text: string): boolean {
  if (!text) return false;
  const lines = text.split('\n').length;
  if (lines >= PASTE_MIN_LINES) return true;
  // One line is one visible thing: only fold it when it would swamp the composer.
  if (lines <= 1) return text.length >= PASTE_SINGLE_LINE_MIN_CHARS;
  return text.length >= PASTE_MIN_CHARS;
}
export type PastedBlock = { seq: number; lines: number; chars: number; path: string; content?: string };
/** Swap placeholders back to the real text — what the MODEL must receive. */
export function expandPastes(text: string, blocks: PastedBlock[]): string {
  if (!blocks.length) return text;
  return text.replace(PASTE_PLACEHOLDER_RE, (m, seqStr) => {
    const b = blocks.find((x) => x.seq === Number(seqStr));
    return b?.content ?? m;
  });
}
/** Which blocks the text still references. A block whose placeholder the user
 *  deleted by hand must not travel with the message: it would record a paste the
 *  bubble never shows and keep that blob alive forever. */
function pastesReferencedBy(text: string, blocks: PastedBlock[]): PastedBlock[] {
  if (!blocks.length) return blocks;
  const seen = new Set<number>();
  PASTE_PLACEHOLDER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PASTE_PLACEHOLDER_RE.exec(text))) seen.add(Number(m[1]));
  return blocks.filter((b) => seen.has(b.seq));
}
/** Fill in `content` for blocks that only have a path (a draft restored after a
 *  restart), so the model still receives the real text and not the placeholder. */
async function hydratePasteContents(blocks: PastedBlock[]): Promise<PastedBlock[]> {
  return Promise.all(blocks.map(async (b) => {
    if (typeof b.content === 'string') return b;
    try {
      const body = await window.kiroApi.readPaste?.(b.path);
      return typeof body === 'string' ? { ...b, content: body } : b;
    } catch { return b; }
  }));
}

// Draft paste blocks PER SESSION, mirrored to disk. One shared ref used to leak
// blocks between chats (the composer is a single instance for all sessions while
// drafts are per-session) and did not survive a restart, so a restored draft kept
// a placeholder that could no longer expand and the raw `[ 粘贴 #N · M 行 ]` string
// was sent to the model.
const draftPastes: Record<string, PastedBlock[]> = {};
let draftPastesLoaded = false;
async function loadDraftPastesOnce() {
  if (draftPastesLoaded) return;
  draftPastesLoaded = true;
  try {
    const map = await window.kiroApi.getDraftPastes?.();
    if (map && typeof map === 'object') {
      for (const [sid, blocks] of Object.entries(map)) {
        if (Array.isArray(blocks)) draftPastes[sid] = blocks as PastedBlock[];
      }
    }
  } catch { /* best-effort */ }
}
function persistDraftPastes(sessionId: string | null, blocks: PastedBlock[]) {
  if (!sessionId) return;
  if (blocks.length) draftPastes[sessionId] = blocks;
  else delete draftPastes[sessionId];
  // `content` is intentionally not persisted: the bytes are already in the file.
  void window.kiroApi.setDraftPastes?.(
    sessionId,
    blocks.map(({ seq, lines, chars, path }) => ({ seq, lines, chars, path })),
  );
}

/** A `[ 粘贴 #N · M 行 ]` placeholder rendered as an expandable block. The body is
 *  read from disk ON DEMAND, so a huge paste costs nothing until you open it. */
const PastedBlockView = memo<{ block: { seq: number; lines: number; chars: number; path: string } }>(({ block }) => {
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    if (!open || body !== null || missing) return;
    let live = true;
    window.kiroApi.readPaste?.(block.path)
      .then((text: string | null) => {
        if (!live) return;
        if (typeof text === 'string') setBody(text);
        else setMissing(true);
      })
      .catch(() => { if (live) setMissing(true); });
    return () => { live = false; };
  }, [open, body, missing, block.path]);
  const copy = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    const text = body ?? (await window.kiroApi.readPaste?.(block.path)) ?? '';
    if (!text) return;
    await navigator.clipboard.writeText(text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }, [body, block.path]);
  return (
    <div className={`user-code-block ${open ? 'open' : ''}`}>
      <div
        className="user-code-head"
        onClick={() => setOpen((o) => !o)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen((o) => !o); } }}
        title={open ? '点击收起' : '点击展开粘贴内容'}
      >
        <span className="user-code-caret">{open ? '▾' : '▸'}</span>
        <span className="user-code-kind">粘贴 #{block.seq}</span>
        <span className="user-code-meta">{block.lines} 行 · {block.chars} 字符</span>
        <button type="button" className="user-code-copy" onClick={copy} title="复制">
          {copied ? '✓ 已复制' : '复制'}
        </button>
      </div>
      {open && (
        <pre className="user-code-body">
          <code>{missing ? '（粘贴内容已不可用：文件已被删除）' : (body ?? '读取中…')}</code>
        </pre>
      )}
    </div>
  );
});

const formatMessageTime = (timestamp: number) => {
  const messageDate = new Date(timestamp);
  const today = new Date();
  const isToday = messageDate.getFullYear() === today.getFullYear()
    && messageDate.getMonth() === today.getMonth()
    && messageDate.getDate() === today.getDate();

  return new Intl.DateTimeFormat(undefined, isToday
    ? { hour: '2-digit', minute: '2-digit' }
    : { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }
  ).format(messageDate);
};

// Kiro CLI does not expose exact per-turn token counts. Estimate the visible
// question + answer, treating CJK characters as roughly one token and the
// remaining text as roughly one token per four characters.
const estimateVisibleTokens = (text: string) => {
  const cjkCount = (text.match(/[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
  const nonCjkLength = text.replace(/[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/g, '').length;
  return Math.max(1, cjkCount + Math.ceil(nonCjkLength / 4));
};

// Memoized message item: only re-renders when its own content/streaming state changes
const MessageItem = memo<{
  segments: Message[];
  questionContent?: string;
  isLastAssistant: boolean;
  isStreaming: boolean;
  onFork: (messageId: string) => void;
  foldThinking: boolean;
  foldTools: boolean;
}>(({ segments, questionContent, isLastAssistant, isStreaming, onFork, foldThinking, foldTools }) => {
  const [copied, setCopied] = useState(false);
  const actionLocked = isLastAssistant && isStreaming;
  // One assistant turn = the consecutive assistant/tool/subagent messages between
  // two user turns, rendered as ONE bubble. Each segment carries a migration
  // marker prefix (🤖 subagent / 🔧 tool) which is stripped for display and shown
  // as a labelled badge, so a tool-using turn reads as one reply with inner
  // segments instead of being split into many separate replies.
  const SUB_PREFIX = '🤖 ';
  const TOOL_PREFIX = '🔧 ';
  const THINK_PREFIX = '💭 ';
  const last = segments[segments.length - 1];
  const parts = useMemo(() => segments.map((seg) => {
    const variant: 'subagent' | 'tool' | 'thinking' | null =
      seg.content.startsWith(SUB_PREFIX) ? 'subagent'
      : seg.content.startsWith(TOOL_PREFIX) ? 'tool'
      : seg.content.startsWith(THINK_PREFIX) ? 'thinking' : null;
    const body = variant === 'subagent' ? seg.content.slice(SUB_PREFIX.length)
      : variant === 'tool' ? seg.content.slice(TOOL_PREFIX.length)
      : variant === 'thinking' ? seg.content.slice(THINK_PREFIX.length)
      : seg.content;
    return { id: seg.id, variant, body };
  }), [segments]);
  // Copy excludes tool + thinking segments — only the actual reply text.
  const combinedText = useMemo(
    () => parts.filter((p) => p.variant !== 'tool' && p.variant !== 'thinking').map((p) => p.body).join('\n\n'),
    [parts],
  );
  // Tool segments are collapsed by default (only a chip shows); the user expands
  // them on demand. The actively-streaming last turn stays expanded so live tool
  // output is visible as it happens.
  const [expandedTools, setExpandedTools] = useState<Set<string>>(new Set());
  const toggleTool = useCallback((segId: string) => {
    setExpandedTools((prev) => {
      const next = new Set(prev);
      if (next.has(segId)) next.delete(segId); else next.add(segId);
      return next;
    });
  }, []);
  const turnFileChanges = useMemo(() => {
    const byId = new Map<string, ToolCall>();
    for (const segment of segments) {
      for (const toolCall of segment.toolCalls || []) byId.set(toolCall.toolCallId, toolCall);
    }
    return Array.from(byId.values());
  }, [segments]);
  const estimatedTokens = !actionLocked
    ? estimateVisibleTokens(`${questionContent || ''}\n${combinedText}`)
    : null;

  const copyMessage = useCallback(async () => {
    await navigator.clipboard.writeText(combinedText);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }, [combinedText]);

  return (
    <div className="message assistant">
      <div className="message-content">
        {parts.map((p, idx) => {
          const streamThis = isStreaming && isLastAssistant && idx === parts.length - 1;
          const isCollapsible = p.variant === 'tool' || p.variant === 'thinking';
          // When the matching auto-fold setting is ON, a thinking/tool segment
          // auto-expands ONLY while it is the actively-streaming segment; the
          // moment a later segment begins — or the turn ends — it folds and stays
          // folded unless the user clicks it. When OFF, the segment stays open for
          // the whole running turn (legacy behavior).
          const running = isStreaming && isLastAssistant;
          const fold = p.variant === 'thinking' ? foldThinking : p.variant === 'tool' ? foldTools : false;
          const autoExpand = isCollapsible ? (fold ? streamThis : running) : running;
          const open = !isCollapsible || autoExpand || expandedTools.has(p.id);
          const firstLine = isCollapsible ? (p.body.split('\n').find((l) => l.trim()) || '').trim() : '';
          const hasMore = isCollapsible && p.body.trim().length > firstLine.length;
          const chipLabel = p.variant === 'thinking' ? '💭 思考' : '🔧 工具';
          return (
            <div key={p.id} className={`turn-segment${p.variant ? ` variant-${p.variant}` : ''}`}>
              {isCollapsible && !autoExpand ? (
                <div className="tool-toggle-row">
                  <button
                    className={`msg-variant-badge ${p.variant} as-toggle`}
                    onClick={() => toggleTool(p.id)}
                    title={open ? '折叠' : '展开'}
                  >
                    {open ? '▾' : '▸'} {chipLabel}
                  </button>
                  {!open && (
                    <span className="tool-collapsed-preview" onClick={() => toggleTool(p.id)} title="展开">
                      {firstLine}{hasMore ? ' …' : ''}
                    </span>
                  )}
                </div>
              ) : p.variant && (
                <span className={`msg-variant-badge ${p.variant}`}>
                  {p.variant === 'subagent' ? '🤖 子代理' : p.variant === 'thinking' ? '💭 思考' : '🔧 工具'}
                </span>
              )}
              {open && (streamThis ? (
                p.body ? (
                  <div className="streaming-content">
                    <ThrottledMarkdown content={p.body} interval={150} />
                  </div>
                ) : null
              ) : (
                <ReactMarkdown remarkPlugins={MD_REMARK} rehypePlugins={[rehypeHighlight]} components={MD_COMPONENTS as any} urlTransform={mdUrlTransform}>
                  {p.body}
                </ReactMarkdown>
              ))}
            </div>
          );
        })}
        {turnFileChanges.length > 0 && (
          <div className="message-turn-panels">
            <FileChangesPanel fileChanges={turnFileChanges} />
            <CommandsPanel fileChanges={turnFileChanges} />
          </div>
        )}
      </div>
      <div className="message-actions">
        <time
          className="message-time"
          dateTime={new Date(last.timestamp).toISOString()}
          title={new Date(last.timestamp).toLocaleString()}
        >
          {formatMessageTime(last.timestamp)}
        </time>
        {estimatedTokens !== null && (
          <span
            className="message-token-count"
            title="Estimated from the visible question and answer; Kiro CLI does not expose exact per-turn token counts."
          >
            · ≈ {estimatedTokens.toLocaleString()} tokens
          </span>
        )}
        <button
          className="message-action-btn"
          onClick={() => void copyMessage()}
          title={copied ? 'Copied!' : 'Copy'}
          aria-label={copied ? 'Copied!' : 'Copy message'}
        >
          {copied ? '✓' : <IconCopy size={14} />}
        </button>
        <button
          className="message-action-btn"
          onClick={() => onFork(last.id)}
          disabled={actionLocked}
          title="Fork conversation from here"
          aria-label="Fork conversation from here"
        >
          <IconFork size={14} />
        </button>
      </div>
    </div>
  );
});

// A pasted blob inside a user message (code / log / JSON / tabular data) is
// collapsed by default so it doesn't flood the bubble. The classification below is
// deliberately EVIDENCE-BASED: earlier versions treated any markdown bullet, any
// bracket, any URL or any trailing comma as a "code signal", so a 10-line bulleted
// INSTRUCTION got folded away and labelled 代码; and a single occurrence of the
// word ERROR anywhere labelled the whole thing 日志. Rule now: if we cannot
// confidently name what the block is, we neither fold it nor label it.

/** A real log line: leading timestamp, leading level token, or a stack frame. */
function isLogLine(ln: string): boolean {
  return /^\s*[[(]?\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(ln)          // 2026-08-04T11:00
    || /^\s*[[(]?\d{2}:\d{2}:\d{2}([.,]\d+)?\b/.test(ln)               // 11:00:03.120
    || /^\s*[[(]?(ERROR|WARN|WARNING|INFO|DEBUG|TRACE|FATAL|CRITICAL)\b/i.test(ln)
    || /^\s*at\s+[\w$.<>]+\s*\(/.test(ln)                              // java/js stack frame
    || /^\s*File\s+".+",\s+line\s+\d+/.test(ln)                        // python traceback frame
    || /^\s*(npm|yarn|pnpm)?\s*(ERR!|WARN)\b/.test(ln);
}

/** A real code line: statement/declaration shapes, not merely "contains a paren".
 *  Markdown bullets are intentionally NOT a signal — that is prose formatting. */
function isCodeLine(ln: string): boolean {
  const t = ln.trim();
  if (!t) return false;
  return /[;{}]$/.test(t)                                              // ends a statement/block
    || /^(import|export|from|const|let|var|function|async|def|class|struct|enum|interface|type|public|private|protected|return|if|else|elif|for|while|switch|case|try|catch|finally|throw|package|using|#include|#define|@\w+)\b/.test(t)
    || /=>|::|->|\|\||&&|!==|===|\+=|-=/.test(t)
    || /^[\w"'\-.[\]]+\s*[:=]\s*\S+,?$/.test(t)                        // key: value / key = value
    || /^<\/?[a-zA-Z][\w:-]*(\s|>|\/>)/.test(t)                        // markup tag
    || /^\$\s|^>\s*\w+@|^\w+@[\w.-]+:.*[$#]\s/.test(t);                // shell prompt lines
}

/** Consistent delimiter count per line = tabular paste (CSV/TSV). */
function looksTabular(lines: string[]): boolean {
  if (lines.length < 4) return false;
  const counts = lines.map((l) => (l.match(/[,\t|]/g) || []).length);
  const first = counts[0];
  if (first < 2) return false;
  const consistent = counts.filter((c) => c === first).length;
  return consistent / counts.length >= 0.8;
}

/** What this block IS, or null when we genuinely cannot tell. */
function classifyBlock(text: string): 'JSON' | '日志' | '代码' | '表格数据' | null {
  const t = text.trim();
  if (!t) return null;
  if (/^[[{][\s\S]*[\]}]$/.test(t)) {
    try { JSON.parse(t); return 'JSON'; } catch { /* not valid JSON, keep checking */ }
  }
  const lines = t.split('\n').filter((l) => l.trim());
  if (!lines.length) return null;
  const logRatio = lines.filter(isLogLine).length / lines.length;
  const codeRatio = lines.filter(isCodeLine).length / lines.length;
  if (/Traceback \(most recent call last\)/.test(t) || logRatio >= 0.4) return '日志';
  if (codeRatio >= 0.4) return '代码';
  if (looksTabular(lines)) return '表格数据';
  return null;
}

function looksLikeCodeOrData(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  // Explicit fenced code is self-declared — always foldable.
  if (/```/.test(t)) return true;
  // Whole-blob JSON is foldable regardless of line count: minified JSON is ONE
  // long line, so the length/line thresholds below would let it flood the bubble.
  if (t.length > 80 && classifyBlock(t) === 'JSON') return true;
  const lines = t.split('\n');
  const longEnough = lines.length >= 10 || t.length >= 600;
  if (!longEnough) return false;
  // Only fold what we can actually name. Prose (including bulleted instructions
  // and CJK text) classifies as null and therefore stays fully visible.
  return classifyBlock(t) !== null;
}

function blockKind(text: string): string {
  // Fenced content we didn't classify is still just "pasted content" — do not
  // assert 代码/日志 without evidence.
  return classifyBlock(text) ?? '粘贴内容';
}

// Split a qualifying paragraph into a leading prose head (kept visible) and the
// trailing code/log/JSON block (collapsed). This keeps the user's actual
// question/intro lines readable while folding the pasted blob. If the blob
// starts at line 0, head is '' and the whole paragraph is the block.
function splitProseAndBlock(text: string): { head: string; block: string } {
  const lines = text.split('\n');
  // Same evidence-based test as the classifier: a bullet, a bracket or a URL in a
  // sentence must NOT start a "code block" and swallow the rest of the message.
  const isCodey = (ln: string) => isCodeLine(ln) || isLogLine(ln);
  for (let i = 0; i < lines.length; i++) {
    if (!isCodey(lines[i])) continue;
    const rest = lines.slice(i);
    const codey = rest.filter(isCodey).length;
    if ((rest.length >= 6 || rest.join('\n').length >= 300) && codey / rest.length >= 0.5) {
      return { head: lines.slice(0, i).join('\n').trim(), block: rest.join('\n') };
    }
  }
  return { head: '', block: text };
}

// Collapsed-by-default block for long pasted content in a user message. Shows a
// one-line chip (kind + line/char count + Copy); click the chip to expand the
// raw content in a scrollable <pre>. Copy works whether collapsed or expanded.
const CollapsibleUserBlock = memo<{ content: string }>(({ content }) => {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const body = content.replace(/\n$/, '');
  const lineCount = body.split('\n').length;
  const kind = blockKind(body);
  // Highlight ONLY when we know what this is, and only when expanded. Blind
  // highlightAuto() used to run on logs and plain pasted text too, where it guesses
  // some random grammar and colours the output wrongly — worse than no colour.
  const highlighted = useMemo(() => {
    if (!open) return null;
    if (kind === 'JSON') {
      try { return hljs.highlight(body, { language: 'json', ignoreIllegals: true }).value; } catch { return null; }
    }
    if (kind !== '代码') return null; // 日志 / 表格数据 / 粘贴内容 stay plain
    try {
      return hljs.highlightAuto(body).value;
    } catch {
      return null;
    }
  }, [open, body, kind]);
  const copy = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation();
      await navigator.clipboard.writeText(body);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    },
    [body],
  );
  return (
    <div className={`user-code-block ${open ? 'open' : ''}`}>
      <div
        className="user-code-head"
        onClick={() => setOpen((o) => !o)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setOpen((o) => !o);
          }
        }}
        title={open ? '点击收起' : '点击展开'}
      >
        <span className="user-code-caret">{open ? '▾' : '▸'}</span>
        <span className="user-code-kind">{kind}</span>
        <span className="user-code-meta">{lineCount} 行 · {body.length} 字符</span>
        <button type="button" className="user-code-copy" onClick={copy} title="复制">
          {copied ? '✓ 已复制' : '复制'}
        </button>
      </div>
      {open && (
        <pre className="user-code-body">
          {highlighted !== null
            ? <code className="hljs" dangerouslySetInnerHTML={{ __html: highlighted }} />
            : <code>{body}</code>}
        </pre>
      )}
    </div>
  );
});
CollapsibleUserBlock.displayName = 'CollapsibleUserBlock';

// Renders a turn's original user message and every mid-turn steer as one
// continuous paragraph in one bubble. The underlying steer messages and ids
// remain separate for pending/rollback/consume/queue-fallback bookkeeping, but
// the UI exposes one timestamp, one Copy action, and one Fork action for the
// whole turn. Fork still targets the last steer id so its history is complete.
const UserGroupItem = memo<{
  base: Message;
  steers: Message[];
  isStreaming: boolean;
  onRerun: (messageId: string, editedText: string) => void;
  /** The turn was interrupted and awaits an overwrite from the composer -- per
   *  message Rerun is intentionally blocked in that state. */
  interrupted?: boolean;
  isLooping: boolean;
  onLoopSetup: (text: string) => void;
  /** Needed to read an image attachment back from disk for its thumbnail. */
  attachmentSessionId?: string | null;
  onOpenAttachment?: (path: string) => void;
}>(({ base, steers, isStreaming, onRerun, isLooping, onLoopSetup, interrupted, attachmentSessionId, onOpenAttachment }) => {
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  // Each entry keeps an isSteer flag so a mid-turn steer paragraph can carry a
  // small left marker in the bubble, while the original question does not. The
  // group shows a single timestamp + Copy/Edit (Fork lives on the reply).
  const paragraphs = useMemo(() => {
    const out: { text: string; isSteer: boolean }[] = [];
    const b = base.content.trim();
    if (b) out.push({ text: b, isSteer: false });
    for (const steer of steers) {
      const t = steer.content.trim();
      if (t) out.push({ text: t, isSteer: true });
    }
    return out;
  }, [base.content, steers]);
  const combinedText = useMemo(() => paragraphs.map((p) => p.text).join('\n\n'), [paragraphs]);
  // Editor draft joins paragraphs with a single newline so previously-steered
  // turns don't show the display-only blank-line spacing inside the textarea.
  const draftText = useMemo(() => paragraphs.map((p) => p.text).join('\n'), [paragraphs]);
  const attachments = useMemo(
    () => [
      ...(base.attachments || []),
      ...steers.flatMap((steer) => steer.attachments || []),
    ],
    [base.attachments, steers],
  );

  const copyMessage = useCallback(async () => {
    await navigator.clipboard.writeText(combinedText);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }, [combinedText]);

  const beginEdit = useCallback(() => {
    setDraft(draftText);
    setEditing(true);
  }, [draftText]);

  const submitRerun = useCallback(() => {
    const text = draft.trim();
    if (!text) return;
    setEditing(false);
    onRerun(base.id, text);
  }, [base.id, draft, onRerun]);

  // When edit mode opens, scroll the Rerun/Cancel actions into view so the
  // button is never left hidden below the fold in a long conversation.
  const editActionsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!editing) return;
    requestAnimationFrame(() => {
      editActionsRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
  }, [editing]);

  return (
    <div className="message user">
      {/* Attachments belong ABOVE the text: they are the context the message
          refers to, so the reader sees the files/images first. */}
      {attachments.length > 0 && (
        <div className="message-attachments">
          {attachments.map((file) => (
            <div
              key={file.id}
              className={`message-attachment-item${file.isImage ? ' image' : ''}`}
              title={file.path}
            >
              {file.isImage ? (
                <AttachmentThumb file={file} sessionId={attachmentSessionId ?? null} onOpen={onOpenAttachment} />
              ) : (
                <span className="message-attachment-icon">
                  {file.path.endsWith('/') || file.path.endsWith('\\') || !file.name.includes('.') ? '📁' : '📄'}
                </span>
              )}
              <span className="message-attachment-name">{file.name}</span>
            </div>
          ))}
        </div>
      )}
      <div className={`message-content ${editing ? 'editing' : ''}`}>
        {editing ? (
          <textarea
            className="message-edit-textarea"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') { event.preventDefault(); setEditing(false); return; }
              // Enter submits (Rerun); Shift+Enter inserts a newline. Guard IME
              // composition so committing a Chinese candidate with Enter doesn't
              // fire a rerun.
              if (event.key === 'Enter' && !event.shiftKey && !(event.nativeEvent as any).isComposing) {
                event.preventDefault();
                submitRerun();
              }
            }}
            autoFocus
            rows={Math.max(3, Math.min(12, draft.split('\n').length + 1))}
          />
        ) : paragraphs.map((paragraph, index) => {
          const key = `${base.id}:paragraph:${index}`;
          // A `[ 粘贴 #N · M 行 ]` placeholder is authoritative: this text WAS pasted,
          // so it folds by provenance and needs no content guessing at all.
          const pasteBlocks = base.pastes || [];
          if (pasteBlocks.length && PASTE_PLACEHOLDER_RE.test(paragraph.text)) {
            PASTE_PLACEHOLDER_RE.lastIndex = 0;
            const parts: React.ReactNode[] = [];
            let last = 0;
            let m: RegExpExecArray | null;
            while ((m = PASTE_PLACEHOLDER_RE.exec(paragraph.text))) {
              const lead = paragraph.text.slice(last, m.index);
              if (lead.trim()) parts.push(<p key={`${key}:t${last}`}>{lead}</p>);
              const seq = Number(m[1]);
              const blk = pasteBlocks.find((b) => b.seq === seq)
                || { seq, lines: Number(m[2]) || 0, chars: 0, path: '' };
              parts.push(<PastedBlockView key={`${key}:p${seq}`} block={blk} />);
              last = m.index + m[0].length;
            }
            const tail = paragraph.text.slice(last);
            if (tail.trim()) parts.push(<p key={`${key}:tail`}>{tail}</p>);
            return <React.Fragment key={key}>{parts}</React.Fragment>;
          }
          // Long pasted code/log/JSON collapses into a click-to-expand block;
          // any leading prose (the user's question/intro) stays visible, and
          // short text (incl. all steer prose) keeps its existing rendering.
          if (looksLikeCodeOrData(paragraph.text)) {
            const { head, block } = splitProseAndBlock(paragraph.text);
            const label = paragraph.isSteer ? (
              <span className="steer-side-label" title="Steered into the running turn">Steer</span>
            ) : null;
            if (head) {
              return (
                <React.Fragment key={key}>
                  <p className={paragraph.isSteer ? 'steer-paragraph' : undefined}>
                    {label}
                    {head}
                  </p>
                  <CollapsibleUserBlock content={block} />
                </React.Fragment>
              );
            }
            return paragraph.isSteer ? (
              <div key={key} className="steer-paragraph steer-block-wrap">
                {label}
                <CollapsibleUserBlock content={block} />
              </div>
            ) : (
              <CollapsibleUserBlock key={key} content={block} />
            );
          }
          return paragraph.isSteer ? (
            <p key={key} className="steer-paragraph">
              <span className="steer-side-label" title="Steered into the running turn">Steer</span>
              {paragraph.text}
            </p>
          ) : (
            <p key={key}>{paragraph.text}</p>
          );
        })}
      </div>
      {editing && (
        <div className="message-edit-actions" ref={editActionsRef}>
          <button type="button" className="message-edit-btn cancel" onClick={() => setEditing(false)}>取消</button>
          <button type="button" className="message-edit-btn rerun" onClick={submitRerun} disabled={isLooping || !draft.trim()}>Rerun</button>
        </div>
      )}
      <div className="message-actions">
        <time
          className="message-time"
          dateTime={new Date(base.timestamp).toISOString()}
          title={new Date(base.timestamp).toLocaleString()}
        >
          {formatMessageTime(base.timestamp)}
        </time>
        <button
          className="message-action-btn"
          onClick={() => void copyMessage()}
          title={copied ? 'Copied!' : 'Copy'}
          aria-label={copied ? 'Copied!' : 'Copy message'}
        >
          {copied ? '✓' : <IconCopy size={14} />}
        </button>
        <button
          className="message-action-btn loop-message-action"
          onClick={() => onLoopSetup(combinedText)}
          disabled={isLooping || isStreaming || !combinedText.trim()}
          title="循环重发此消息"
          aria-label="循环重发此消息"
        >
          🔁
        </button>
        <button
          className="message-action-btn"
          onClick={beginEdit}
          disabled={isLooping || interrupted}
          title={isLooping
            ? '循环运行中，请先停止循环'
            : interrupted
            ? '这一轮已被中断 — 请在下方输入框重新提交，新消息会覆盖被中断的这一轮'
            : '编辑并重跑'}
          aria-label="编辑并重跑"
        >
          <IconEdit size={14} />
        </button>
      </div>
    </div>
  );
});

// Isolated input component: does NOT receive `messages` prop, so it never re-renders due to streaming chunks. This is the primary fix for input lag.
/** Queued follow-ups panel. Rendered as its own in-flow row between the message
 *  list and the composer (NOT an absolute overlay) so it never covers the chat
 *  or the input box -- the message list shrinks to give the queue its own space. */
const QueueStack = memo<{
  queuedMessages: QueuedMessage[];
  onCancelQueuedMessage: (queueId: string) => void;
  onEditQueuedMessage: (queueId: string, content: string) => void;
  onMoveQueuedMessage: (queueId: string, direction: -1 | 1) => void;
  /** Whether the whole queue will be sent as ONE merged turn (Settings toggle). */
  mergeQueued: boolean;
}>(({ queuedMessages, onCancelQueuedMessage, onEditQueuedMessage, onMoveQueuedMessage, mergeQueued }) => {
  const [editingQueueId, setEditingQueueId] = useState<string | null>(null);
  const [editingQueueText, setEditingQueueText] = useState('');
  if (queuedMessages.length === 0) return null;
  return (
    <div className="queue-row">
      <div className="queue-stack">
        <div className="queue-stack-header">
          <span>Queued follow-ups</span>
          {/* The merge setting CHANGES the meaning of this queue (one turn vs N
              turns), so it has to be visible right here — not only in Settings. */}
          <span
            className={`queue-mode-badge ${mergeQueued ? 'merge' : ''}`}
            title={mergeQueued
              ? '合并模式：整个队列会作为 1 条消息一次性发出（每批最多 10 条）'
              : '逐条模式：每次只发队首 1 条，其余继续排队'}
          >
            {mergeQueued
              ? (queuedMessages.length > 1 ? `合并为 1 条发送` : '合并模式')
              : '逐条发送'}
          </span>
          <span>{queuedMessages.length}</span>
        </div>
        {queuedMessages.map((item, index) => (
          <div key={item.id} className="queue-card">
            <span className="queue-card-order">{index + 1}</span>
            <div className="queue-card-body">
              {editingQueueId === item.id ? (
                <input
                  className="queue-card-edit-input"
                  value={editingQueueText}
                  autoFocus
                  onChange={(event) => setEditingQueueText(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && editingQueueText.trim()) {
                      onEditQueuedMessage(item.id, editingQueueText);
                      setEditingQueueId(null);
                    } else if (event.key === 'Escape') {
                      setEditingQueueId(null);
                    }
                  }}
                />
              ) : (
                <span className="queue-card-text" title={item.content}>{item.content}</span>
              )}
              {item.attachments.length > 0 && (
                <span className="queue-card-attachments">📎 {item.attachments.length}</span>
              )}
            </div>
            <div className="queue-card-actions">
              {editingQueueId === item.id ? (
                <>
                  <button
                    onClick={() => {
                      if (editingQueueText.trim()) onEditQueuedMessage(item.id, editingQueueText);
                      setEditingQueueId(null);
                    }}
                    title="Save edit"
                  >✓</button>
                  <button onClick={() => setEditingQueueId(null)} title="Cancel edit">↩</button>
                </>
              ) : (
                <>
                  <button
                    onClick={() => onMoveQueuedMessage(item.id, -1)}
                    disabled={index === 0}
                    title="Move earlier"
                  >↑</button>
                  <button
                    onClick={() => onMoveQueuedMessage(item.id, 1)}
                    disabled={index === queuedMessages.length - 1}
                    title="Move later"
                  >↓</button>
                  <button
                    onClick={() => {
                      setEditingQueueId(item.id);
                      setEditingQueueText(item.content);
                    }}
                    title="Edit queued message"
                  >✎</button>
                  <button
                    onClick={() => onCancelQueuedMessage(item.id)}
                    title="Cancel and return to composer"
                  >✕</button>
                </>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
});

/* Per-session composer drafts. A half-written prompt belongs to ITS chat -- it
   must not follow the user into another session. Kept in a module-level map
   (survives Composer remounts) and mirrored to localStorage so drafts also
   survive an app restart. */
const COMPOSER_DRAFTS_KEY = 'kirolex-composer-drafts';
const composerDrafts: Record<string, string> = (() => {
  try {
    // Shared store, NOT localStorage: localStorage is origin-scoped and this app has
    // two renderer origins (file:// normally, http://localhost:5173 in dev), so an
    // UNSENT draft was silently lost on every switch between `npm start` and
    // `npm run dev:hot`. This one holds text the user typed, so losing it is worse
    // than losing a panel width. The key already sat in ui-state.json as a migration
    // leftover that nothing read.
    const raw = uiGet(COMPOSER_DRAFTS_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch { return {}; }
})();
function persistComposerDrafts() {
  try { uiSet(COMPOSER_DRAFTS_KEY, JSON.stringify(composerDrafts)); } catch {}
}
function stashComposerDraft(sessionId: string | null, text: string) {
  if (!sessionId) return;
  if (text.trim()) composerDrafts[sessionId] = text;
  else delete composerDrafts[sessionId];
  persistComposerDrafts();
}

const ChatInputBox = memo<{
  sessionId: string | null;
  isStreaming: boolean;
  isLooping: boolean;
  status: 'disconnected' | 'connecting' | 'connected';
  sessionConnected: boolean;
  busyReason?: string | null;
  permissionMode: 'auto-approve' | 'ask';
  onPermissionModeChange: (mode: 'auto-approve' | 'ask') => void;
  onSend: (text: string, pastes?: PastedBlock[]) => void;
  onSteer: (text: string, pastes?: PastedBlock[]) => void;
  onCancel: () => void;
  onStopLoop: () => void;
  onQueueCommand: (text: string, pastes?: PastedBlock[]) => void;
  queuedMessages: QueuedMessage[];
  restoredDraft: { id: number; text: string; sessionId?: string } | null;
  restoredInputDraft: { id: number; text: string; sessionId?: string } | null;
  onCancelQueuedMessage: (queueId: string) => void;
  onEditQueuedMessage: (queueId: string, content: string) => void;
  onMoveQueuedMessage: (queueId: string, direction: -1 | 1) => void;
  commands: SlashCommand[];
  showSuggestions: boolean;
  suggestions: string[];
  onDropFiles: (files: AttachedFile[]) => void;
  onRemoveFile: (id: string) => void;
  attachedFiles: AttachedFile[];
}>(({ sessionId, isStreaming, isLooping, status, sessionConnected, permissionMode, onPermissionModeChange, onSend, onSteer, onCancel, onStopLoop, onQueueCommand, queuedMessages, restoredDraft, restoredInputDraft, onCancelQueuedMessage, onEditQueuedMessage, onMoveQueuedMessage, commands, showSuggestions, suggestions, onDropFiles, onRemoveFile, attachedFiles }) => {
  const [input, setInput] = useState(() => (sessionId ? composerDrafts[sessionId] || '' : ''));
  // Live switches; a Settings toggle re-renders this composer immediately.
  const featureFlags = useFeatureFlags();
  const [selectedSuggestions, setSelectedSuggestions] = useState<Set<string>>(new Set());
  const [isComposing, setIsComposing] = useState(false);
  const [editingQueueId, setEditingQueueId] = useState<string | null>(null);
  const [editingQueueText, setEditingQueueText] = useState('');
  const [cmdIndex, setCmdIndex] = useState(0);
  const [cmdEscaped, setCmdEscaped] = useState(false);
  const [queueModifierHeld, setQueueModifierHeld] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Paste blocks are keyed BY SESSION in `draftPastes` (disk-backed), not held
  // in a single ref shared by every chat.
  useEffect(() => { void loadDraftPastesOnce(); }, []);

  // --- Per-session draft: switching chats stashes the outgoing draft and loads
  // the incoming one, so each conversation keeps its own half-written prompt.
  const draftSessionRef = useRef<string | null>(sessionId);
  const inputRef = useRef(input);
  useEffect(() => { inputRef.current = input; }, [input]);
  // Layout effect so the swap (and its setInput) settles before the passive
  // persist effect below runs -- otherwise it would write the OLD text under the
  // NEW session id.
  useLayoutEffect(() => {
    const previous = draftSessionRef.current;
    if (previous === sessionId) return;
    stashComposerDraft(previous, inputRef.current);
    draftSessionRef.current = sessionId;
    const restored = sessionId ? composerDrafts[sessionId] || '' : '';
    inputRef.current = restored;
    setInput(restored);
  }, [sessionId]);
  useEffect(() => {
    if (draftSessionRef.current !== sessionId) return;
    const timer = setTimeout(() => stashComposerDraft(sessionId, input), 300);
    return () => clearTimeout(timer);
  }, [input, sessionId]);
  // Flush the draft on unmount/reload (e.g. window close) so nothing is lost.
  useEffect(() => () => stashComposerDraft(draftSessionRef.current, inputRef.current), []);

  const slashMatch = /^\/(\S*)$/.exec(input);
  const cmdMatches = (!cmdEscaped && status === 'connected' && slashMatch)
    ? commands.filter((command) => command.name.toLowerCase().startsWith(`/${slashMatch[1].toLowerCase()}`))
    : [];
  const acceptCommand = useCallback((command: SlashCommand) => {
    setInput(`${command.name} `);
    setCmdEscaped(false);
    setCmdIndex(0);
    textareaRef.current?.focus();
  }, []);

  const toggleSuggestion = useCallback((suggestion: string) => {
    setSelectedSuggestions((current) => {
      const next = new Set(current);
      if (next.has(suggestion)) next.delete(suggestion);
      else next.add(suggestion);
      setInput(suggestions.filter((prompt) => next.has(prompt)).join('\n'));
      return next;
    });
    textareaRef.current?.focus();
  }, [suggestions]);

  useEffect(() => {
    if (!restoredDraft) return;
    // Same ownership guard as restoredInputDraft: a cancelled queue item belongs
    // to ONE chat. Without this every visible composer swallowed it, so the text
    // appeared in other split panes too (verified live).
    if (restoredDraft.sessionId && restoredDraft.sessionId !== sessionId) return;
    setInput(restoredDraft.text);
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [restoredDraft, sessionId]);

  // Cancel-restore: the interrupted turn's prompt (incl. same-turn steers) is
  // pushed back here so the user can edit and resubmit (which overwrites it).
  useEffect(() => {
    if (!restoredInputDraft) return;
    // A restored prompt belongs to ONE chat. Without this guard every visible
    // composer picked it up, so text from chat A appeared in chat B.
    if (restoredInputDraft.sessionId && restoredInputDraft.sessionId !== sessionId) return;
    setInput(restoredInputDraft.text);
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [restoredInputDraft]);

  // Attachments alone are a valid message: images/files carry the intent, so an
  // empty text box must NOT block sending when something is attached.
  const canSend = input.trim() !== '' || attachedFiles.length > 0;

  const handleSend = useCallback(() => {
    const text = input.trim();
    if (!text && attachedFiles.length === 0) return;
    setInput('');
    setSelectedSuggestions(new Set());
    if (text === '/stop') {
      onSend(text);
      return;
    }
    const own = sessionId ? (draftPastes[sessionId] || []) : [];
    // Only blocks the text still references travel with the message; hydrate their
    // content so a draft restored after a restart still expands for the model.
    const referenced = pastesReferencedBy(text, own);
    persistDraftPastes(sessionId, []);
    if (!referenced.length) {
      if (isStreaming) onSteer(text); else onSend(text);
      return;
    }
    void hydratePasteContents(referenced).then((pastes) => {
      if (isStreaming) onSteer(text, pastes);
      else onSend(text, pastes);
    });
  }, [input, isStreaming, onSend, onSteer, attachedFiles, sessionId]);

  const handleQueue = useCallback(() => {
    const text = input.trim();
    if (!text && attachedFiles.length === 0) return;
    setInput('');
    setSelectedSuggestions(new Set());
    // The queue card keeps the PLACEHOLDER text (a queued 500-line paste used to
    // render as a wall of text); the blocks ride along so the drain can expand it.
    const own = sessionId ? (draftPastes[sessionId] || []) : [];
    const referenced = pastesReferencedBy(text, own);
    persistDraftPastes(sessionId, []);
    if (!referenced.length) { onQueueCommand(text); return; }
    void hydratePasteContents(referenced).then((pastes) => onQueueCommand(text, pastes));
  }, [input, onQueueCommand, attachedFiles, sessionId]);

  useEffect(() => {
    const updateModifier = (event: KeyboardEvent) => {
      setQueueModifierHeld(event.metaKey || event.ctrlKey);
    };
    const clearModifier = () => setQueueModifierHeld(false);
    window.addEventListener('keydown', updateModifier);
    window.addEventListener('keyup', updateModifier);
    window.addEventListener('blur', clearModifier);
    return () => {
      window.removeEventListener('keydown', updateModifier);
      window.removeEventListener('keyup', updateModifier);
      window.removeEventListener('blur', clearModifier);
    };
  }, []);

  const handleActionClick = useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    if (event.metaKey || event.ctrlKey || queueModifierHeld) {
      handleQueue();
    } else {
      handleSend();
    }
  }, [queueModifierHeld, handleQueue, handleSend]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (isComposing || e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      handleQueue();
      return;
    }
    if (cmdMatches.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setCmdIndex((index) => (index + 1) % cmdMatches.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setCmdIndex((index) => (index - 1 + cmdMatches.length) % cmdMatches.length); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); acceptCommand(cmdMatches[Math.min(cmdIndex, cmdMatches.length - 1)]); return; }
      if (e.key === 'Escape') { e.preventDefault(); setCmdEscaped(true); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }, [isComposing, cmdMatches, cmdIndex, acceptCommand, handleQueue, handleSend]);

  const handlePaste = useCallback(async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = Array.from(e.clipboardData?.items || []);
    const hasImage = items.some((i) => i.kind === 'file' && i.type.startsWith('image/'));
    const plain = e.clipboardData?.getData('text/plain') || '';

    // REAL FILES FIRST. Only the screenshot case was ever implemented here, so
    // copying a PDF/xlsx in Finder and pasting did NOTHING AT ALL: its MIME is not
    // image/*, so it fell through to the text branch, where `text/plain` is empty
    // for a file copy -- silent no-op, no attachment, no message.
    //
    // A copied file carries its on-disk path, exactly like a dragged one, and
    // KiroLex attaches BY PATH. An in-memory screenshot also shows up in
    // `clipboardData.files`, but with an empty path -- which is precisely how the
    // two are told apart here. Having a path is also better for an image FILE:
    // saveClipboardImage() re-encodes the bitmap into a new PNG and loses the
    // original name, while this references the file itself.
    //
    // NOTE: `File.path` is an Electron extension (present in Electron 31, which
    // this app uses). Electron 32+ removed it in favour of
    // `webUtils.getPathForFile()`. handleDrop above relies on the same property,
    // so both must be migrated together on an upgrade.
    const clipFiles = Array.from(e.clipboardData?.files || []) as any[];
    const withPaths = clipFiles.filter((f) => f && typeof f.path === 'string' && f.path);
    if (withPaths.length) {
      e.preventDefault();
      // Images are capped first: an oversized one poisons the whole conversation,
      // because Bedrock validates EVERY image in the replayed history and rejects
      // the request once any exceeds 2000px. Capping at attach time is the only
      // point where it can still be prevented.
      void (async () => {
        const attached = [] as any[];
        for (const f of withPaths) {
          const isImage = /^image\//.test(String(f.type || ''));
          let p = f.path as string;
          if (isImage) {
            try { p = (await window.kiroApi.prepareImageAttachment?.(p))?.path || p; } catch {}
          }
          attached.push({
            id: `file_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            name: f.name,
            path: p,
            isImage,
          });
        }
        onDropFiles(attached);
      })();
      return;
    }
    // An image flavour does NOT mean there is no text: copying from Excel, Preview
    // or a browser puts both on the clipboard. Only take the image path when the
    // clipboard is image-ONLY, otherwise a failed image save silently ate the text.
    if (hasImage && !plain) {
      e.preventDefault();
      try {
        const res = await window.kiroApi.saveClipboardImage();
        if (!res) return;
        const n = attachedFiles.filter((f) => f.isImage).length + 1;
        onDropFiles([
          { id: `img_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, name: `Screenshot ${n}`, path: res.path, isImage: true, preview: res.thumbnail },
        ]);
      } catch {}
      return;
    }
    // LARGE TEXT PASTE -> disk, exactly like a pasted image. Folding is decided by
    // PROVENANCE (you pasted this), never by guessing whether the text "looks like"
    // code or a log — which is what used to fold typed instructions by mistake.
    const text = plain;
    // Feature switch read at the CALL SITE: turning folding off applies to the
    // very next paste, with no restart.
    if (!text || !isFeatureOn('pasteFolding') || !shouldCapturePaste(text)) return;   // stays inline
    e.preventDefault();
    // Capture the element AND the caret BEFORE any await: React nulls
    // `currentTarget` once the synthetic event handler yields, so reading it after
    // `await savePasteText` threw — the blob was written to disk but the composer
    // never got its placeholder, so the paste silently vanished from the input.
    const el = (e.currentTarget || textareaRef.current) as HTMLTextAreaElement | null;
    const selStart = el?.selectionStart ?? input.length;
    const selEnd = el?.selectionEnd ?? selStart;
    /** preventDefault() already ran, so the browser will NOT insert anything: every
     *  path out of here must put SOMETHING in the composer or the paste is silently
     *  lost. Falls back to the raw text, unfolded. */
    const insert = (piece: string) => {
      const next = input.slice(0, selStart) + piece + input.slice(selEnd);
      setInput(next);
      requestAnimationFrame(() => {
        const node = textareaRef.current;
        try { node?.setSelectionRange(selStart + piece.length, selStart + piece.length); } catch {}
      });
    };
    try {
      const saved = await window.kiroApi.savePasteText?.(text);
      if (!saved) { insert(text); return; }   // disk failed -> paste inline, never drop it
      const own = sessionId ? (draftPastes[sessionId] || []) : [];
      const seq = own.reduce((max, b) => Math.max(max, b.seq), 0) + 1;
      persistDraftPastes(sessionId, [...own, { seq, lines: saved.lines, chars: saved.chars, path: saved.path, content: text }]);
      insert(pastePlaceholder(seq, saved.lines));
    } catch {
      insert(text);
    }
  }, [attachedFiles, onDropFiles, input, sessionId]);

  const handleFilePick = useCallback(async () => {
    try {
      const files = await window.kiroApi.pickFiles();
      if (files.length > 0) {
        onDropFiles(files.map((file) => ({
          id: `file_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          name: file.name,
          path: file.path,
          isImage: file.isImage,
        })));
      }
    } catch {}
  }, [onDropFiles]);

  return (
    <>
      {featureFlags.promptSuggestions !== false && (showSuggestions || input.trim() === '') && !isStreaming && !isLooping && suggestions.length > 0 && (
        <div className="prompt-suggestions" aria-label="Starter prompts">
          {suggestions.map((suggestion) => (
            <button
              key={suggestion}
              className={`prompt-chip ${selectedSuggestions.has(suggestion) ? 'selected' : ''}`}
              onClick={() => toggleSuggestion(suggestion)}
              title="点击添加这条提示；可以选择多条"
            >
              {suggestion}
            </button>
          ))}
        </div>
      )}

      <div className="composer">
        {cmdMatches.length > 0 && (
        <div className="slash-command-menu" role="listbox" aria-label="Kiro CLI commands">
          {cmdMatches.slice(0, 8).map((command, index) => (
            <button
              key={command.name}
              className={`slash-command-item ${index === cmdIndex ? 'active' : ''}`}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => acceptCommand(command)}
              role="option"
              aria-selected={index === cmdIndex}
            >
              <span className="slash-command-name">{command.name}</span>
              {command.hint && <span className="slash-command-hint">{command.hint}</span>}
              {command.description && <span className="slash-command-description">{command.description}</span>}
            </button>
          ))}
        </div>
      )}

      {attachedFiles.length > 0 && (
        <div className="composer-attachments">
          {attachedFiles.map((file) => (
            <div key={file.id} className={`attached-file-chip ${file.isImage ? 'is-image' : ''}`} title={file.path}>
              {file.isImage && file.preview ? (
                <img className="attached-file-thumb" src={file.preview} alt={file.name} />
              ) : (
                <span className="attached-file-icon">
                  {file.path.endsWith('/') || file.path.endsWith('\\') || !file.name.includes('.') ? '📁' : '📄'}
                </span>
              )}
              <span className="attached-file-name">{file.name}</span>
              <button className="attached-file-remove" onClick={() => onRemoveFile(file.id)} title="Remove attachment">✕</button>
            </div>
          ))}
        </div>
      )}

      <textarea
        ref={textareaRef}
        className="composer-input"
        placeholder={
          isLooping
            ? '正在循环重发消息，点击 Stop 停止'
            : status !== 'connected'
            ? 'Connecting... (type /stop to force reconnect)'
            : isStreaming && queuedMessages.length > 0
            ? `Agent is working — Enter appends to the last queued follow-up · ${MOD_KEY}+Enter adds a new queue item`
            : isStreaming
            ? `Agent is working — Enter steers the running turn · ${MOD_KEY}+Enter queues`
            : 'Type a message...'
        }
        value={input}
        disabled={isLooping}
        onChange={(e) => {
          setInput(e.target.value);
          setCmdIndex(0);
          setCmdEscaped(false);
        }}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        onCompositionStart={() => setIsComposing(true)}
        onCompositionEnd={() => setIsComposing(false)}
        rows={2}
      />

      <div className="composer-toolbar">
        <div className="composer-controls">
          <button
            className="composer-icon-btn"
            onClick={handleFilePick}
            title="Attach files"
            disabled={isLooping || status !== 'connected'}
          >
            <IconPaperclip />
          </button>
          <button
            type="button"
            className={`composer-mode ${permissionMode === 'auto-approve' ? 'yolo' : ''}`}
            onClick={() => onPermissionModeChange(
              permissionMode === 'auto-approve' ? 'ask' : 'auto-approve'
            )}
            disabled={isLooping || isStreaming || status !== 'connected'}
            aria-pressed={permissionMode === 'auto-approve'}
            title={permissionMode === 'auto-approve'
              ? 'Auto-approve all tools (click to require approval)'
              : 'Ask before each tool (click to auto-approve)'}
          >
            {permissionMode === 'auto-approve' ? (
              <>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <polygon points="13 2 4 14 11 14 10 22 20 9 13 9" />
                </svg>
                Auto
              </>
            ) : (
              <>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z" />
                  <polyline points="9 12 11.5 14.5 15.5 10" />
                </svg>
                Ask
              </>
            )}
          </button>
          {/* Deliberately NOT disabled on empty content, only on states the user can
              actually reason about (looping / not connected). A button greyed out
              purely because the composer is empty explains nothing, and it read as
              "queueing is broken" — while the keyboard path stayed silent, so the two
              disagreed. handleQueue already ignores a genuinely empty message
              (no text AND no attachments), which is the honest no-op. */}
          <button
            className="composer-icon-btn"
            onClick={handleQueue}
            title={`Queue message (${MOD_KEY}+Enter)`}
            disabled={isLooping || status !== 'connected'}
          >
            <IconQueue />
          </button>
          <span className="composer-shortcut">
            {isLooping
              ? '循环运行中 · Stop 停止循环'
              : isStreaming && queuedMessages.length > 0
              ? `Enter append to queue tail · Shift+Enter newline · ${MOD_KEY}+Enter new queue item`
              : isStreaming
              ? `Enter steer running turn · Shift+Enter newline · ${MOD_KEY}+Enter queue`
              : `Enter send · Shift+Enter newline · ${MOD_KEY}+Enter queue`}
          </span>
        </div>

        {isLooping ? (
          <button className="composer-send stop" onClick={onStopLoop} title="停止循环重发">
            <span className="stop-btn-square" />
          </button>
        ) : isStreaming && !canSend ? (
          <button className="composer-send stop" onClick={onCancel} title="Stop">
            <span className="stop-btn-square" />
          </button>
        ) : (
          <button
            className={`composer-send${
              queueModifierHeld || (isStreaming && queuedMessages.length > 0)
                ? ' queue'
                : isStreaming
                ? ' steer'
                : ''
            }`}
            onClick={handleActionClick}
            // Same reasoning as the queue button: empty content is a no-op, not a
            // reason to grey out. handleSend/handleQueue drop a truly empty message.
            disabled={status !== 'connected'}
            title={queueModifierHeld
              ? `Add a new queued message (${MOD_KEY}+Enter)`
              : isStreaming && queuedMessages.length > 0
              ? 'Append to the last queued message (Enter)'
              : isStreaming
              ? 'Steer the running turn (Enter)'
              : 'Send (Enter)'}
          >
            {queueModifierHeld ? (
              <IconQueue size={17} />
            ) : isStreaming && queuedMessages.length > 0 ? (
              <IconAppendMessage size={17} />
            ) : isStreaming ? (
              <IconSteer size={17} />
            ) : (
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="19" x2="12" y2="5" />
                <polyline points="5 12 12 5 19 12" />
              </svg>
            )}
          </button>
        )}
      </div>
    </div>
    </>
  );
});

const PLAN_STATUS_ICON: Record<string, string> = {
  completed: '✓',
  in_progress: '▶',
  pending: '○',
};

// Agent execution plan / todo list (ACP `plan` update). Collapsible; shows
// per-entry status. Only rendered when the session has a plan.
const PlanPanel = memo<{ plan: PlanEntry[] }>(({ plan }) => {
  const [collapsed, setCollapsed] = useState(false);
  if (!plan.length) return null;
  const done = plan.filter((e) => e.status === 'completed').length;
  return (
    <div className="turn-panel plan-panel">
      <button className="turn-panel-head" onClick={() => setCollapsed((c) => !c)}>
        <span className="turn-panel-caret">{collapsed ? '▸' : '▾'}</span>
        📋 计划 <span className="turn-panel-count">{done}/{plan.length}</span>
      </button>
      {!collapsed && (
        <ol className="plan-list">
          {plan.map((entry, i) => (
            <li key={i} className={`plan-item status-${entry.status || 'pending'}`}>
              <span className="plan-item-icon">{PLAN_STATUS_ICON[entry.status || 'pending'] || '○'}</span>
              <span className="plan-item-text">{entry.content}</span>
              {entry.priority && entry.priority !== 'medium' && (
                <span className={`plan-item-pri pri-${entry.priority}`}>{entry.priority}</span>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
});

function diffStats(diff: FileDiff): { added: number; removed: number } {
  const oldLines = (diff.oldText || '').split('\n');
  const newLines = diff.newText.split('\n');
  // Naive line-count delta — a cheap signal, not a real LCS diff.
  const added = Math.max(0, newLines.length - oldLines.length);
  const removed = Math.max(0, oldLines.length - newLines.length);
  return { added, removed };
}

// Files the agent touched this turn (ACP tool_call locations + diffs).
// Deduped by path; each row opens the file; rows with a diff expand a peek.
/** Tool kinds that RUN something. Mirrors RUN_KINDS in the main process. */
const RUN_KINDS = new Set(['execute', 'run', 'bash', 'shell', 'command', 'terminal']);

/** 「运行的命令」 -- the commands executed this turn.
 *
 *  Separate from 「改动的文件」 on purpose: a command is not a changed file, and the
 *  files panel correctly refuses to list it (no diff, non-mutating kind). But it must
 *  appear SOMEWHERE, because it is often the step that produces the real artifact:
 *  the agent writes build_deck.py (a genuine `edit`, listed) and then runs it, and the
 *  .pptx is written by that subprocess. With the command invisible, the turn read as
 *  "created a script" and the .pptx appeared to come from nowhere -- the middle link
 *  of the causal chain was missing. This does NOT claim what the command wrote: KiroLex
 *  cannot know that, since a subprocess's writes carry no tool metadata at all. */
const CommandsPanel = memo<{ fileChanges: ToolCall[] }>(({ fileChanges }) => {
  const [collapsed, setCollapsed] = useState(false);
  const cmds = useMemo(() => {
    const byId = new Map<string, ToolCall>();
    for (const tc of fileChanges) {
      if (RUN_KINDS.has((tc.kind || '').toLowerCase())) byId.set(tc.toolCallId, tc);
    }
    return Array.from(byId.values());
  }, [fileChanges]);
  if (!cmds.length) return null;
  return (
    <div className="turn-panel commands-panel">
      <button className="turn-panel-head" onClick={() => setCollapsed((c) => !c)}>
        <span className="turn-panel-caret">{collapsed ? '▸' : '▾'}</span>
        ⚡ 运行的命令 <span className="turn-panel-count">{cmds.length}</span>
      </button>
      {!collapsed && (
        <ul className="files-list">
          {cmds.map((c) => (
            <li key={c.toolCallId} className="files-item">
              <div className="files-item-row">
                <span className="files-item-kind">{c.kind}</span>
                <span className="commands-item-title" title={c.title}>{c.title}</span>
                {c.status === 'failed' && <span className="stat-del">失败</span>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
});

/** One file name in 「改动的文件」, clickable only if the file is still there.
 *
 *  The panel records the path as it was AT TOOL-CALL TIME, which can stop resolving
 *  before the turn even ends -- renaming a file mid-turn is enough (observed: an edit
 *  to `…逐项分析_v4.md` followed by a rename to `…逐项评估_v4.md`, leaving the row
 *  pointing at a path that no longer existed). Every row used to be unconditionally
 *  clickable and `openPathInApp` only dispatches an event, so clicking a stale row
 *  did NOTHING AT ALL: no viewer, no error, no hint -- indistinguishable from the
 *  app being broken. Prose file links already had this exact protection via
 *  usePathExists; the panel simply never used it.
 *
 *  The `diff` button is intentionally unaffected: the diff text lives in the
 *  transcript, so what changed stays readable even once the file is gone. */
const FileChangePath: React.FC<{ path: string; label: string }> = ({ path, label }) => {
  const exists = usePathExists(path);
  if (exists === 'no') {
    return (
      <span
        className="files-item-path missing"
        title={`文件已不存在，无法打开：${path}\n（可能在这一轮之后被改名或删除；下方 diff 仍可查看改了什么）`}
      >
        {label}
      </span>
    );
  }
  return (
    <span
      className="files-item-path"
      title={`在 KiroLex 内打开 ${path}`}
      onClick={() => openPathInApp(path)}
    >
      {label}
    </span>
  );
};
const FileChangesPanel = memo<{ fileChanges: ToolCall[] }>(({ fileChanges }) => {
  const [collapsed, setCollapsed] = useState(false);
  const [openPath, setOpenPath] = useState<string | null>(null);
  const files = useMemo(() => {
    // "改动的文件" = files actually MUTATED this turn. ACP tool kinds like
    // 'read'/'search'/'fetch' also carry locations (e.g. a read of the cwd),
    // but they are NOT changes — only entries that carry a real diff, or whose
    // tool kind is mutating (edit/create/write/delete/move), count here.
    const MUTATING = new Set(['edit', 'create', 'write', 'delete', 'move', 'rename']);
    const map = new Map<string, { path: string; kind?: string; diff?: FileDiff }>();
    // Same file, two spellings: on macOS /tmp and /var are symlinks into /private,
    // and a tool may report either. Keyed on the raw string, one edit to
    // /tmp/x.py showed up as TWO rows (/tmp/x.py and /private/tmp/x.py, same
    // inode) and inflated the count — 3 entries for 2 files. Fold them, keeping
    // the first spelling seen so the row still names a path that resolves.
    const dedupKey = (fp: string) => fp.replace(/^\/private(\/(?:tmp|var|etc)\/)/, '$1');
    const put = (fp: string, v: { kind?: string; diff?: FileDiff }) => {
      const k = dedupKey(fp);
      const prev = map.get(k);
      if (!prev) map.set(k, { path: fp, ...v });
      // A later entry may carry the diff the earlier bare location lacked.
      else if (!prev.diff && v.diff) map.set(k, { ...prev, diff: v.diff, kind: v.kind || prev.kind });
    };
    for (const tc of fileChanges) {
      // A carried diff is always a genuine change.
      for (const d of tc.diffs || []) put(d.path, { kind: tc.kind || 'edit', diff: d });
      // Bare locations only count when the tool call itself is mutating.
      if (MUTATING.has((tc.kind || '').toLowerCase())) {
        for (const p of tc.locations || []) put(p, { kind: tc.kind });
      }
    }
    return Array.from(map.values());
  }, [fileChanges]);
  if (!files.length) return null;
  const base = (p: string) => p.split(/[/\\]/).pop() || p;
  return (
    <div className="turn-panel files-panel">
      <button className="turn-panel-head" onClick={() => setCollapsed((c) => !c)}>
        <span className="turn-panel-caret">{collapsed ? '▸' : '▾'}</span>
        📝 改动的文件 <span className="turn-panel-count">{files.length}</span>
      </button>
      {!collapsed && (
        <ul className="files-list">
          {files.map((f) => {
            const stats = f.diff ? diffStats(f.diff) : null;
            const expanded = openPath === f.path;
            return (
              <li key={f.path} className="files-item">
                <div className="files-item-row">
                  {f.kind && <span className="files-item-kind">{f.kind}</span>}
                  <FileChangePath path={f.path} label={base(f.path)} />
                  {stats && (stats.added > 0 || stats.removed > 0) && (
                    <span className="files-item-stat">
                      {stats.added > 0 && <span className="stat-add">+{stats.added}</span>}
                      {stats.removed > 0 && <span className="stat-del">-{stats.removed}</span>}
                    </span>
                  )}
                  {f.diff && (
                    <button className="files-item-peek" onClick={() => setOpenPath(expanded ? null : f.path)}>
                      {expanded ? '收起' : 'diff'}
                    </button>
                  )}
                </div>
                {f.diff && expanded && (
                  <pre className="files-item-diff">
                    <code>{f.diff.newText}</code>
                  </pre>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
});

interface ChatAreaProps {
  messages: Message[];
  isStreaming: boolean;
  status: 'disconnected' | 'connecting' | 'connected';
  sessionConnected: boolean;
  connectionError: string | null;
  onDismissError?: () => void;
  attachedFiles: AttachedFile[];
  models: any[];
  selectedModel: string;
  activeToolCall: string | null;
  activityStatus: string | null;
  /** A RUNNING turn that has stopped producing. Refreshed every 30s by main, so the
   *  elapsed time and the countdown to the timeout interrupt stay accurate. */
  stall: {
    quietSeconds: number;
    openTools: number;
    toolIdleSeconds: number;
    cpuBusy: boolean;
    cpuVetoLeftSeconds: number;
    interruptInSeconds: number | null;
  } | null;
  permissionRequest: PermissionRequest | null;
  onRespondPermission: (optionId: string) => Promise<void>;
  usage: { contextPercent: number; credits: number; turnMs?: number } | null;
  plan: PlanEntry[];
  autoFoldThinking: boolean;
  autoFoldTools: boolean;
  onManageContext: () => void;
  onResetCredits: () => void;
  commands: SlashCommand[];
  onModelChange: (model: string) => void;
  kiroAgent: string;
  kiroAgents: KiroAgentOption[];
  switchingAgent: boolean;
  switchingModel: boolean;
  permissionMode: 'auto-approve' | 'ask';
  onPermissionModeChange: (mode: 'auto-approve' | 'ask') => void;
  onKiroAgentChange: (agentName: string) => void;
  onForkMessage: (messageId: string) => void;
  onRerunMessage: (messageId: string, editedText: string) => void;
  turnInterrupted?: boolean;
  onSend: (text: string, pastes?: PastedBlock[]) => void;
  onSteerMessage: (text: string) => void;
  onCancel: () => void;
  onDropFiles: (files: AttachedFile[]) => void;
  onRemoveFile: (id: string) => void;
  currentSessionId: string | null;
  isArchived?: boolean;
  onUnarchive?: () => void;
  /** Settings: send the whole queue as one merged turn (vs one-by-one). */
  mergeQueuedMessages: boolean;
  /** History for this session is still being read from disk. */
  historyLoading: boolean;
  queuedMessages: QueuedMessage[];
  restoredQueueDraft: { id: number; text: string } | null;
  restoredInputDraft: { id: number; text: string; sessionId?: string } | null;
  onQueueMessage: (text: string, pastes?: PastedBlock[]) => void;
  onCancelQueuedMessage: (queueId: string) => void;
  onEditQueuedMessage: (queueId: string, content: string) => void;
  onMoveQueuedMessage: (queueId: string, direction: -1 | 1) => void;
  importableSessions: { id: string; title: string }[];
  contextLinks: { sourceId: string; sourceTitle: string }[];
  onToggleContextSource: (sourceSessionId: string) => void;
  isLooping: boolean;
  onStartLoop: (text: string, intervalSec: number) => void;
  onStopLoop: () => void;
  /** Split-pane monitor mode: transcript + live indicators + permission bar,
   *  but no composer/queue — you type in the focused pane. */
  readOnly?: boolean;
  /** False for split panes that are not focused: they must not react to global
   *  triggers such as "open Agent config". */
  paneFocused?: boolean;
}

/** Generated suggestions keyed `${sessionId}:${lastAssistantMessageId}`.
 *  Module level ON PURPOSE: they used to live in component state, so every
 *  layout change that remounts a ChatArea (entering/leaving split view, adding
 *  or removing a pane) made the chips vanish and paid for a fresh generation
 *  ~8s later. The key is per turn, so nothing leaks between chats. */
const suggestionCache = new Map<string, string[]>();
const SUGGESTION_CACHE_MAX = 60;
function suggestionKey(sessionId: string | null, messages: Message[]): string | null {
  if (!sessionId || messages.length === 0) return null;
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'assistant') return null;
  return `${sessionId}:${last.id}`;
}
function cacheSuggestions(key: string, list: string[]) {
  suggestionCache.set(key, list);
  if (suggestionCache.size > SUGGESTION_CACHE_MAX) {
    const oldest = suggestionCache.keys().next().value;
    if (oldest) suggestionCache.delete(oldest);
  }
}

export const ChatArea: React.FC<ChatAreaProps> = ({
  messages,
  isStreaming,
  status,
  sessionConnected,
  connectionError,
  onDismissError,
  attachedFiles,
  models,
  selectedModel,
  activeToolCall,
  activityStatus,
  stall,
  permissionRequest,
  onRespondPermission,
  usage,
  onManageContext,
  plan,
  onResetCredits,
  autoFoldThinking,
  autoFoldTools,
  commands,
  onModelChange,
  kiroAgent,
  kiroAgents,
  switchingAgent,
  switchingModel,
  permissionMode,
  onPermissionModeChange,
  onKiroAgentChange,
  onForkMessage,
  onRerunMessage,
  turnInterrupted,
  onSend,
  onSteerMessage,
  onCancel,
  onDropFiles,
  onRemoveFile,
  currentSessionId,
  isArchived,
  onUnarchive,
  mergeQueuedMessages,
  historyLoading,
  queuedMessages,
  restoredQueueDraft,
  restoredInputDraft,
  onQueueMessage,
  onCancelQueuedMessage,
  onEditQueuedMessage,
  onMoveQueuedMessage,
  importableSessions,
  contextLinks,
  onToggleContextSource,
  isLooping,
  onStartLoop,
  onStopLoop,
  readOnly = false,
  paneFocused = true,
}) => {
  const [isDragOver, setIsDragOver] = useState(false);
  // Conversation-aware prompt suggestions: regenerate a few contextual follow-up
  // prompts each time a turn finishes, so the chips reflect the current chat
  // instead of the static starter set. Empty chats keep the static starters.
  // Seed from the cache so a remount (layout change) shows the existing chips
  // immediately instead of blanking and regenerating.
  //
  // The chips are STAMPED with the turn they were generated for, and only render
  // when that stamp matches the current turn. Without the stamp the state was a bare
  // string[], so when a new turn finished the PREVIOUS turn's chips became visible
  // again the instant `isStreaming` went false — and stayed visible for the whole
  // 400ms debounce plus the suggestion model's latency, i.e. seconds of confidently
  // showing follow-ups to an answer that had already been superseded. Note the
  // request guard below (`suggestionsForRef`) cannot serve this purpose: it is set
  // OPTIMISTICALLY before the async call, so it says "asked", not "arrived".
  const [dynamicSuggestions, setDynamicSuggestions] = useState<{ key: string | null; items: string[] }>(() => {
    const k = suggestionKey(currentSessionId, messages);
    const cached = (k && suggestionCache.get(k)) || [];
    return { key: cached.length ? k : null, items: cached };
  });
  /** The turn the chips must match to be shown. Null while a turn is unanswered or
   *  in flight, which is exactly when nothing should be offered. */
  const currentTurnKey = suggestionKey(currentSessionId, messages);
  const suggestionsForRef = useRef<string | null>(suggestionKey(currentSessionId, messages));
  useEffect(() => {
    // Switching chats in-place (single view): show that chat's cached chips if we
    // have them, otherwise clear — never leak one chat's suggestions into another.
    const k = suggestionKey(currentSessionId, messages);
    const cached = (k && suggestionCache.get(k)) || [];
    setDynamicSuggestions({ key: cached.length ? k : null, items: cached });
    suggestionsForRef.current = cached.length ? k : null;
  }, [currentSessionId]);
  useEffect(() => {
    if (isStreaming || messages.length === 0) return;
    const last = messages[messages.length - 1];
    if (!last || last.role !== 'assistant') return;
    const key = `${currentSessionId || ''}:${last.id}`;
    if (suggestionsForRef.current === key) return; // already generated for this turn
    const cachedForTurn = suggestionCache.get(key);
    if (cachedForTurn?.length) {
      // Already generated for this exact turn (e.g. before a layout change):
      // reuse it instead of paying for the same suggestions again.
      suggestionsForRef.current = key;
      setDynamicSuggestions({ key, items: cachedForTurn });
      return;
    }
    suggestionsForRef.current = key;
    const recent = messages
      .slice(-6)
      .filter((m) => !m.content.startsWith('💭 ') && !m.content.startsWith('🔧 '))
      .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.slice(0, 800)}`)
      .join('\n\n');
    let cancelled = false;
    const timer = setTimeout(() => {
      window.kiroApi.generateSuggestions?.(recent)
        .then((r) => {
          if (cancelled) return;
          if (r?.suggestions?.length) {
            cacheSuggestions(key, r.suggestions);
            setDynamicSuggestions({ key, items: r.suggestions });
          }
          // Nothing came back (timeout / backend hiccup): release the per-turn
          // guard so the next turn tries again instead of staying empty forever.
          else suggestionsForRef.current = null;
        })
        .catch(() => { if (!cancelled) suggestionsForRef.current = null; });
    }, 400);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [messages, isStreaming, currentSessionId]);
  const [loopSetup, setLoopSetup] = useState<{ text: string } | null>(null);
  const [loopSeconds, setLoopSeconds] = useState('');
  const [showImportPicker, setShowImportPicker] = useState(false);
  const [pickerPos, setPickerPos] = useState<{ left: number; bottom: number }>({ left: 0, bottom: 0 });
  const importBtnRef = useRef<HTMLButtonElement>(null);
  const agentConfigTextareaRef = useRef<HTMLTextAreaElement>(null);
  const agentConfigLineNumbersRef = useRef<HTMLDivElement>(null);

  const [agentConfigEditor, setAgentConfigEditor] = useState<AgentConfigEditorState | null>(null);
  const [agentConfigDrafts, setAgentConfigDrafts] = useState<Record<string, AgentConfigEditorState>>({});
  const [agentConfigLoading, setAgentConfigLoading] = useState(false);
  const [agentConfigSaving, setAgentConfigSaving] = useState(false);
  const [agentConfigStatus, setAgentConfigStatus] = useState<string | null>(null);
  /** Pending destructive confirmation for this pane. In-app dialog, not
   *  `window.confirm` -- that one blocks the renderer's main thread. */
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const agentConfigAgents = useMemo<KiroAgentOption[]>(() => {
    if (kiroAgents.some((agent) => agent.name === kiroAgent)) return kiroAgents;
    return [
      ...kiroAgents,
      {
        name: kiroAgent,
        isDefault: false,
        source: kiroAgent === 'kiro_default' ? 'built-in' : 'global',
      },
    ];
  }, [kiroAgents, kiroAgent]);
  const agentConfigValidationError = useMemo(
    () => agentConfigEditor && !agentConfigEditor.error
      ? validateAgentConfigJson(agentConfigEditor.content)
      : null,
    [agentConfigEditor?.content, agentConfigEditor?.error],
  );
  const agentConfigLines = useMemo(
    () => agentConfigEditor?.content.split('\n') || [''],
    [agentConfigEditor?.content],
  );

  const updateAgentConfigContent = useCallback((content: string) => {
    if (!agentConfigEditor) return;
    const updatedDraft = { ...agentConfigEditor, content };
    setAgentConfigEditor(updatedDraft);
    setAgentConfigDrafts((current) => ({
      ...current,
      [updatedDraft.agentName]: updatedDraft,
    }));
    setAgentConfigStatus(null);
  }, [agentConfigEditor]);

  const formatAgentConfig = useCallback(() => {
    if (!agentConfigEditor || agentConfigValidationError) return;
    const formatted = `${JSON.stringify(JSON.parse(agentConfigEditor.content), null, 2)}\n`;
    updateAgentConfigContent(formatted);
  }, [agentConfigEditor, agentConfigValidationError, updateAgentConfigContent]);

  const focusAgentConfigError = useCallback(() => {
    if (!agentConfigEditor || !agentConfigValidationError) return;
    const textarea = agentConfigTextareaRef.current;
    if (!textarea) return;

    const linesBeforeError = agentConfigEditor.content
      .split('\n')
      .slice(0, Math.max(0, agentConfigValidationError.line - 1));
    const lineStart = linesBeforeError.reduce((total, line) => total + line.length + 1, 0);
    const offset = Math.min(
      agentConfigEditor.content.length,
      lineStart + Math.max(0, agentConfigValidationError.column - 1),
    );
    textarea.focus();
    textarea.setSelectionRange(offset, offset);

    const lineHeight = Number.parseFloat(window.getComputedStyle(textarea).lineHeight) || 18.6;
    const scrollTop = Math.max(
      0,
      (agentConfigValidationError.line - 1) * lineHeight - textarea.clientHeight / 2,
    );
    textarea.scrollTop = scrollTop;
    if (agentConfigLineNumbersRef.current) {
      agentConfigLineNumbersRef.current.scrollTop = scrollTop;
    }
  }, [agentConfigEditor, agentConfigValidationError]);

  const loadAgentConfig = useCallback(async (agentName: string) => {
    if (!currentSessionId || agentConfigLoading) return;

    // Switching Agents is non-destructive: retain the current editor state in
    // memory and restore an existing draft when this Agent is selected again.
    // Nothing is written to disk until the user explicitly clicks Save.
    const draftsWithCurrent = agentConfigEditor
      ? { ...agentConfigDrafts, [agentConfigEditor.agentName]: agentConfigEditor }
      : agentConfigDrafts;
    if (agentConfigEditor) setAgentConfigDrafts(draftsWithCurrent);

    const existingDraft = draftsWithCurrent[agentName];
    setAgentConfigStatus(null);
    if (existingDraft) {
      setAgentConfigEditor(existingDraft);
      return;
    }

    setAgentConfigLoading(true);
    setAgentConfigEditor({
      agentName,
      path: '',
      content: '',
      initialContent: '',
    });
    try {
      const agentSource = agentConfigAgents.find((agent) => agent.name === agentName)?.source;
      const result = await window.kiroApi.openKiroAgentConfig(
        currentSessionId,
        agentName,
        agentSource,
      );
      const loadedConfig: AgentConfigEditorState =
        !result.opened || !result.path || result.content === undefined
          ? {
              agentName,
              path: '',
              content: '',
              initialContent: '',
              error: result.error || 'Unable to open this Agent configuration.',
            }
          : {
              agentName,
              path: result.path,
              content: result.content,
              initialContent: result.content,
            };
      setAgentConfigEditor(loadedConfig);
      setAgentConfigDrafts((current) => ({
        ...current,
        [agentName]: loadedConfig,
      }));
    } finally {
      setAgentConfigLoading(false);
    }
  }, [
    currentSessionId,
    agentConfigLoading,
    agentConfigEditor,
    agentConfigDrafts,
    agentConfigAgents,
  ]);

  const openAgentConfig = useCallback(() => {
    void loadAgentConfig(kiroAgent);
  }, [kiroAgent, loadAgentConfig]);

  // The trigger now lives in the sidebar (Agent config is global, not per chat).
  // Only the focused pane opens the editor, so a split view never opens N copies.
  useEffect(() => {
    if (readOnly || paneFocused === false) return;
    const handler = () => openAgentConfig();
    window.addEventListener('kirolex:open-agent-config', handler);
    return () => window.removeEventListener('kirolex:open-agent-config', handler);
  }, [openAgentConfig, paneFocused, readOnly]);

  /** Drop the Agent-config editor and every draft in it. */
  const discardAgentConfig = useCallback(() => {
    setAgentConfigEditor(null);
    setAgentConfigDrafts({});
    setAgentConfigStatus(null);
  }, []);

  const closeAgentConfig = useCallback(() => {
    const draftsWithCurrent = agentConfigEditor
      ? { ...agentConfigDrafts, [agentConfigEditor.agentName]: agentConfigEditor }
      : agentConfigDrafts;
    const hasUnsavedDrafts = Object.values(draftsWithCurrent).some((draft) => (
      !draft.error && draft.content !== draft.initialContent
    ));
    // Asked through the in-app dialog instead of window.confirm, which blocks the
    // renderer's main thread until the OS modal resolves (see ConfirmDialog). The
    // decision now arrives as a state update, so this handler returns immediately.
    if (hasUnsavedDrafts) {
      setConfirm({
        title: '未保存的 Agent 配置',
        message: '关闭编辑器会丢弃所有未保存的 Agent 配置草稿。\n\n此操作不可恢复。',
        confirmLabel: '丢弃',
        destructive: true,
        onConfirm: discardAgentConfig,
      });
      return;
    }
    discardAgentConfig();
  }, [agentConfigEditor, agentConfigDrafts, discardAgentConfig]);

  const saveAgentConfig = useCallback(async () => {
    if (
      !currentSessionId ||
      !agentConfigEditor ||
      agentConfigEditor.error ||
      agentConfigSaving
    ) return;
    const validationError = validateAgentConfigJson(agentConfigEditor.content);
    if (validationError) {
      setAgentConfigStatus(validationError.message);
      return;
    }

    setAgentConfigSaving(true);
    setAgentConfigStatus(null);
    try {
      const agentSource = agentConfigAgents.find(
        (agent) => agent.name === agentConfigEditor.agentName
      )?.source;
      const result = await window.kiroApi.saveKiroAgentConfig(
        currentSessionId,
        agentConfigEditor.agentName,
        agentSource,
        agentConfigEditor.content,
      );
      if (!result.saved) {
        setAgentConfigStatus(result.error || 'Unable to save this Agent configuration.');
        return;
      }
      const savedConfig: AgentConfigEditorState = {
        ...agentConfigEditor,
        initialContent: agentConfigEditor.content,
        path: result.path || agentConfigEditor.path,
      };
      setAgentConfigEditor(savedConfig);
      setAgentConfigDrafts((current) => ({
        ...current,
        [savedConfig.agentName]: savedConfig,
      }));
      setAgentConfigStatus('Saved');
    } finally {
      setAgentConfigSaving(false);
    }
  }, [currentSessionId, agentConfigEditor, agentConfigSaving, agentConfigAgents]);

  const toggleImportPicker = useCallback(() => {
    const el = importBtnRef.current;
    if (el) {
      const r = el.getBoundingClientRect();
      // Anchor a fixed-position popup just above the button so it escapes the
      // overflow:hidden clipping of the chat input / main containers, and CLAMP
      // it to the viewport: in a right-hand split pane the raw button x pushed
      // the 300px panel off screen, so it looked like the feature was dead.
      const PICKER_W = 300;
      const PICKER_MAX_H = 320;
      const left = Math.max(8, Math.min(r.left, window.innerWidth - PICKER_W - 8));
      const bottom = Math.max(8, Math.min(window.innerHeight - r.top + 8, window.innerHeight - PICKER_MAX_H - 8));
      setPickerPos({ left, bottom });
    }
    setShowImportPicker((v) => !v);
  }, []);
  const [inputHeight, setInputHeight] = useState(() => {
    try {
      const saved = uiGet('kirolex-input-height');
      if (saved) return parseInt(saved, 10);
    } catch {}
    return 140;
  });
  const [inputCollapsed, setInputCollapsed] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const chatMessagesRef = useRef<HTMLDivElement>(null);
  // Sticky-bottom autoscroll state: true only while the user is parked at the
  // bottom. Declared before any effect that reads it (dependency arrays are
  // evaluated during render -- a later declaration would hit TDZ).
  const stickToBottomRef = useRef(true);
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);
  const dragCounterRef = useRef(0);
  const inputResizingRef = useRef(false);
  const inputHeightRef = useRef(inputHeight);

  // Windowed transcript rendering: render only the most recent N message groups
  // and reveal older ones as the user scrolls up. Rendering the full transcript
  // (thousands of markdown+highlight nodes for large/migrated sessions) freezes
  // the renderer and makes every re-render (delete, switch, stream) janky.
  const INITIAL_RENDER = 120;
  const RENDER_CHUNK = 120;
  const [renderLimit, setRenderLimit] = useState(INITIAL_RENDER);
  const preExpandHeightRef = useRef<number | null>(null);
  // Reset the window when switching sessions so a newly-opened chat starts capped.
  useEffect(() => { setRenderLimit(INITIAL_RENDER); }, [currentSessionId]);
  const loadOlder = useCallback(() => {
    const el = chatMessagesRef.current;
    if (el) preExpandHeightRef.current = el.scrollHeight;
    setRenderLimit((l) => l + RENDER_CHUNK);
  }, []);
  // Preserve the scroll position when older groups are prepended (no viewport jump).
  useLayoutEffect(() => {
    const el = chatMessagesRef.current;
    if (el && preExpandHeightRef.current != null) {
      el.scrollTop += el.scrollHeight - preExpandHeightRef.current;
      preExpandHeightRef.current = null;
    }
  }, [renderLimit]);

  const handleInputResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    inputResizingRef.current = true;
    const startY = e.clientY;
    const startHeight = inputHeight;

    const onMouseMove = (ev: MouseEvent) => {
      if (!inputResizingRef.current) return;
      const maxHeight = Math.max(180, Math.floor(window.innerHeight * 0.7));
      const newHeight = Math.max(96, Math.min(maxHeight, startHeight - (ev.clientY - startY)));
      inputHeightRef.current = newHeight;
      setInputHeight(newHeight);
    };

    const onMouseUp = () => {
      inputResizingRef.current = false;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      try {
        uiSet('kirolex-input-height', String(inputHeightRef.current));
      } catch {}
    };

    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, [inputHeight]);

  useEffect(() => {
    inputHeightRef.current = inputHeight;
    try {
      uiSet('kirolex-input-height', String(inputHeight));
    } catch {}
  }, [inputHeight]);

  useEffect(() => {
    // Sticky-bottom autoscroll: only follow new output when the user is already
    // parked at the bottom. If they scrolled up to read history, incoming
    // messages must NOT yank the view down.
    if (!stickToBottomRef.current) return;
    messagesEndRef.current?.scrollIntoView({ behavior: 'instant' });
  }, [messages]);

  // Switching chats always starts at the bottom (freshest turn) and re-arms stick.
  useEffect(() => {
    stickToBottomRef.current = true;
    setShowJumpToBottom(false);
    requestAnimationFrame(() => messagesEndRef.current?.scrollIntoView({ behavior: 'instant' }));
  }, [currentSessionId]);

  const jumpToBottom = useCallback(() => {
    stickToBottomRef.current = true;
    setShowJumpToBottom(false);
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  // Ctrl+A only selects chat messages content
  useEffect(() => {
    const handleSelectAll = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
        // If focus is in any editable element (chat input, a rename field, etc.),
        // let the browser's default select-all work on that field instead.
        const el = document.activeElement as HTMLElement | null;
        if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) {
          return;
        }

        e.preventDefault();
        const selection = window.getSelection();
        if (selection && chatMessagesRef.current) {
          const range = document.createRange();
          range.selectNodeContents(chatMessagesRef.current);
          selection.removeAllRanges();
          selection.addRange(range);
        }
      }
    };
    document.addEventListener('keydown', handleSelectAll);
    return () => document.removeEventListener('keydown', handleSelectAll);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current = 0;
    setIsDragOver(false);
    if (!e.dataTransfer.types.includes('Files')) return;
    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;
    void (async () => {
      const attached: AttachedFile[] = [];
      for (const f of files) {
        // Was missing, so a dropped image was attached as a generic file and never
        // rendered as one. Same MIME test the paste path uses.
        const isImage = /^image\//.test(String(f.type || ''));
        let p = (f as any).path || f.name;
        // Same dimension cap as the paste path: see prepare-image-attachment.
        if (isImage) {
          try { p = (await window.kiroApi.prepareImageAttachment?.(p))?.path || p; } catch {}
        }
        attached.push({
          id: `file_${Date.now()}_${Math.random().toString(36).slice(2)}`,
          name: f.name,
          path: p,
          isImage,
        });
      }
      onDropFiles(attached);
    })();
  }, [onDropFiles]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
  }, []);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    // Only show drop overlay for external file drops, not text selection drags
    if (e.dataTransfer.types.includes('Files')) {
      dragCounterRef.current++;
      setIsDragOver(true);
    }
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current--;
    if (dragCounterRef.current <= 0) {
      dragCounterRef.current = 0;
      setIsDragOver(false);
    }
  }, []);

  // Group each turn's original user message with the mid-turn steers injected
  // into the SAME turn (consecutive user messages carrying a `steer` flag). The
  // group renders as one bubble; an assistant message carries the COMBINED text
  // (original + all steers) of its preceding user group so the token estimate
  // reflects the whole question, not just the last steer. Render-layer only —
  // message ordering/ids in state are untouched.
  type RenderGroup =
    | { kind: 'user'; base: Message; steers: Message[] }
    | { kind: 'assistant'; segments: Message[]; isLast: boolean; question: string };
  // Heal stranded steers before grouping: a steer that ended up AFTER this
  // turn's assistant/tool messages (ordering slip, or restored history) is moved
  // back next to its base user message, so it renders as a Steer paragraph in
  // the same bubble instead of a lone orphan bubble without the Steer label.
  const orderedMessages = useMemo<Message[]>(() => {
    if (!messages.some((m) => m.role === 'user' && m.steer)) return messages;
    const out: Message[] = [];
    for (const m of messages) {
      if (m.role === 'user' && m.steer) {
        let baseIdx = -1;
        for (let i = out.length - 1; i >= 0; i--) {
          if (out[i].role === 'user' && !out[i].steer) { baseIdx = i; break; }
        }
        if (baseIdx >= 0) {
          let at = baseIdx + 1;
          while (at < out.length && out[at].role === 'user' && out[at].steer) at++;
          out.splice(at, 0, m);
          continue;
        }
      }
      out.push(m);
    }
    return out;
  }, [messages]);

  const renderGroups = useMemo<RenderGroup[]>(() => {
    const groups: RenderGroup[] = [];
    let lastQuestion = '';
    const messages = orderedMessages;
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      if (m.role === 'user') {
        if (!m.steer) {
          const steers: Message[] = [];
          let j = i + 1;
          while (j < messages.length && messages[j].role === 'user' && messages[j].steer) {
            steers.push(messages[j]);
            j++;
          }
          lastQuestion = [m.content, ...steers.map((s) => s.content)].join('\n\n');
          groups.push({ kind: 'user', base: m, steers });
          i = j - 1;
        } else {
          // Orphan steer with no visible base (e.g. trimmed history) — show alone.
          lastQuestion = m.content;
          groups.push({ kind: 'user', base: m, steers: [] });
        }
      } else {
        // Coalesce this turn's consecutive assistant/tool/subagent messages
        // (everything until the next user turn) into one assistant group so a
        // tool-using turn renders as a single reply bubble, not many.
        const segments: Message[] = [m];
        let j = i + 1;
        while (j < messages.length && messages[j].role !== 'user') {
          segments.push(messages[j]);
          j++;
        }
        groups.push({
          kind: 'assistant',
          segments,
          isLast: j === messages.length,
          question: lastQuestion,
        });
        i = j - 1;
      }
    }
    return groups;
  }, [orderedMessages]);

  // Only the last `renderLimit` groups are mounted; older ones load on scroll-up.
  const visibleGroups = renderGroups.length > renderLimit
    ? renderGroups.slice(renderGroups.length - renderLimit)
    : renderGroups;
  const hiddenGroupCount = renderGroups.length - visibleGroups.length;

  return (
    <div
      className={`chat-main ${isDragOver ? 'drag-over' : ''}${readOnly ? ' chat-main-pane' : ''}`}
      onDrop={readOnly ? undefined : handleDrop}
      onDragOver={readOnly ? undefined : handleDragOver}
      onDragEnter={readOnly ? undefined : handleDragEnter}
      onDragLeave={readOnly ? undefined : handleDragLeave}
    >
      {isDragOver && (
        <div className="drop-overlay">
          <div className="drop-overlay-content">
            📎 Drop files to attach
          </div>
        </div>
      )}

      {connectionError && messages.length > 0 && (
        <div className="chat-error-banner" role="alert">
          <span className="chat-error-banner-text">❌ {connectionError}</span>
          {onDismissError && (
            <button
              className="chat-error-banner-close"
              onClick={onDismissError}
              title="关闭提示"
              aria-label="关闭提示"
            >✕</button>
          )}
        </div>
      )}

      <div
        className="chat-messages"
        ref={chatMessagesRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          // Sticky-bottom detection: within 60px of the bottom counts as "at
          // bottom" (covers fractional scroll heights and in-flight layout).
          const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
          const atBottom = distanceFromBottom <= 60;
          stickToBottomRef.current = atBottom;
          setShowJumpToBottom((visible) => (visible === !atBottom ? visible : !atBottom));
          if (el.scrollTop <= 80 && hiddenGroupCount > 0 && preExpandHeightRef.current == null) {
            loadOlder();
          }
        }}
      >
        {messages.length === 0 && historyLoading && (
          <div style={{ textAlign: 'center', marginTop: '20vh', color: 'var(--text-muted)' }}>
            <div className="history-loading-spinner" />
            <div style={{ marginTop: 14, fontSize: 13 }}>正在加载历史记录…</div>
          </div>
        )}
        {messages.length === 0 && !historyLoading && (
          <div style={{ textAlign: 'center', marginTop: '20vh', color: 'var(--text-muted)' }}>
            <div style={{ fontSize: 48, marginBottom: 16 }}>⚡</div>
            <h2 style={{ fontSize: 20, fontWeight: 500, marginBottom: 8, color: 'var(--text-secondary)' }}>
              KiroLex
            </h2>
            {connectionError ? (
              <div style={{ 
                maxWidth: 500, margin: '16px auto', padding: '12px 16px',
                background: 'rgba(239, 83, 80, 0.1)', border: '1px solid rgba(239, 83, 80, 0.3)',
                borderRadius: 8, textAlign: 'left', fontSize: 13, lineHeight: 1.6,
                color: 'var(--error)', whiteSpace: 'pre-wrap',
              }}>
                ❌ {connectionError}
              </div>
            ) : (
              <p style={{ fontSize: 14 }}>
                {status === 'connected'
                  ? 'Start a conversation or drag files here'
                  : 'Connecting...'}
              </p>
            )}
          </div>
        )}

        {hiddenGroupCount > 0 && (
          <button className="load-older-btn" onClick={loadOlder}>
            ⤴ 加载更早的消息（还有 {hiddenGroupCount} 组）
          </button>
        )}

        {visibleGroups.map((group) => (
          group.kind === 'user' ? (
            <UserGroupItem
              key={`${currentSessionId ?? 'none'}:${group.base.id}`}
              base={group.base}
              steers={group.steers}
              isStreaming={isStreaming}
              onRerun={onRerunMessage}
              attachmentSessionId={currentSessionId}
              onOpenAttachment={openPathInApp}
              interrupted={!!turnInterrupted}
              isLooping={isLooping}
              onLoopSetup={(text) => {
                setLoopSeconds('');
                setLoopSetup({ text });
              }}
            />
          ) : (
            <MessageItem
              key={`${currentSessionId ?? 'none'}:${group.segments[group.segments.length - 1].id}`}
              segments={group.segments}
              questionContent={group.question}
              isLastAssistant={group.isLast}
              isStreaming={isStreaming}
              onFork={onForkMessage}
              foldThinking={autoFoldThinking}
              foldTools={autoFoldTools}
            />
          )
        ))}

        {plan.length > 0 && (
          <div className="turn-panels">
            <PlanPanel plan={plan} />
          </div>
        )}

        {/* Exactly ONE tail indicator: a live tool call is the most specific, so
            it wins; otherwise show the phase text / thinking dots. */}
        {isStreaming && activeToolCall ? (
          <div className="agent-activity" title={activeToolCall}>
            <span className="agent-activity-pulse" />
            <span className="agent-activity-text">
              {/(subagent|sub-agent|子代理|delegate|task\b)/i.test(activeToolCall)
                ? `🤖 子代理运行中 · ${activeToolCall}`
                : `⚙️ 运行中 · ${activeToolCall}`}
            </span>
          </div>
        ) : (activityStatus || (isStreaming && messages.length > 0)) ? (
          <div className="message assistant">
            <div className="message-content">
              <div className="thinking-dots">
                <span /><span /><span />
              </div>
              {activityStatus && (
                <span className="activity-status-text">{activityStatus}</span>
              )}
            </div>
          </div>
        ) : null}

        {/* The tail indicator above is deliberately exclusive, and "⚙️ 运行中 · X"
            wins whenever a tool is open — which is exactly the state that hangs. A
            turn could therefore sit here for half an hour looking perfectly healthy
            and then get cut by the timeout with no warning at all. This sits BELOW
            the indicator so it shows in either branch, and main refreshes it every
            30s so the elapsed time never freezes. */}
        {isStreaming && stall && (() => {
          const dur = (s: number) => (s < 90 ? `${Math.max(1, Math.round(s))} 秒` : `${Math.round(s / 60)} 分钟`);
          return (
            <div className="stall-notice" role="status" aria-live="polite">
              <span className="stall-notice-icon" aria-hidden="true">⏳</span>
              <div className="stall-notice-copy">
                <strong>{`已 ${dur(stall.quietSeconds)}没有任何输出`}</strong>
                <span>
                  {stall.openTools > 0
                    ? `有 ${stall.openTools} 个工具调用还没有回报结束，已 ${dur(stall.toolIdleSeconds)}没有进度更新。长命令（构建、测试、解析大文件）本来就是这样 —— 实测过一个仍在 95% 占满一个核的例子。`
                    : '当前没有工具在跑 —— 这一轮既没有输出，也没有工具活动。'}
                  {stall.cpuBusy
                    ? ` 已向系统复查过：进程树仍在占用 CPU，说明它在算而不是卡在等待，所以中断被推后 —— 但这只证明没被阻塞，不证明有进展（死循环也一样烧 CPU），所以最多再等 ${dur(stall.cpuVetoLeftSeconds)}。`
                    : stall.interruptInSeconds === null
                      ? ' 超时中断已在设置里关闭，所以会一直等下去（按 Stop 可以自己结束）。'
                      : stall.interruptInSeconds > 0
                        ? ` 约 ${dur(stall.interruptInSeconds)}后会复查进程是否还在占用 CPU，确认没有才中断；已产出的内容会保留。`
                        : ' 正在复查进程是否还在占用 CPU…'}
                </span>
              </div>
            </div>
          );
        })()}

        <div ref={messagesEndRef} />
      </div>

      <div className="jump-to-bottom-anchor">
        {showJumpToBottom && (
          <button
            className="jump-to-bottom-btn"
            onClick={jumpToBottom}
            title="回到最新消息"
            aria-label="回到最新消息"
          >
            ↓ 最新
          </button>
        )}
      </div>

      {!readOnly && (
        <QueueStack
          queuedMessages={queuedMessages}
          onCancelQueuedMessage={onCancelQueuedMessage}
          onEditQueuedMessage={onEditQueuedMessage}
          onMoveQueuedMessage={onMoveQueuedMessage}
          mergeQueued={mergeQueuedMessages}
        />
      )}

      {/* Rendered from turnInterrupted — the SAME persistent state that disables the
          per-message Rerun buttons. It used to be explained only by `connectionError`,
          which is cleared in five places while the flag is cleared in two (reconnect
          and rerun clear the text but not the flag), so the restriction routinely
          outlived its explanation and the greyed-out button had nothing but a tooltip
          to justify it. Tying both to one state keeps them from disagreeing. */}
      {turnInterrupted && (
        <div className="interrupted-bar" role="region" aria-live="polite">
          <span className="interrupted-bar-icon" aria-hidden="true">↩</span>
          <div className="interrupted-bar-copy">
            <strong>上一轮被中断，还没有被覆盖</strong>
            <span>
              在下方输入框提交任意内容即可覆盖并重跑那一轮（被中断的原文已预填，可直接改）。
              在此之前，消息上的「编辑并重跑」会保持禁用 —— 这是刻意的：被中断的那一轮要用输入框覆盖，而不是逐条重跑。
            </span>
          </div>
        </div>
      )}


      {/* Monitor pane: no composer, but permission requests MUST stay actionable
          here — a background session's approval prompt was previously invisible
          until you switched to it, which stalled that session indefinitely. */}
      {readOnly && permissionRequest && (
        <div className="chat-input-area pane-permission-only">
          <PermissionBar request={permissionRequest} onRespond={onRespondPermission} />
        </div>
      )}

      {!readOnly && (
      <div className="input-resize-area">
        {!inputCollapsed && (
          <div
            className="input-resize-handle"
            onMouseDown={handleInputResizeStart}
            onDoubleClick={() => setInputHeight(140)}
            onKeyDown={(event) => {
              if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
              event.preventDefault();
              const delta = event.key === 'ArrowUp' ? 16 : -16;
              const maxHeight = Math.max(180, Math.floor(window.innerHeight * 0.7));
              setInputHeight((height) => Math.max(96, Math.min(maxHeight, height + delta)));
            }}
            role="separator"
            aria-label="Resize message composer"
            aria-orientation="horizontal"
            aria-valuemin={96}
            aria-valuemax={Math.max(180, Math.floor(window.innerHeight * 0.7))}
            aria-valuenow={inputHeight}
            tabIndex={0}
            title="Drag upward to enlarge · Double-click to reset"
          >
            <span className="input-resize-grip" />
          </div>
        )}
        <button
          className="input-collapse-btn"
          onClick={() => setInputCollapsed(!inputCollapsed)}
          title={inputCollapsed ? 'Show input' : 'Hide input'}
        >
          {inputCollapsed ? '▲' : '▼'}
        </button>
      </div>
      )}

      {!readOnly && !inputCollapsed && (
        <div
          className="chat-input-area"
          // minHeight, NOT height: in a narrow pane the belowbar wraps to two
          // rows and a fixed height clipped it, so the agent/model/usage
          // controls vanished. The composer keeps its own resize behaviour.
          style={{ minHeight: inputHeight }}
        >
          {isArchived ? (
            <div className="archived-composer-banner">
              <span>📥 This chat is archived — unarchive it to continue chatting.</span>
              {onUnarchive && (
                <button className="archived-unarchive-btn" onClick={onUnarchive}>♻️ Unarchive</button>
              )}
            </div>
          ) : (
            <>
              {permissionRequest && (
                <PermissionBar
                  request={permissionRequest}
                  onRespond={onRespondPermission}
                />
              )}
              <ChatInputBox
                sessionId={currentSessionId}
                isStreaming={isStreaming}
                isLooping={isLooping}
                status={status}
                sessionConnected={sessionConnected}
                permissionMode={permissionMode}
                onPermissionModeChange={onPermissionModeChange}
                onSend={onSend}
                onSteer={onSteerMessage}
                onCancel={onCancel}
                onStopLoop={onStopLoop}
                onQueueCommand={onQueueMessage}
                queuedMessages={queuedMessages}
                restoredDraft={restoredQueueDraft}
                restoredInputDraft={restoredInputDraft}
                onCancelQueuedMessage={onCancelQueuedMessage}
                onEditQueuedMessage={onEditQueuedMessage}
                onMoveQueuedMessage={onMoveQueuedMessage}
                commands={commands}
                showSuggestions={messages.length === 0}
                suggestions={messages.length === 0
                  ? PROMPT_SUGGESTIONS
                  // Stamp must match the current turn, else show nothing: stale chips
                  // read as current ones, and offering follow-ups to the PREVIOUS
                  // answer is worse than offering none for a moment.
                  : (dynamicSuggestions.key && dynamicSuggestions.key === currentTurnKey ? dynamicSuggestions.items : [])}
                onDropFiles={onDropFiles}
                onRemoveFile={onRemoveFile}
                attachedFiles={attachedFiles}
              />

              <div className="composer-belowbar">
                <div className="composer-belowbar-left">

                  <div
                    className="composer-agent-selector"
                    title="Agent (switching restarts this chat's executor with the selected Kiro agent)"
                  >
                    {agentConfigLoading && <span className="composer-agent-spinner">⏳</span>}
                    <select
                      className="composer-select composer-agent-select"
                      value={kiroAgent}
                      onChange={(event) => onKiroAgentChange(event.target.value)}
                      disabled={!currentSessionId || isStreaming || isLooping || switchingAgent || status !== 'connected'}
                      aria-label="Agent"
                    >
                      {kiroAgent && !kiroAgents.some((agent) => agent.name === kiroAgent) && (
                        <option value={kiroAgent}>{kiroAgent}</option>
                      )}
                      {kiroAgents.map((agent) => (
                        <option key={agent.name} value={agent.name}>
                          {agent.name}{agent.isDefault ? ' (default)' : ''}
                        </option>
                      ))}
                    </select>
                    {switchingAgent && <span className="composer-agent-spinner">⏳</span>}
                  </div>

                  <div className="import-context-wrapper">
                    <button
                      ref={importBtnRef}
                      className={`composer-meta-btn ${contextLinks.length > 0 ? 'active' : ''}`}
                      onClick={toggleImportPicker}
                      title="Sync context from other sessions"
                      disabled={importableSessions.length === 0}
                    >
                      🛠️ <span className="composer-meta-label">Context Engineering</span>
                      {contextLinks.length > 0 && <span className="composer-meta-count">{contextLinks.length}</span>}
                    </button>
                    {/* Portal to <body>: `.chat-main` now sets container-type for the
                        composer's container queries, and container-type implies
                        contain:layout, which makes it the containing block for
                        position:fixed children. Without the portal this panel was
                        offset by the pane's own x (it flew off screen in a
                        right-hand split pane). */}
                    {showImportPicker && createPortal(
                      <>
                        <div className="import-picker-overlay" onClick={() => setShowImportPicker(false)} />
                        <div className="import-picker" style={{ left: pickerPos.left, bottom: pickerPos.bottom }}>
                          <div className="import-picker-header">
                            <span>Select context to sync</span>
                          </div>
                          <div className="import-picker-list">
                            {importableSessions.length === 0 ? (
                              <div className="import-picker-empty">No other sessions available</div>
                            ) : (
                              importableSessions.map((session) => {
                                const linked = contextLinks.some((link) => link.sourceId === session.id);
                                return (
                                  <button
                                    key={session.id}
                                    className={`import-picker-item ${linked ? 'active' : ''}`}
                                    title={session.title}
                                    onClick={() => onToggleContextSource(session.id)}
                                  >
                                    <span className="import-picker-box">{linked ? '☑' : '☐'}</span>
                                    <span className="import-picker-title">{session.title || 'Untitled'}</span>
                                  </button>
                                );
                              })
                            )}
                          </div>
                        </div>
                      </>,
                      document.body,
                    )}
                  </div>
                </div>

                <div className="composer-belowbar-right">
                  {isStreaming && activeToolCall ? (
                    <span className="composer-tool-status" title={activeToolCall}>⚙️ {activeToolCall}</span>
                  ) : usage ? (
                    <>
                      <button
                        type="button"
                        className={`composer-usage composer-usage-action ${usage.contextPercent >= 80 ? 'high' : usage.contextPercent >= 50 ? 'mid' : ''}`}
                        onClick={onManageContext}
                        disabled={!currentSessionId || isStreaming}
                        title={`Manage context · currently ${usage.contextPercent.toFixed(1)}% used`}
                      >
                        <span className="composer-usage-bar">
                          <span className="composer-usage-fill" style={{ width: `${Math.min(100, Math.max(0, usage.contextPercent))}%` }} />
                        </span>
                        <span className="composer-usage-label">{usage.contextPercent.toFixed(0)}%</span>
                      </button>
                      <button
                        type="button"
                        className="composer-credits composer-usage-action"
                        onClick={onResetCredits}
                        disabled={!currentSessionId || isStreaming}
                        title="Reset this session's local Credits counter"
                      >
                        {usage.credits.toFixed(2)} credits
                      </button>
                    </>
                  ) : null}

                  <select
                    className="composer-select composer-model-select"
                    value={selectedModel}
                    onChange={(event) => onModelChange(event.target.value)}
                    disabled={!currentSessionId || isStreaming || isLooping || switchingModel || status !== 'connected'}
                    title={isStreaming
                      ? 'Wait for the current response to finish before switching models'
                      : switchingModel
                      ? 'Wait for the current model change to finish'
                      : 'Model'}
                  >
                    {models.length > 0 ? (
                      <>
                        {/* The executor binds --model at spawn, so a session can hold a
                            model this account cannot use (a retired id, or a stale
                            hardcoded default). A <select> whose value matches no option
                            silently shows the FIRST one, so the composer claimed
                            "gpt-5.6-sol" while the request actually ran
                            "claude-sonnet-4.6" and failed. Surfacing the real value as a
                            non-selectable option keeps the selector honest. */}
                        {selectedModel && !models.some((model) => model.model_id === selectedModel) ? (
                          <option value={selectedModel} disabled>
                            {selectedModel} · unavailable
                          </option>
                        ) : null}
                        {models.map((model) => (
                          <option key={model.model_id} value={model.model_id}>
                            {model.model_name}{model.context_window_tokens ? ` · ${fmtContextWindow(model.context_window_tokens)}` : ''}
                          </option>
                        ))}
                      </>
                    ) : (
                      <option value={selectedModel || 'auto'}>{selectedModel || 'auto'}</option>
                    )}
                  </select>
                  {switchingModel && <span className="composer-agent-spinner">⏳</span>}
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {loopSetup && createPortal(
        <>
          <div className="overlay" onClick={() => setLoopSetup(null)} />
          <div className="loop-dialog" role="dialog" aria-modal="true" aria-labelledby="loop-dialog-title">
            <h3 id="loop-dialog-title">🔁 循环重发此消息</h3>
            <div className="loop-dialog-preview">{loopSetup.text}</div>
            <label className="loop-dialog-field">
              <span>间隔秒数，填 0 表示每轮结束后立即重发</span>
              <input
                type="text"
                inputMode="numeric"
                placeholder="0"
                autoFocus
                value={loopSeconds}
                onChange={(event) => setLoopSeconds(event.target.value.replace(/[^0-9]/g, ''))}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    onStartLoop(loopSetup.text, Number.parseInt(loopSeconds, 10) || 0);
                    setLoopSetup(null);
                  } else if (event.key === 'Escape') {
                    setLoopSetup(null);
                  }
                }}
              />
            </label>
            <div className="loop-dialog-actions">
              <button className="loop-dialog-cancel" onClick={() => setLoopSetup(null)}>取消</button>
              <button
                className="loop-dialog-start"
                onClick={() => {
                  onStartLoop(loopSetup.text, Number.parseInt(loopSeconds, 10) || 0);
                  setLoopSetup(null);
                }}
              >
                开始循环
              </button>
            </div>
          </div>
        </>,
        document.body,
      )}

      {agentConfigEditor && createPortal(
        <>
          <div className="overlay" onClick={closeAgentConfig} />
          <div
            className="agent-config-editor-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="agent-config-editor-title"
          >
            <div className="settings-header">
              <div className="agent-config-editor-title">
                <IconRobot size={17} />
                <h3 id="agent-config-editor-title">Kiro Agent configurations</h3>
              </div>
              <button className="settings-close" onClick={closeAgentConfig} aria-label="Close">✕</button>
            </div>
            <div className="agent-config-editor-workspace">
              <aside className="agent-config-agent-list" aria-label="Kiro Agents">
                <div className="agent-config-agent-list-header">
                  All Agents <span>{agentConfigAgents.length}</span>
                </div>
                {agentConfigAgents.map((agent) => {
                  const draft = agentConfigDrafts[agent.name];
                  const hasUnsavedDraft = !!draft &&
                    !draft.error &&
                    draft.content !== draft.initialContent;
                  return (
                    <button
                      key={agent.name}
                      className={`agent-config-agent-item ${agentConfigEditor.agentName === agent.name ? 'active' : ''}`}
                      onClick={() => void loadAgentConfig(agent.name)}
                      disabled={agentConfigLoading}
                      title={agent.source === 'built-in'
                        ? `${agent.name} is built in and cannot be edited`
                        : hasUnsavedDraft
                        ? `${agent.name} has an unsaved in-memory draft`
                        : `Edit ${agent.name}`}
                    >
                      <span className="agent-config-agent-name">
                        {agent.source === 'built-in' ? '🔒' : '🤖'} {agent.name}
                      </span>
                      <span className="agent-config-agent-badges">
                        {hasUnsavedDraft && <span className="unsaved">Unsaved</span>}
                        {agent.isDefault && <span className="default">Default</span>}
                        <span>{agent.source === 'built-in'
                          ? 'Built-in'
                          : agent.source === 'global' ? 'Global' : 'Local'}</span>
                      </span>
                    </button>
                  );
                })}
              </aside>

              <div className="agent-config-editor-body">
                <div className="agent-config-editor-selection">
                  <strong>{agentConfigEditor.agentName}</strong>
                  {!agentConfigLoading && !agentConfigEditor.error && (
                    <span className="agent-config-editor-path" title={agentConfigEditor.path}>
                      {agentConfigEditor.path}
                    </span>
                  )}
                </div>

                {agentConfigLoading ? (
                  <div className="agent-config-editor-message">Loading configuration…</div>
                ) : agentConfigEditor.error ? (
                  <div className="agent-config-editor-message error">
                    <IconRobot size={22} />
                    <strong>This Agent cannot be edited</strong>
                    <span>{agentConfigEditor.error}</span>
                  </div>
                ) : (
                  <>
                    <div className={`agent-config-editor-shell ${agentConfigValidationError ? 'invalid' : 'valid'}`}>
                      <div
                        ref={agentConfigLineNumbersRef}
                        className="agent-config-line-numbers"
                        aria-hidden="true"
                      >
                        {agentConfigLines.map((_, index) => {
                          const lineNumber = index + 1;
                          const isErrorLine = agentConfigValidationError?.line === lineNumber;
                          return (
                            <span
                              key={lineNumber}
                              className={isErrorLine ? 'error' : ''}
                              title={isErrorLine ? 'JSON error on this line' : undefined}
                            >
                              {lineNumber}
                            </span>
                          );
                        })}
                      </div>
                      <textarea
                        ref={agentConfigTextareaRef}
                        className="agent-config-editor-textarea"
                        value={agentConfigEditor.content}
                        onChange={(event) => updateAgentConfigContent(event.target.value)}
                        onScroll={(event) => {
                          if (agentConfigLineNumbersRef.current) {
                            agentConfigLineNumbersRef.current.scrollTop = event.currentTarget.scrollTop;
                          }
                        }}
                        onKeyDown={(event) => {
                          if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
                            event.preventDefault();
                            void saveAgentConfig();
                          } else if (event.key === 'Escape') {
                            event.preventDefault();
                            closeAgentConfig();
                          }
                        }}
                        aria-invalid={!!agentConfigValidationError}
                        spellCheck={false}
                        autoFocus
                      />
                    </div>
                    {agentConfigValidationError ? (
                      <button
                        type="button"
                        className="agent-config-validation invalid"
                        onClick={focusAgentConfigError}
                        title="Jump to the JSON error"
                      >
                        <strong>
                          Line {agentConfigValidationError.line}, column {agentConfigValidationError.column}
                        </strong>
                        <span>{agentConfigValidationError.message}</span>
                      </button>
                    ) : (
                      <div className="agent-config-validation valid">
                        ✓ Valid JSON · {agentConfigLines.length} lines
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
            <div className="agent-config-editor-actions">
              {agentConfigStatus && (
                <span className={agentConfigStatus === 'Saved' ? 'saved' : 'error'}>
                  {agentConfigStatus}
                </span>
              )}
              <button
                className="btn deny"
                onClick={formatAgentConfig}
                disabled={
                  agentConfigLoading ||
                  !!agentConfigEditor.error ||
                  !!agentConfigValidationError ||
                  agentConfigSaving
                }
                title="Format with two-space indentation"
              >
                Format JSON
              </button>
              <button className="btn deny" onClick={closeAgentConfig}>Close</button>
              <button
                className="btn allow"
                onClick={() => void saveAgentConfig()}
                disabled={
                  agentConfigLoading ||
                  !!agentConfigEditor.error ||
                  !!agentConfigValidationError ||
                  agentConfigSaving ||
                  agentConfigEditor.content === agentConfigEditor.initialContent
                }
              >
                {agentConfigSaving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </>,
        document.body,
      )}
      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
    </div>
  );
};
