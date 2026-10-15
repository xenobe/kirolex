import { LANG_OPTIONS, normalizeLang } from '../i18n';
import { useT } from '../hooks/useLang';
import React from 'react';
import { useEffect, useState } from 'react';
import type { Settings } from '../App';

interface SettingsDialogProps {
  settings: Settings;
  onChange: (settings: Settings) => void;
  onClose: () => void;
  confirmDeletes: boolean;
  onConfirmDeletesChange: (value: boolean) => void;
}

// Font choices. Empty value = keep the app default stack. Only fonts that ship
// with macOS/Windows are offered as presets; anything else goes in the custom field.
const CUSTOM_FONT = '__custom__';
const FONT_PRESETS: Array<{ label: string; value: string }> = [
  { label: 'System default', value: '' },
  { label: 'PingFang SC / 苹方', value: "'PingFang SC', -apple-system, sans-serif" },
  { label: 'Hiragino Sans GB / 冬青黑', value: "'Hiragino Sans GB', 'PingFang SC', sans-serif" },
  { label: 'Songti SC / 宋体', value: "'Songti SC', 'Times New Roman', serif" },
  { label: 'Helvetica Neue', value: "'Helvetica Neue', Helvetica, Arial, sans-serif" },
  { label: 'Segoe UI', value: "'Segoe UI', Tahoma, sans-serif" },
  { label: 'Microsoft YaHei / 微软雅黑', value: "'Microsoft YaHei', 'PingFang SC', sans-serif" },
];
const MONO_PRESETS: Array<{ label: string; value: string }> = [
  { label: 'Default mono', value: '' },
  { label: 'SF Mono', value: "'SF Mono', ui-monospace, monospace" },
  { label: 'Menlo', value: 'Menlo, monospace' },
  { label: 'Monaco', value: 'Monaco, monospace' },
  { label: 'JetBrains Mono', value: "'JetBrains Mono', Menlo, monospace" },
  { label: 'Fira Code', value: "'Fira Code', Menlo, monospace" },
  { label: 'Consolas', value: 'Consolas, monospace' },
];

/** ALL boolean behaviour switches, in ONE list.
 *
 *  They used to be split across two blocks with nothing to tell them apart: four
 *  ("自动重发", "Merge queued", the two auto-folds) plus "Confirm before deleting"
 *  sat as individual rows, and seven more lived under a separate "功能开关" heading.
 *  Same kind of control, same kind of decision, two places -- and one of them
 *  (自动重发) was even a duplicate of a switch proposed for the other list.
 *
 *  `store` says who owns the value, which is the only real difference left:
 *    'feature'  -> ~/.kirolex/config.json `features`, read by the MAIN process too
 *    'settings' -> the renderer Settings object (now on disk via ui-state.json)
 *    'prop'     -> owned by App (delete confirmation)
 *  All three are durable and all three apply immediately; the split is an
 *  implementation detail and must not leak into the UI.
 *
 *  Labels state what the switch DOES; `help` states what turning it OFF means,
 *  because that is the decision being made. */
type SwitchStore = 'feature' | 'settings' | 'prop';
const SWITCH_GROUPS = ['上下文与历史', '对话与输入', '界面', '安全'] as const;
const SWITCHES: Array<{
  key: string; store: SwitchStore; group: typeof SWITCH_GROUPS[number]; label: string; help: string;
}> = [
  { key: 'rideAlongContext', store: 'feature', group: '上下文与历史',
    label: 'Send history context along with the message (no extra turn)',
    help: '开：重启后第一条消息附带历史快照，不花额外的模型回合。关：改回“先跑一次重建回合再发消息”。' },
  { key: 'historyFileRefresh', store: 'feature', group: '上下文与历史',
    label: 'Refresh history.md every turn',
    help: '开：每个回合结束立刻重写完整历史文件，模型随时读到的都是最新的。关：只在重建时写一次，之后会滞后。' },
  { key: 'memoryInjection', store: 'feature', group: '上下文与历史',
    label: 'Inject memory (global / project / this chat)',
    help: '开：每一轮都带上 ~/.kirolex/memory 的内容（约 1.3k 字符），所以「每次回复都要…」这类规则每轮都成立。关：模型完全看不到这些背景。' },
  { key: 'recoverInterruptedTurns', store: 'settings', group: '上下文与历史',
    label: 'Resend an unanswered prompt after a restart',
    help: '开：打开某会话时，若上次运行最后一轮没收到回复，自动截断并重发那一轮（会消耗额度），每次运行每会话最多一次。关：那一轮就留在原处，由你决定要不要重发。' },
  { key: 'pasteFolding', store: 'feature', group: '对话与输入',
    label: 'Fold large pastes to disk',
    help: '开：很长的粘贴内容存到 ~/.kirolex/pastes 并在输入框显示占位符（单行需超过 4000 字符才折叠）。关：粘贴内容一律直接进输入框。' },
  { key: 'mergeQueuedMessages', store: 'settings', group: '对话与输入',
    label: 'Merge queued messages into one',
    help: '开：排队的多条消息在发送时合并为一条。关：逐条依次发送，各自占一个回合。' },
  { key: 'promptSuggestions', store: 'feature', group: '对话与输入',
    label: 'Show starter prompts when the composer is empty',
    help: '开：输入框为空时显示可点击的起始提示。关：不显示，也不为此调用辅助模型。' },
  { key: 'smartTitle', store: 'feature', group: '对话与输入',
    label: 'Generate chat titles automatically',
    help: '开：用辅助模型给新会话起标题。关：保持 New Chat——注意标题相同的会话在侧栏难以区分，曾因此误删过一个会话。' },
  { key: 'splitDragResize', store: 'feature', group: '界面',
    label: 'Draggable pane dividers',
    help: '开：格子之间有可拖动的分隔线（双击恢复均分）。关：固定均分，分隔线仍在但不可拖。' },
  { key: 'autoFoldThinking', store: 'settings', group: '界面',
    label: 'Auto-fold thinking when it finishes (💭 thinking)',
    help: '开：思考段落结束后自动收起。关：一直展开。' },
  { key: 'autoFoldTools', store: 'settings', group: '界面',
    label: 'Auto-fold tool calls when they finish (🔧 tool)',
    help: '开：工具调用结束后自动收起。关：一直展开。' },
  { key: 'confirmDeletes', store: 'prop', group: '安全',
    label: 'Confirm before deleting chats',
    help: '开：删除会话前弹确认框。关：点了就删——删除现在会移到 ~/.kirolex/trash 保留 30 天，但仍建议保持开启。' },
];

export const SettingsDialog: React.FC<SettingsDialogProps> = ({
  settings,
  onChange,
  onClose,
  confirmDeletes,
  onConfirmDeletesChange,
}) => {
  const t = useT();
  // Executor cap (max concurrent connected sessions). 0/'' in the input = auto.
  const [capInfo, setCapInfo] = useState<{ cap: number; auto: number; overridden: boolean } | null>(null);
  const [capInput, setCapInput] = useState('');
  // Wedge-interrupt threshold in seconds. '' while loading, '0' = never interrupt.
  const [wedgeInput, setWedgeInput] = useState('');
  const [wedgeBounds, setWedgeBounds] = useState<{ min: number; max: number; default: number } | null>(null);
  // How long an open tool call may go un-updated before it stops counting as progress.
  const [toolStallInput, setToolStallInput] = useState('');
  const [toolStallBounds, setToolStallBounds] = useState<{ min: number; max: number; default: number } | null>(null);
  // Live feature flags, owned by main (~/.kirolex/config.json). Re-read on open so
  // the panel never shows a value the rest of the app has already moved past.
  const [features, setFeatures] = useState<Record<string, boolean>>({});
  const [featureBusy, setFeatureBusy] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await window.kiroApi.getFeatures?.();
        if (!cancelled && res?.flags) setFeatures(res.flags);
      } catch {}
    })();
    return () => { cancelled = true; };
  }, []);
  const toggleFeature = async (key: string, enabled: boolean) => {
    setFeatureBusy(key);
    // Optimistic: the switch must feel instant, and main is the source of truth
    // that corrects it a moment later.
    setFeatures((cur) => ({ ...cur, [key]: enabled }));
    try {
      const res = await window.kiroApi.setFeature?.(key, enabled);
      if (res?.flags) setFeatures(res.flags);
      window.dispatchEvent(new CustomEvent('kirolex:features-changed', { detail: res?.flags }));
    } catch {
      setFeatures((cur) => ({ ...cur, [key]: !enabled }));
    } finally {
      setFeatureBusy(null);
    }
  };

  /** Read/write a switch without the UI caring which store owns it. Keeping this
   *  in one place is what lets the panel show a single list. */
  const switchValue = (key: string, store: SwitchStore): boolean => {
    if (store === 'feature') return features[key] !== false;
    if (store === 'prop') return confirmDeletes;
    return (settings as unknown as Record<string, boolean>)[key] !== false;
  };
  const setSwitchValue = (key: string, store: SwitchStore, value: boolean): void => {
    if (store === 'feature') { void toggleFeature(key, value); return; }
    if (store === 'prop') { onConfirmDeletesChange(value); return; }
    onChange({ ...settings, [key]: value });
  };
  useEffect(() => {
    window.kiroApi.getExecutorCapInfo?.().then((info) => {
      setCapInfo(info);
      setCapInput(String(info.cap)); // start from the CURRENT effective value so the user adjusts from it
    }).catch(() => {});
    window.kiroApi.getWedgeTimeout?.().then((info) => {
      setWedgeBounds({ min: info.min, max: info.max, default: info.default });
      setWedgeInput(String(info.seconds));
    }).catch(() => {});
    window.kiroApi.getToolStallTimeout?.().then((info) => {
      setToolStallBounds({ min: info.min, max: info.max, default: info.default });
      setToolStallInput(String(info.seconds));
    }).catch(() => {});
  }, []);

  const applyToolStall = (raw: string) => {
    setToolStallInput(raw);
    const n = Number(raw);
    if (raw.trim() === '' || !Number.isFinite(n) || n <= 0) return;   // mid-edit
    window.kiroApi.setToolStallTimeout?.(Math.floor(n)).catch(() => {});
  };

  const applyWedge = (raw: string) => {
    setWedgeInput(raw);
    const n = Number(raw);
    // Empty/non-numeric is mid-edit, not a request to change anything. 0 is a real
    // value here (turns the interrupt off), unlike the executor cap where 0 = auto.
    if (raw.trim() === '' || !Number.isFinite(n) || n < 0) return;
    window.kiroApi.setWedgeTimeout?.(Math.floor(n)).catch(() => {});
  };
  // Helper models: used ONLY for KiroLex's own background text chores (chat
  // titles, prompt suggestions), never for the chats themselves. Primary is tried
  // first, fallback only if it cannot answer.
  const [helperModel, setHelperModel] = useState('');
  const [helperFallback, setHelperFallback] = useState('');
  const [modelChoices, setModelChoices] = useState<string[]>([]);
  useEffect(() => {
    window.kiroApi.getHelperModels?.().then((h: any) => {
      if (!h) return;
      setHelperModel(h.model || '');
      setHelperFallback(h.fallback || '');
    }).catch(() => {});
    // Offer the models kiro-cli actually reports, so a retired name can't be picked.
    window.kiroApi.listModels?.().then((res: any) => {
      const list = Array.isArray(res) ? res : (res?.models || []);
      const names = list
        .map((m: any) => m?.model_name || m?.modelName)
        .filter((n: any): n is string => !!n && n !== 'auto');
      if (names.length) setModelChoices(names);
    }).catch(() => {});
  }, []);
  const saveHelper = (model: string, fallback: string) => {
    setHelperModel(model);
    setHelperFallback(fallback);
    window.kiroApi.setHelperModels?.(model, fallback).catch(() => {});
  };

  const applyCap = (raw: string) => {
    setCapInput(raw);
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 1) return; // ignore empty/invalid input, don't reset
    window.kiroApi.setExecutorCap?.(Math.floor(n)).then((r) => {
      if (r?.ok) {
        setCapInfo((prev) => prev ? { ...prev, cap: r.cap, overridden: true } : prev);
        window.dispatchEvent(new CustomEvent('kirolex:executor-cap-changed', { detail: { cap: r.cap } }));
      }
    }).catch(() => {});
  };
  return (
    <>
      <div className="overlay" onClick={onClose} />
      <div className="settings-dialog">
        <div className="settings-header">
          <h3>{t(t('⚙️ Settings'))}</h3>
          <button className="settings-close" onClick={onClose}>✕</button>
        </div>

        <div className="settings-body">
          <div className="settings-item settings-item-wide">
            <label className="settings-label">{t(t('Preview'))}</label>
            <p
              className="settings-preview"
              style={{ fontSize: settings.fontSize, fontFamily: settings.fontFamily || undefined }}
            >
              The quick brown fox jumps over the lazy dog. 中文预览 0O1lI
            </p>
            <p
              className="settings-preview"
              style={{
                fontSize: settings.fontSize,
                fontFamily: settings.monoFontFamily || 'var(--mono-font)',
              }}
            >
              const answer = 42; // 代码字体预览
            </p>
          </div>

          <div className="settings-item settings-item-wide">
            <label className="settings-label">{t(t('Font (text)'))}</label>
            <div className="settings-control">
              <select
                className="settings-select"
                value={FONT_PRESETS.some((f) => f.value === settings.fontFamily) ? settings.fontFamily : CUSTOM_FONT}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === CUSTOM_FONT) return; // keep the current custom value; edit it in the field
                  onChange({ ...settings, fontFamily: v });
                }}
              >
                {FONT_PRESETS.map((f) => (
                  <option key={f.label} value={f.value}>{t(f.label)}</option>
                ))}
                <option value={CUSTOM_FONT}>{t('Custom…')}</option>
              </select>
            </div>
            <input
              className="settings-input"
              placeholder={t("A custom font stack, e.g. 'PingFang SC', 'Segoe UI', sans-serif")}
              value={settings.fontFamily}
              onChange={(e) => onChange({ ...settings, fontFamily: e.target.value })}
            />
          </div>

          <div className="settings-item settings-item-wide">
            <label className="settings-label">{t(t('Font (code)'))}</label>
            <div className="settings-control">
              <select
                className="settings-select"
                value={MONO_PRESETS.some((f) => f.value === settings.monoFontFamily) ? settings.monoFontFamily : CUSTOM_FONT}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === CUSTOM_FONT) return;
                  onChange({ ...settings, monoFontFamily: v });
                }}
              >
                {MONO_PRESETS.map((f) => (
                  <option key={f.label} value={f.value}>{t(f.label)}</option>
                ))}
                <option value={CUSTOM_FONT}>{t('Custom…')}</option>
              </select>
            </div>
            <input
              className="settings-input"
              placeholder={t("A custom mono font stack, e.g. 'JetBrains Mono', Menlo, monospace")}
              value={settings.monoFontFamily}
              onChange={(e) => onChange({ ...settings, monoFontFamily: e.target.value })}
            />
          </div>

          {/* Two explicit columns: the switch list is TALL, and with grid
              auto-placement it landed in whichever column had room, next to
              unrelated selects and leaving half the dialog empty. Left column =
              everything else, right column = the switches, nothing interleaved. */}
          <div className="settings-col">
            {/*
              界面语言。放在左栏第一项：它是**改变其余所有文案**的那一个开关，
              藏在下面等于让人先看半屏自己看不懂的字再找到它。
            */}
            <div className="settings-item">
              <label className="settings-label">{t('Interface language')}</label>
              <div className="settings-control">
                <select
                  className="settings-select"
                  value={settings.language}
                  onChange={(e) => onChange({ ...settings, language: normalizeLang(e.target.value) })}
                >
                  {LANG_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              </div>
            </div>

            <div className="settings-item">
              <label className="settings-label">{t('Font size')}</label>
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
              <label className="settings-label">{t('Split grid (click a chat in the sidebar to add it; every pane has its own composer)')}</label>
              <div className="settings-control">
                <select
                  value={settings.splitGrid}
                  onChange={(event) => onChange({ ...settings, splitGrid: event.target.value as Settings['splitGrid'] })}
                  style={{ minWidth: 120 }}
                  title="行 x 列，最大 2 行 x 2 列。空的分屏位占它在网格里的那一格，宽度跟随上一行，所以之后放会话进来时已有的格子不会移动；移除用该格右上角的 ✕。"
                >
                  <option value="1x1">{t('1 × 1 (no split)')}</option>
                  <option value="1x2">{t('1 row × 2 cols (side by side)')}</option>
                  <option value="2x1">{t('2 rows × 1 col (stacked)')}</option>
                  <option value="2x2">{t('2 rows × 2 cols (maximum)')}</option>
                </select>
              </div>
            </div>

            <div className="settings-item">
              <label className="settings-label">{t('Concurrent connection limit (most chats connected at once)')}</label>
              <div className="settings-control">
                <input
                  type="number"
                  min={1}
                  max={64}
                  value={capInput}
                  onChange={(e) => applyCap(e.target.value)}
                  style={{ width: 90 }}
                />
              </div>
            </div>

            <div className="settings-item">
              <label className="settings-label">
                静默多久判定卡死（秒，0 = 不中断）
              </label>
              <div className="settings-control">
                <input
                  type="number"
                  min={0}
                  max={wedgeBounds?.max ?? 3600}
                  step={30}
                  value={wedgeInput}
                  onChange={(e) => applyWedge(e.target.value)}
                  style={{ width: 90 }}
                  title={
                    // Both thresholds are spelled out in BOTH tooltips on purpose. Read
                    // on its own either one looks like "the" timeout, and then the
                    // on-screen countdown -- which follows whichever bound is later --
                    // appears to contradict the number on this page.
                    '中断需要两个条件同时成立：\n'
                    + '  ① 这一轮在协议层完全静默超过这里设的时长；\n'
                    + '  ② 并且没有工具在下面那个「工具无进度」时长之内报告过进度。\n\n'
                    + '所以：没有工具在跑时，这个值就是实际的中断时间；有工具在跑时，实际等待是两个阈值里更晚的那个。\n'
                    + '未产出任何内容的会自动重发；已产出部分内容的只提示，由你决定是否重发。\n\n'
                    + `取值范围：${wedgeBounds?.min ?? 30}–${wedgeBounds?.max ?? 3600} 秒，默认 ${wedgeBounds?.default ?? 600} 秒。\n`
                    + '设为 0 则完全不自动中断，只保留 5 分钟的静默提示。\n'
                    + '首个 token 特别慢的模型如果被误中断，就把这个值调大。'
                  }
                />
                <span className="settings-hint">
                  {wedgeInput === '0'
                    ? '已关闭：只提示不中断'
                    : `没有工具在跑时：静默 ${wedgeInput || '—'} 秒后中断（5 分钟时先提示）。有工具在跑时，还要同时满足下面那一项`}
                </span>
              </div>
            </div>

            <div className="settings-item">
              <label className="settings-label">
                工具无进度多久判定卡死（秒）
              </label>
              <div className="settings-control">
                <input
                  type="number"
                  min={toolStallBounds?.min ?? 60}
                  max={toolStallBounds?.max ?? 86400}
                  step={60}
                  value={toolStallInput}
                  onChange={(e) => applyToolStall(e.target.value)}
                  style={{ width: 90 }}
                  disabled={wedgeInput === '0'}
                  title={
                    '工具调用运行期间，上面那条静默判定会被暂停 —— 因为长命令（构建、测试）本来就会长时间不出声。\n'
                    + '但这个暂停必须有上界：如果后端没发出「工具已结束」的更新，暂停会无限持续，一轮对话可能就那样挂着（实测出现过 5 小时以上）。\n\n'
                    + '所以：一个工具调用超过这个时长没有任何更新，才不再算作「仍在进行」，上面那条静默判定也才重新生效。\n'
                    + '有工具在跑时，实际中断时间 = 两个阈值里更晚的那个，默认就是这一项（30 分钟）—— 停顿提示里那个倒计时通常来自这里，而不是上面的静默阈值。\n\n'
                    + `范围 ${toolStallBounds?.min ?? 60}–${toolStallBounds?.max ?? 86400} 秒，默认 ${toolStallBounds?.default ?? 1800} 秒。\n`
                    + '如果确实有跑得更久、且期间完全不报告进度的命令被误中断，就把这个值调大。'
                  }
                />
                <span className="settings-hint">
                  {wedgeInput === '0'
                    ? '中断已关闭，此项不生效'
                    : `有工具在跑时：它连续 ${toolStallInput || '—'} 秒没有更新才中断 —— 这就是停顿提示里倒计时的来源`}
                </span>
              </div>
            </div>

            <div className="settings-item">
              <label className="settings-label">{t('Helper model (titles and prompt suggestions; does not affect the chat)')}</label>
              <div className="settings-control">
                <select
                  value={helperModel}
                  onChange={(e) => saveHelper(e.target.value, helperFallback)}
                  style={{ minWidth: 180 }}
                >
                  {[helperModel, ...modelChoices]
                    .filter((m, i, arr) => !!m && arr.indexOf(m) === i)
                    .map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
              </div>
            </div>

            <div className="settings-item">
              <label className="settings-label">{t('Helper-model fallback (used when the main one is unavailable)')}</label>
              <div className="settings-control">
                <select
                  value={helperFallback}
                  onChange={(e) => saveHelper(helperModel, e.target.value)}
                  style={{ minWidth: 180 }}
                >
                  <option value="">{t('No fallback')}</option>
                  {[helperFallback, ...modelChoices]
                    .filter((m, i, arr) => !!m && arr.indexOf(m) === i)
                    .map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
              </div>
            </div>





            {/* ONE list for every boolean behaviour switch, whoever stores it. All of
                them apply to the next operation with no restart; grouping is by what
                the switch affects, not by which file holds it. */}
          </div>

          <div className="settings-col">
            <div className="settings-item" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6 }}>
              <label className="settings-label">{t('Feature switches (take effect immediately, no restart)')}</label>
              {SWITCH_GROUPS.map((group) => {
                const rows = SWITCHES.filter((sw) => sw.group === group);
                if (!rows.length) return null;
                return (
                  <div key={group} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <div className="settings-switch-group">{group}</div>
                    {rows.map((sw) => {
                      const on = switchValue(sw.key, sw.store);
                      return (
                        <div key={sw.key} className="settings-control" style={{ justifyContent: 'space-between', gap: 12 }}>
                          <span className="settings-switch-label" title={sw.help}>
                            {t(sw.label)}
                          </span>
                          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', flex: '0 0 auto' }}
                                 title={sw.help}>
                            <input
                              type="checkbox"
                              checked={on}
                              disabled={featureBusy === sw.key}
                              onChange={(event) => setSwitchValue(sw.key, sw.store, event.target.checked)}
                            />
                            <span className="settings-value">{on ? 'On' : 'Off'}</span>
                          </label>
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </>
  );
};
