import React from 'react';
import type { Settings } from '../App';

interface SettingsDialogProps {
  settings: Settings;
  onChange: (settings: Settings) => void;
  onClose: () => void;
  confirmDeletes: boolean;
  onConfirmDeletesChange: (value: boolean) => void;
}

export const SettingsDialog: React.FC<SettingsDialogProps> = ({
  settings,
  onChange,
  onClose,
  confirmDeletes,
  onConfirmDeletesChange,
}) => {
  return (
    <>
      <div className="overlay" onClick={onClose} />
      <div className="settings-dialog">
        <div className="settings-header">
          <h3>⚙️ Settings</h3>
          <button className="settings-close" onClick={onClose}>✕</button>
        </div>

        <div className="settings-body">
          <div className="settings-item">
            <label className="settings-label">Font Size</label>
            <div className="settings-control">
              <button
                className="settings-btn"
                onClick={() => onChange({ ...settings, fontSize: Math.max(10, settings.fontSize - 1) })}
              >
                −
              </button>
              <span className="settings-value">{settings.fontSize}px</span>
              <button
                className="settings-btn"
                onClick={() => onChange({ ...settings, fontSize: Math.min(22, settings.fontSize + 1) })}
              >
                +
              </button>
            </div>
          </div>

          <div className="settings-item">
            <label className="settings-label">Confirm before deleting chats</label>
            <div className="settings-control">
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={confirmDeletes}
                  onChange={(e) => onConfirmDeletesChange(e.target.checked)}
                />
                <span className="settings-value">{confirmDeletes ? 'On' : 'Off'}</span>
              </label>
            </div>
          </div>

          <div className="settings-item">
            <label className="settings-label">Preview</label>
            <p className="settings-preview" style={{ fontSize: settings.fontSize }}>
              The quick brown fox jumps over the lazy dog.
            </p>
          </div>
        </div>
      </div>
    </>
  );
};
