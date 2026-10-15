/**
 * **传输层的瞬时错误** —— 「⚠️ …'acp:prompt': Error: Internal error — Encountered an error in the
 * response stream: An unknown error occurred: dispatch failure」。
 *
 * `dispatch failure` 是 AWS SDK 在**连不上**时给的（DNS、TLS、连接被掐），不是模型的问题、也不是
 * 会话坏了。实测一条会话上 9 次，其中 6 次挤在 20 秒里 —— 显然是网络抖了一下，而每一次都把这句
 * 原文甩到界面上：既不告诉你该做什么，也不自己重试一次。
 *
 * 判据只认几个明确的传输层特征，不做模糊匹配：`Internal error` 是 kiro-cli 的万能错误，
 * 拿它当"可重试"会把真正的后端故障也一并重发。
 *
 * 单独一个文件（而不是留在 `index.ts` 里）：重试判据 `promptRetry` 要用它，而 `index.ts` 里有
 * electron —— 纯判据必须能在测试里直接 import。
 */
export function isTransientTransportError(text: string): boolean {
  const t = String(text || '');
  return /dispatch failure/i.test(t)
    || /\b(ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE)\b/i.test(t)
    || /(connection|network)\s+(reset|closed|error|timed out)/i.test(t)
    || /\b(timeout|timed out)\b.*\b(connect|handshake|tls)\b/i.test(t);
}
