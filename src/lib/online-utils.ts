import { GameState } from './game-engine'

/**
 * 精简游戏状态用于网络传输（去掉冗余的 log 字段）
 */
export function slimGame(gs: GameState): GameState {
  return { ...gs, log: [] }
}

/**
 * 裁剪消息数组，只保留最近 N 条，防止 GoEasy 消息超长
 */
export function trimMessages(msgs: string[], maxCount = 20): string[] {
  return msgs.length > maxCount ? msgs.slice(-maxCount) : msgs
}

/**
 * 合并远程裁剪后的消息与本地完整历史。
 * 远程只发最近 N 条，本地保留完整历史，取并集。
 */
export function mergeMessages(localMsgs: string[], remoteMsgs: string[]): string[] {
  if (!localMsgs.length) return remoteMsgs
  if (!remoteMsgs.length) return localMsgs

  const lastLocal = localMsgs[localMsgs.length - 1]
  const overlapIdx = remoteMsgs.lastIndexOf(lastLocal)

  if (overlapIdx >= 0 && overlapIdx < remoteMsgs.length - 1) {
    return [...localMsgs, ...remoteMsgs.slice(overlapIdx + 1)]
  }
  if (overlapIdx === remoteMsgs.length - 1) {
    return localMsgs
  }
  return remoteMsgs
}
