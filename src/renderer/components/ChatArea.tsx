import React, { useRef, useEffect, useState, useCallback, useMemo, memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import 'highlight.js/styles/github-dark.css';
import type { Message, AttachedFile } from '../App';

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
    <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
      {rendered}
    </ReactMarkdown>
  );
};

// Memoized message item: only re-renders when its own content/streaming state changes
const MessageItem = memo<{
  msg: Message;
  isLastAssistant: boolean;
  isStreaming: boolean;
}>(({ msg, isLastAssistant, isStreaming }) => (
  <div className={`message ${msg.role}`}>
    <div className="message-content">
      {msg.role === 'user' ? (
        <p>{msg.content}</p>
      ) : (
        <>
          {isStreaming && isLastAssistant ? (
            msg.content ? (
              <div className="streaming-content">
                <ThrottledMarkdown content={msg.content} interval={150} />
              </div>
            ) : null
          ) : (
            <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
              {msg.content}
            </ReactMarkdown>
          )}
        </>
      )}
    </div>
    {msg.role === 'user' && msg.attachments && msg.attachments.length > 0 && (
      <div className="message-attachments">
        {msg.attachments.map((file) => (
          <div key={file.id} className="message-attachment-item" title={file.path}>
            <span className="message-attachment-icon">
              {file.path.endsWith('/') || file.path.endsWith('\\') || !file.name.includes('.') ? '📁' : '📄'}
            </span>
            <span className="message-attachment-name">{file.name}</span>
          </div>
        ))}
      </div>
    )}
  </div>
));

// Isolated input component: does NOT receive `messages` prop, so it never
// re-renders due to streaming chunks. This is the primary fix for input lag.
const ChatInputBox = memo<{
  isStreaming: boolean;
  status: 'disconnected' | 'connecting' | 'connected';
  onSend: (text: string) => void;
  onCancel: () => void;
  onQueueCommand: (text: string) => void;
  onDropFiles: (files: AttachedFile[]) => void;
  attachedFiles: AttachedFile[];
}>(({ isStreaming, status, onSend, onCancel, onQueueCommand, onDropFiles, attachedFiles }) => {
  const [input, setInput] = useState('');
  const [isComposing, setIsComposing] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleSend = useCallback(() => {
    const text = input.trim();
    if (!text) return;
    if (text === '/stop') {
      setInput('');
      onSend(text);
      return;
    }
    if (isStreaming) return;
    setInput('');
    onSend(text);
  }, [input, isStreaming, onSend]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (isComposing || e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      const text = input.trim();
      if (text) {
        onQueueCommand(text);
        setInput('');
      }
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }, [isComposing, input, onQueueCommand, handleSend]);

  const handlePaste = useCallback(async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = Array.from(e.clipboardData?.items || []);
    const hasImage = items.some((i) => i.kind === 'file' && i.type.startsWith('image/'));
    if (!hasImage) return;
    e.preventDefault();
    try {
      const res = await window.kiroApi.saveClipboardImage();
      if (!res) return;
      const n = attachedFiles.filter((f) => f.isImage).length + 1;
      onDropFiles([
        { id: `img_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, name: `Screenshot ${n}`, path: res.path, isImage: true, preview: res.thumbnail },
      ]);
    } catch {}
  }, [attachedFiles, onDropFiles]);

  return (
    <div className="chat-input-wrapper">
      <textarea
        ref={textareaRef}
        className="chat-input"
        placeholder={
          status !== 'connected'
            ? 'Connecting... (type /stop to force reconnect)'
            : isStreaming
            ? 'Generating... (type /stop to force interrupt)'
            : 'Type a message... (Enter to send, Shift+Enter for newline)'
        }
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        onCompositionStart={() => setIsComposing(true)}
        onCompositionEnd={() => setIsComposing(false)}
        rows={3}
      />
      {isStreaming && (
        <button
          className="stop-btn"
          onClick={onCancel}
          title="Stop"
        >
          <span className="stop-btn-square"></span>
        </button>
      )}
    </div>
  );
});

interface ChatAreaProps {
  messages: Message[];
  isStreaming: boolean;
  status: 'disconnected' | 'connecting' | 'connected';
  connectionError: string | null;
  attachedFiles: AttachedFile[];
  models: any[];
  selectedModel: string;
  activeToolCall: string | null;
  usage: { contextPercent: number; credits: number; turnMs?: number } | null;
  onModelChange: (model: string) => void;
  onSend: (text: string) => void;
  onCancel: () => void;
  onDropFiles: (files: AttachedFile[]) => void;
  onRemoveFile: (id: string) => void;
  currentSessionId: string | null;
  isArchived?: boolean;
  onUnarchive?: () => void;
  commandQueue: string[];
  onQueueCommand: (text: string) => void;
  onRemoveQueuedCommand: (index: number) => void;
  importableSessions: { id: string; title: string }[];
  contextLinks: { sourceId: string; sourceTitle: string }[];
  onToggleContextSource: (sourceSessionId: string) => void;
}

export const ChatArea: React.FC<ChatAreaProps> = ({
  messages,
  isStreaming,
  status,
  connectionError,
  attachedFiles,
  models,
  selectedModel,
  activeToolCall,
  usage,
  onModelChange,
  onSend,
  onCancel,
  onDropFiles,
  onRemoveFile,
  currentSessionId,
  isArchived,
  onUnarchive,
  commandQueue,
  onQueueCommand,
  onRemoveQueuedCommand,
  importableSessions,
  contextLinks,
  onToggleContextSource,
}) => {
  const [isDragOver, setIsDragOver] = useState(false);
  const [showQueue, setShowQueue] = useState(false);
  const [showImportPicker, setShowImportPicker] = useState(false);
  const [pickerPos, setPickerPos] = useState<{ left: number; bottom: number }>({ left: 0, bottom: 0 });
  const importBtnRef = useRef<HTMLButtonElement>(null);

  const toggleImportPicker = useCallback(() => {
    const el = importBtnRef.current;
    if (el) {
      const r = el.getBoundingClientRect();
      // Anchor a fixed-position popup just above the button so it escapes the
      // overflow:hidden clipping of the chat input / main containers.
      setPickerPos({ left: r.left, bottom: window.innerHeight - r.top + 8 });
    }
    setShowImportPicker((v) => !v);
  }, []);
  const [inputHeight, setInputHeight] = useState(() => {
    try {
      const saved = localStorage.getItem('kirolex-input-height');
      if (saved) return parseInt(saved, 10);
    } catch {}
    return 140;
  });
  const [inputCollapsed, setInputCollapsed] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const chatMessagesRef = useRef<HTMLDivElement>(null);
  const dragCounterRef = useRef(0);
  const inputResizingRef = useRef(false);

  const handleInputResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    inputResizingRef.current = true;
    const startY = e.clientY;
    const startHeight = inputHeight;

    const onMouseMove = (ev: MouseEvent) => {
      if (!inputResizingRef.current) return;
      const newHeight = Math.max(60, Math.min(500, startHeight - (ev.clientY - startY)));
      setInputHeight(newHeight);
    };

    const onMouseUp = () => {
      inputResizingRef.current = false;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      try {
        localStorage.setItem('kirolex-input-height', String(inputHeight));
      } catch {}
    };

    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, [inputHeight]);

  useEffect(() => {
    try {
      localStorage.setItem('kirolex-input-height', String(inputHeight));
    } catch {}
  }, [inputHeight]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'instant' });
  }, [messages]);

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
    const attached: AttachedFile[] = files.map((f) => ({
      id: `file_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      name: f.name,
      path: (f as any).path || f.name,
    }));
    onDropFiles(attached);
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

  return (
    <div
      className={`chat-main ${isDragOver ? 'drag-over' : ''}`}
      onDrop={handleDrop}
      onDragOver={handleDragOver}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
    >
      {isDragOver && (
        <div className="drop-overlay">
          <div className="drop-overlay-content">
            📎 Drop files to attach
          </div>
        </div>
      )}

      <div className="chat-messages" ref={chatMessagesRef}>
        {messages.length === 0 && (
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

        {messages.map((msg, idx) => (
          <MessageItem
            key={`${currentSessionId ?? 'none'}:${msg.id}:${idx}`}
            msg={msg}
            isLastAssistant={msg.role === 'assistant' && idx === messages.length - 1}
            isStreaming={isStreaming}
          />
        ))}

        {isStreaming && messages.length > 0 && messages[messages.length - 1]?.role === 'user' && (
          <div className="message assistant">
            <div className="message-content">
              <div className="thinking-dots">
                <span /><span /><span />
              </div>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      <div className="input-resize-area">
        {!inputCollapsed && (
          <div className="input-resize-handle" onMouseDown={handleInputResizeStart} />
        )}
        <button
          className="input-collapse-btn"
          onClick={() => setInputCollapsed(!inputCollapsed)}
          title={inputCollapsed ? 'Show input' : 'Hide input'}
        >
          {inputCollapsed ? '▲' : '▼'}
        </button>
      </div>

      {!inputCollapsed && (
      <>
      {attachedFiles.length > 0 && (
        <div className="attached-files-bar">
          <div className="attached-files">
            {attachedFiles.map((f) => (
              <div key={f.id} className={`attached-file-chip ${f.isImage ? 'is-image' : ''}`} title={f.path}>
                {f.isImage && f.preview ? (
                  <img className="attached-file-thumb" src={f.preview} alt={f.name} />
                ) : (
                  <span className="attached-file-icon">
                    {f.path.endsWith('/') || f.path.endsWith('\\') || !f.name.includes('.') ? '📁' : '📄'}
                  </span>
                )}
                <span className="attached-file-name">{f.name}</span>
                <button
                  className="attached-file-remove"
                  onClick={() => onRemoveFile(f.id)}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        </div>
        )}
        <div className="chat-input-area" style={{ height: inputHeight }}>
        {isArchived ? (
          <div className="archived-composer-banner">
            <span>📥 This chat is archived — unarchive it to continue chatting.</span>
            {onUnarchive && (
              <button className="archived-unarchive-btn" onClick={onUnarchive}>♻️ Unarchive</button>
            )}
          </div>
        ) : (
        <ChatInputBox
          isStreaming={isStreaming}
          status={status}
          onSend={onSend}
          onCancel={onCancel}
          onQueueCommand={onQueueCommand}
          onDropFiles={onDropFiles}
          attachedFiles={attachedFiles}
        />
        )}
        {/* Model selector and tool status below input */}
        <div className="input-model-row">
          <div className="input-model-left">
          <select
            className="input-model-select"
            value={selectedModel}
            onChange={(e) => onModelChange(e.target.value)}
          >
            {models.length > 0 ? (
              models.map((m) => (
                <option key={m.model_id} value={m.model_id}>
                  {m.model_name}
                </option>
              ))
            ) : (
              <>
                <option value="auto">auto</option>
                <option value="claude-opus-4.8">claude-opus-4.8</option>
                <option value="claude-sonnet-4.6">claude-sonnet-4.6</option>
                <option value="claude-haiku-4.5">claude-haiku-4.5</option>
              </>
            )}
          </select>
          <div className="import-context-wrapper">
            <button
              ref={importBtnRef}
              className={`import-context-btn ${contextLinks.length > 0 ? 'active' : ''}`}
              onClick={toggleImportPicker}
              title="Sync context from other sessions"
              disabled={importableSessions.length === 0}
            >
              🛠️ Context Engineering
            </button>
            {showImportPicker && (
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
                      importableSessions.map((s) => {
                        const linked = contextLinks.some((l) => l.sourceId === s.id);
                        return (
                          <button
                            key={s.id}
                            className={`import-picker-item ${linked ? 'active' : ''}`}
                            title={s.title}
                            onClick={() => onToggleContextSource(s.id)}
                          >
                            <span className="import-picker-box">{linked ? '☑' : '☐'}</span>
                            <span className="import-picker-title">{s.title || 'Untitled'}</span>
                          </button>
                        );
                      })
                    )}
                  </div>
                </div>
              </>
            )}
          </div>
          {commandQueue.length > 0 && (
            <div className="queue-indicator-wrapper">
              <button
                className="queue-indicator-btn"
                onClick={() => setShowQueue((v) => !v)}
                title="Queued commands"
              >
                ⏳ Queued: {commandQueue.length}
              </button>
              {showQueue && (
                <>
                  <div className="queue-popup-overlay" onClick={() => setShowQueue(false)} />
                  <div className="queue-popup">
                    <div className="queue-popup-header">
                      <span>Queued Commands ({commandQueue.length})</span>
                      <button className="queue-popup-close" onClick={() => setShowQueue(false)}>✕</button>
                    </div>
                    <div className="queue-popup-list">
                      {commandQueue.map((cmd, i) => (
                        <div key={i} className="queue-popup-item">
                          <span className="queue-popup-index">{i + 1}.</span>
                          <span className="queue-popup-text" title={cmd}>{cmd}</span>
                          <button
                            className="queue-popup-remove"
                            onClick={() => onRemoveQueuedCommand(i)}
                            title="Remove"
                          >
                            ✕
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                </>
              )}
            </div>
          )}
          </div>
          {activeToolCall && (
            <span className="active-tool-status">
              ⚙️ {activeToolCall}
            </span>
          )}
          {!activeToolCall && usage && (
            <span className="usage-info">
              📊 {usage.credits.toFixed(2)} credits · {usage.contextPercent.toFixed(0)}% context
            </span>
          )}
        </div>
      </div>
      </>
      )}
    </div>
  );
};
