/**
 * 「`Internal error — Kiro failed to generate a response` 发生了什么？」—— PURE 判据。
 *
 * ## 实测
 *
 * `Stripe AI布局全景研究` 连发两次都是这一句（29 秒、15 秒各一次）。查下来**不是模型的事**：
 * 我拿 `kiro-cli chat --model X` 一个个试过，`claude-opus-5` / `claude-opus-4.8` / `claude-sonnet-5` /
 * `gpt-5.6-sol` **四个全都正常应答**（opus-5 用了 5 秒、0.35 credits）。
 *
 * 真正的形状是**会话 id 对现在服务它的进程来说是过期的**：
 *
 *   · 那条会话带的 `cliSessionId` 是 8 小时前建的（`2281ac87…`），中间后端断过、换过好几次进程
 *   · 记录里 `contextEstablishedPid = 54799`，而 15:01 前后新起了一个进程（pid 18444）
 *   · kiro-cli **不持久化 ACP 会话**，所以 `session/load(旧 id)` 它会答 OK，但真发一轮就服务不了
 *
 * 而 kiro-cli 对这种情况回的是笼统的 `-32603 Internal error`，一个字都不提"这个会话我不认识" ——
 * 所以它看着像后端抽风，而其实是可以自愈的：**换一个新的 ACP 会话，把上下文随行带过去**就好。
 *
 * ## 为什么要"pid 不一致"这个条件
 *
 * 光看错误文本不够：`Internal error` 是 kiro-cli 的万能错误（并发 prompt、锁没释放、真的内部异常
 * 都用它）。无条件重建会话的代价是丢掉后端里**真实存在**的那份对话历史 —— 那比报错糟。
 *
 * 加上"上下文是在**别的进程**里建立的"之后，判据说的是一件有依据的事：这个 id 在**当前**进程里
 * 确实没有上下文。那时重建会话不丢任何东西 —— 反正它已经不在了。
 */

export type StaleVerdict = 'recreate' | 'report';

export interface StaleInput {
  /** 后端回的错误文本。 */
  error: string;
  /** 记录里"上下文是在哪个进程里建立的"。`undefined` = 从来没建立过。 */
  contextPid?: number;
  /** 现在服务这条会话的进程。 */
  clientPid?: number;
  /** 这一轮已经重建过一次了 —— 只给一次机会。 */
  alreadyRetried: boolean;
  /**
   * **这个后端 session 已经连着失败几次了** ——「无法继续执行，总是断」。
   *
   * 实测那条会话：一次 `write` 工具失败之后，每一次发送都回
   * `Internal error — Kiro failed to generate a response`，8 秒一次、连着 6 次，
   * 而 pid 从头到尾没变 —— 也就是说这段对话**在后端侧坏了**（历史里有它咽不下去的东西），
   * 而每次请求都会把同一段历史重放一遍，所以换模型、重连、重发都没用。
   *
   * 原来的判据只认 pid 不一致，于是这种"进程没换但对话已经毒了"的情况**永远不触发重建** ——
   * 那条会话就此彻底卡死，只能靠人手动复制会话。
   *
   * 用"连续失败次数"而不是"失败过一次"：单次 `Internal error` 很常见（并发、锁、一时抖动），
   * 为它重建会话会把后端里真实存在的那段历史换掉。**连着两次同一个错**才是"这段对话本身有问题"
   * 的证据 —— 而重建时上下文会随下一条消息带过去（snapshot ride-along），所以代价有限。
   */
  consecutiveFailures?: number;
  /**
   * **上一次换后端会话是多久以前**（毫秒）；`undefined` = 这条会话这次运行里还没换过。
   *
   * 「我他妈说的是最近那几次 workshop 的」—— 查到底之后的结论是：那几次**不是这条对话的问题**。
   * 证据在 kiro-cli 自己存的会话状态里（`~/.kiro/sessions/cli/<id>.json{,l}`）：
   *
   *   旧会话（连着失败 4 次）  386 条记录  上下文 29.17%
   *   新建 #1（又失败 2 次）    34 条记录  上下文  3.85%   ← 几乎是空的，照样失败
   *   新建 #2（又失败 2 次）    14 条记录  上下文  3.82%   ← 更空，照样失败
   *   新建 #3（07:56 起成功）   82 条记录  上下文  9.11%   ← 最大的那个反而好了
   *
   * 而且失败是**按时间聚堆**的：07:30–07:54 之间 13 失败 / 1 成功，07:55 之后 9 成功 / 1 失败。
   * kiro-cli 日志里全是 `err=EmptyResponse`（流开了、一个 token 都没发）。也就是说那 25 分钟里
   * 后端就是在给空响应，换会话只是碰上了窗口结束。
   *
   * 所以：**刚换过会话又是同一个错，就不要再换了**。换一次要 ~10 秒拆装、并且在界面上读起来像
   * "会话又断了"，而它对这种故障一点用都没有 —— 那时该说的是"后端在返空响应"，而不是继续折腾会话。
   */
  lastRecreateAgoMs?: number;
}

/** 刚换过后端会话多久之内不再换。5 分钟 —— 见 `lastRecreateAgoMs`。 */
export const RECREATE_COOLDOWN_MS = 300_000;

/** 连着几次同样的失败才认定"这段对话在后端坏了"。2 次 —— 见 `consecutiveFailures`。 */
export const POISONED_AFTER = 2;

/** kiro-cli 的万能错误：并发、锁、真异常都用它，所以它本身不构成判据。 */
export function isBareInternalError(text: string): boolean {
  const t = String(text || '');
  return /internal error/i.test(t) && !/prompt already in progress/i.test(t);
}

export function staleVerdict(input: StaleInput): StaleVerdict {
  if (input.alreadyRetried) return 'report';           // 一次就够，别把一个真异常变成循环
  if (!isBareInternalError(input.error)) return 'report';
  /*
    刚换过一个**全新**的后端会话（历史几乎是空的）又是同一个错 → 病不在这条对话里，
    再换第二个、第三个只是白拆白装。见 `lastRecreateAgoMs` 里的实测数字。
  */
  if ((input.lastRecreateAgoMs ?? Infinity) < RECREATE_COOLDOWN_MS) return 'report';
  /*
    **连着坏两次就重建，不管 pid** —— 见 `consecutiveFailures`。
    放在 pid 判据之前：pid 一致是那条路的"不重建"理由，而这里正是要绕过它。
  */
  if ((input.consecutiveFailures || 0) >= POISONED_AFTER) return 'recreate';
  /*
    两个 pid 都得知道才敢下结论：
      · `contextPid` 是 undefined → 上下文从来没建立过，那是"欠着重建"那条路管的事，不是这里
      · `clientPid` 是 undefined → 连不上进程，问题在更前面
  */
  if (!input.contextPid || !input.clientPid) return 'report';
  return input.contextPid !== input.clientPid ? 'recreate' : 'report';
}

/** 重建之后留在日志/会话上的那句话 —— 要说清换了什么、为什么，以及有没有丢东西。 */
export function staleRecoveryNote(oldId: string, newId: string, contextPid: number, clientPid: number): string {
  return `这条会话的后端会话 id（${oldId.slice(0, 8)}…）是在进程 ${contextPid} 里建立的，`
    + `而现在服务它的是进程 ${clientPid} —— kiro-cli 不持久化 ACP 会话，所以那个 id 在新进程里`
    + `没有上下文，发一轮只会回笼统的 Internal error。已经换成新会话（${newId.slice(0, 8)}…）`
    + '并把上下文随下一条消息带过去；磁盘上的对话记录一条都没动。';
}
