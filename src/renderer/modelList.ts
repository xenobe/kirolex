/**
 * 模型列表缓存的取舍 —— PURE。
 *
 * 存在的理由是一次真实故障：断网期间 `kiro-cli chat --list-models` 返回了一份**格式正确但内容
 * 退化**的结果（只有 `auto`，而且 `context_window_tokens` 是 200k 而非真实的 1M）。App.tsx 里那句
 *
 *     uiSet('kirolex-models', JSON.stringify(data.models || []));
 *
 * 是**无条件**覆盖：好结果和坏结果一视同仁。于是唯一的回退来源被写坏，网恢复之后界面照旧显示
 * 「模型都不可用」—— 因为拉取一直超时走 `.catch()`，而 `.catch()` 读的就是那份坏缓存。
 *
 * 所以覆盖必须有条件。规则只有一条能概括：**不要用信息更少的答案替换信息更多的答案。**
 */

/**
 * 启动后等多久才去拉模型/agent 列表。
 *
 * 不是随手写的数字：这两条命令各要 spawn 一个 kiro-cli，冷启动要加载全部 MCP server（空闲实测 3.4s）。
 * 启动瞬间 eager-attach 正在同时拉起多条会话的执行器，插进去就双双超时 —— 日志里 13 次
 * `timed out after 10000ms`，提到 30s 之后照样超。日志里 `reveal: window shown` 通常落在 +2～4s，
 * 所以 4 秒是「等窗口就绪、执行器也铺开之后」的位置。
 *
 * 这段时间界面显示的是受保护的缓存，不是空列表。
 */
export const MODEL_LIST_WARMUP_DELAY_MS = 4000;

/**
 * agent 列表的落盘缓存键 —— 和 `kirolex-models` 对称。
 *
 * 「为什么现在新会话只能选 default agent 了」：agent 列表原来只在内存里，"拿不到就保留上一次的"
 * 在**新挂载**时等于保留一个空数组（启动、窗口重载、开发时一次 HMR 都算），而一次 `agent list`
 * 超时（实测 30s 被 kill；空闲 shell 里同一条命令 1.6s）就把下拉永久留在"只有 kiro_default"上 ——
 * 永久，因为除了启动那次 warmup 没有任何东西会再拉。
 *
 * 键放在这里而不是 App 里：它和 `kirolex-models` 是同一件事的两半，两个名字应该看得见彼此。
 */
export const AGENTS_CACHE_KEY = 'kirolex-agents';

export interface ModelEntry {
  model_id?: string;
  model_name?: string;
  [key: string]: unknown;
}

/**
 * 「具体模型」= 除 `auto` 之外真正能选的那些。
 *
 * `auto` 不算：它是一个路由器（"Models chosen by task"），任何账号任何时候都有它，所以一份
 * 只剩 `auto` 的列表和「什么都没拿到」的信息量是一样的 —— 这正是退化结果的特征。
 */
export function concreteModels(list: ModelEntry[] | null | undefined): ModelEntry[] {
  if (!Array.isArray(list)) return [];
  return list.filter((m) => {
    const id = String(m?.model_id || m?.model_name || '').trim();
    return !!id && id !== 'auto';
  });
}

/**
 * 新拉到的列表值不值得写进缓存。
 *
 * 三条，按优先级：
 *   1. 空列表永远不收 —— 宁可显示旧的，也不要显示「没有模型」
 *   2. 新的有具体模型 → 收（模型会上下线，不能永远钉住旧列表）
 *   3. 新的没有具体模型，但缓存里有 → 拒绝（这就是那次污染）；缓存也没有 → 收（首次启动）
 */
export function shouldReplaceModelCache(
  next: ModelEntry[] | null | undefined,
  cached: ModelEntry[] | null | undefined,
): boolean {
  const incoming = Array.isArray(next) ? next : [];
  if (incoming.length === 0) return false;
  if (concreteModels(incoming).length > 0) return true;
  return concreteModels(cached).length === 0;
}

/**
 * 一份新列表**丢了哪些**具体模型 —— PURE。
 *
 * 「有的时候 kiro 选不了 claude 模型」：`shouldReplaceModelCache` 的规则是「不要用信息更少的答案替换
 * 信息更多的答案」，而它的判据只是"新的有没有具体模型"。于是一份**有 3 个模型但缺了 claude 全家**的
 * 结果会被当成可信而收下，claude 就从选择器里消失 —— 而它消失得毫无解释。
 *
 * 这个函数不做决定，只把差异说出来，给两个地方用：
 *   · 选择器旁边那句提示（"比上次少了 N 个：…"），让消失有个交代；
 *   · 强制重拉之后的对照（`forcedModelReplace` 的日志）。
 *
 * **刻意不用它去否决替换**：模型真的会退役（实测 `claude-opus-5` 今天就退了），按"变少就拒"会把一个
 * 已经不存在的模型永久钉在选择器里 —— 那比暂时少一个更糟，而且更难查。
 */
export function lostModels(
  next: ModelEntry[] | null | undefined,
  cached: ModelEntry[] | null | undefined,
): string[] {
  const idOf = (m: ModelEntry) => String(m?.model_id || m?.model_name || '').trim();
  const have = new Set(concreteModels(next).map(idOf).filter(Boolean));
  return concreteModels(cached).map(idOf).filter((id) => id && !have.has(id));
}

/**
 * **强制重拉**时该不该写进缓存 —— PURE。
 *
 * 自动重拉走 `shouldReplaceModelCache`（保守，防退化结果污染唯一的回退来源）。而你**手点**重拉时
 * 想要的恰恰相反：把后端此刻的真实答案摆出来，包括"claude 真的没了"和"claude 回来了"两个方向。
 * 那条保守规则在这里会把前者挡掉，于是重拉看着像没反应。
 *
 * 唯一仍然拒绝的是**空列表** —— 空的信息量是零，显示旧的也比显示「没有模型」有用。
 * 只剩 `auto` 的退化结果这里**收**：你亲手要的答案就是"现在只有 auto"，而下一次自动重拉会修正它。
 */
export function forcedModelReplace(next: ModelEntry[] | null | undefined): boolean {
  return Array.isArray(next) && next.length > 0;
}
