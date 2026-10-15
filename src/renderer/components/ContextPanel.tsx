import React, { useRef } from 'react';

interface ContextItem {
  id: string;
  type: 'file' | 'folder' | 'url' | 'text';
  name: string;
  path?: string;
  content: string;
}

interface ContextPanelProps {
  items: ContextItem[];
  onAdd: (item: ContextItem) => void;
  onRemove: (id: string) => void;
  onToggle: () => void;
}

export const ContextPanel: React.FC<ContextPanelProps> = ({
  items,
  onAdd,
  onRemove,
  onToggle,
}) => {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;

    Array.from(files).forEach((file) => {
      const reader = new FileReader();
      reader.onload = () => {
        onAdd({
          id: `ctx_${Date.now()}_${Math.random().toString(36).slice(2)}`,
          type: 'file',
          name: file.name,
          path: (file as any).path || file.name,
          content: reader.result as string,
        });
      };
      reader.readAsText(file);
    });

    // Reset input
    e.target.value = '';
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const files = e.dataTransfer.files;
    
    Array.from(files).forEach((file) => {
      const reader = new FileReader();
      reader.onload = () => {
        onAdd({
          id: `ctx_${Date.now()}_${Math.random().toString(36).slice(2)}`,
          type: 'file',
          name: file.name,
          path: (file as any).path || file.name,
          content: reader.result as string,
        });
      };
      reader.readAsText(file);
    });
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };

  const handleAddText = () => {
    const text = prompt('Enter text context:');
    if (text) {
      onAdd({
        id: `ctx_${Date.now()}`,
        type: 'text',
        name: text.slice(0, 30) + (text.length > 30 ? '...' : ''),
        content: text,
      });
    }
  };

  const getIcon = (type: string) => {
    switch (type) {
      case 'file': return '📄';
      case 'folder': return '📁';
      case 'url': return '🔗';
      case 'text': return '📝';
      default: return '📎';
    }
  };

  return (
    <div className="context-panel" onDrop={handleDrop} onDragOver={handleDragOver}>
      <div className="context-panel-header">
        <h3>📎 Context</h3>
        <button
          onClick={onToggle}
          style={{
            background: 'none',
            border: 'none',
            color: 'var(--text-muted)',
            cursor: 'pointer',
            fontSize: 16,
          }}
        >
          ✕
        </button>
      </div>

      <div className="context-items">
        {items.length === 0 && (
          <p style={{
            textAlign: 'center',
            color: 'var(--text-muted)',
            fontSize: 12,
            padding: '24px 16px',
            lineHeight: 1.6,
          }}>
            Drag & drop files here, or click "Add" below to include context for your conversations.
          </p>
        )}

        {items.map((item) => (
          <div key={item.id} className="context-item">
            <span className="icon">{getIcon(item.type)}</span>
            <span className="name" title={item.path || item.name}>
              {item.name}
            </span>
            <button
              className="remove-btn"
              onClick={() => onRemove(item.id)}
              title="Remove"
            >
              ✕
            </button>
          </div>
        ))}
      </div>

      <div style={{ padding: '8px', borderTop: '1px solid var(--border)' }}>
        <button
          className="add-context-btn"
          onClick={() => fileInputRef.current?.click()}
        >
          + Add File
        </button>
        <button
          className="add-context-btn"
          onClick={handleAddText}
          style={{ marginTop: 4 }}
        >
          + Add Text
        </button>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        multiple
        style={{ display: 'none' }}
        onChange={handleFileSelect}
      />
    </div>
  );
};
