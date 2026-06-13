import { GameState } from './game-engine'

/**
 * 精简游戏状态用于网络传输（去掉冗余的 log 字段）
 */
export function slimGame(gs: GameState): GameState {
  return {
    ...gs,
    log: [],
    players: gs.players.map(p => ({
      ...p,
      properties: [...p.properties],
      cards: p.cards.map(c => ({ ...c })),
    })),
    roadblocks: gs.roadblocks.map(r => ({ ...r })),
  }
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
  if (!localMsgs.length) return [...remoteMsgs]
  if (!remoteMsgs.length) return [...localMsgs]

  // 从远程消息尾部向前查找本地最后一条消息的匹配位置
  // 从后向前搜索避免文本碰撞（同内容消息误匹配）
  const lastLocal = localMsgs[localMsgs.length - 1]
  let overlapIdx = -1
  for (let i = remoteMsgs.length - 1; i >= 0; i--) {
    if (remoteMsgs[i] === lastLocal) { overlapIdx = i; break }
  }

  if (overlapIdx >= 0 && overlapIdx < remoteMsgs.length - 1) {
    return [...localMsgs, ...remoteMsgs.slice(overlapIdx + 1)]
  }
  if (overlapIdx === remoteMsgs.length - 1) {
    return [...localMsgs]
  }
  // 无重叠：远程有全新消息批次，合并两者并去重
  const localSet = new Set(localMsgs)
  return [...localMsgs, ...remoteMsgs.filter(m => !localSet.has(m))]
}
