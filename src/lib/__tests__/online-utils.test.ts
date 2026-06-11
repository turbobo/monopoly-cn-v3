import { describe, it, expect } from 'vitest'
import { slimGame, trimMessages, mergeMessages } from '../online-utils'
import { GameState } from '../game-engine'

// Mock GameState 工厂函数
function createMockGameState(overrides: Partial<GameState> = {}): GameState {
  return {
    players: [
      { id: 1, name: 'Player1', avatar: '👤', money: 1000, position: 0, properties: [], inJail: false, jailTurns: 0, bankrupt: false, isAI: false, color: '#FF0000' },
      { id: 2, name: 'Player2', avatar: '👥', money: 1000, position: 0, properties: [], inJail: false, jailTurns: 0, bankrupt: false, isAI: false, color: '#00FF00' },
    ],
    currentPlayer: 0,
    round: 1,
    maxRounds: 10,
    dice: [3, 4],
    phase: 'roll',
    log: ['Game started', 'Player1 rolled 7'],
    gameOver: false,
    winner: null,
    difficulty: 'normal',
    ...overrides,
  }
}

describe('slimGame', () => {
  it('应该去掉 log 字段（返回空数组）', () => {
    const gs = createMockGameState({ log: ['msg1', 'msg2', 'msg3'] })
    const result = slimGame(gs)
    expect(result.log).toEqual([])
  })

  it('应该保留其他字段不变', () => {
    const gs = createMockGameState({
      round: 5,
      currentPlayer: 1,
      dice: [6, 6],
      gameOver: true,
      winner: 0,
    })
    const result = slimGame(gs)
    expect(result.round).toBe(5)
    expect(result.currentPlayer).toBe(1)
    expect(result.dice).toEqual([6, 6])
    expect(result.gameOver).toBe(true)
    expect(result.winner).toBe(0)
    expect(result.players.length).toBe(2)
  })

  it('不应该修改原始对象', () => {
    const originalLog = ['original', 'log', 'entries']
    const gs = createMockGameState({ log: originalLog })
    const result = slimGame(gs)
    
    // 原始对象的 log 应该保持不变
    expect(gs.log).toEqual(originalLog)
    expect(gs.log).not.toBe(result.log)
  })
})

describe('trimMessages', () => {
  it('消息数 <= 20 时原样返回', () => {
    const msgs = Array.from({ length: 15 }, (_, i) => `msg${i}`)
    const result = trimMessages(msgs)
    expect(result).toEqual(msgs)
    expect(result.length).toBe(15)
  })

  it('消息数 > 20 时只保留最后 20 条', () => {
    const msgs = Array.from({ length: 30 }, (_, i) => `msg${i}`)
    const result = trimMessages(msgs)
    expect(result.length).toBe(20)
    expect(result).toEqual(msgs.slice(-20))
    expect(result[0]).toBe('msg10')
    expect(result[19]).toBe('msg29')
  })

  it('自定义 maxCount 参数', () => {
    const msgs = Array.from({ length: 50 }, (_, i) => `msg${i}`)
    const result = trimMessages(msgs, 10)
    expect(result.length).toBe(10)
    expect(result).toEqual(msgs.slice(-10))
  })

  it('空数组返回空数组', () => {
    const result = trimMessages([])
    expect(result).toEqual([])
    expect(result.length).toBe(0)
  })

  it('恰好 20 条时不裁剪', () => {
    const msgs = Array.from({ length: 20 }, (_, i) => `msg${i}`)
    const result = trimMessages(msgs)
    expect(result.length).toBe(20)
    expect(result).toEqual(msgs)
  })

  it('21 条时裁剪为 20 条', () => {
    const msgs = Array.from({ length: 21 }, (_, i) => `msg${i}`)
    const result = trimMessages(msgs)
    expect(result.length).toBe(20)
    expect(result).toEqual(msgs.slice(-20))
    expect(result[0]).toBe('msg1')
    expect(result[19]).toBe('msg20')
  })
})

describe('mergeMessages', () => {
  it('本地为空，返回远程消息', () => {
    const localMsgs: string[] = []
    const remoteMsgs = ['remote1', 'remote2', 'remote3']
    const result = mergeMessages(localMsgs, remoteMsgs)
    expect(result).toEqual(remoteMsgs)
  })

  it('远程为空，返回本地消息', () => {
    const localMsgs = ['local1', 'local2', 'local3']
    const remoteMsgs: string[] = []
    const result = mergeMessages(localMsgs, remoteMsgs)
    expect(result).toEqual(localMsgs)
  })

  it('有重叠部分，正确合并', () => {
    const localMsgs = ['A', 'B', 'C']
    const remoteMsgs = ['B', 'C', 'D', 'E']
    const result = mergeMessages(localMsgs, remoteMsgs)
    expect(result).toEqual(['A', 'B', 'C', 'D', 'E'])
  })

  it('完全重叠无新消息', () => {
    const localMsgs = ['A', 'B', 'C']
    const remoteMsgs = ['B', 'C']
    const result = mergeMessages(localMsgs, remoteMsgs)
    expect(result).toEqual(['A', 'B', 'C'])
  })

  it('无重叠（本地落后太多），返回远程消息', () => {
    const localMsgs = ['old1', 'old2']
    const remoteMsgs = ['new1', 'new2', 'new3']
    const result = mergeMessages(localMsgs, remoteMsgs)
    expect(result).toEqual(remoteMsgs)
  })

  it('重复消息场景：使用 lastIndexOf 找最后一个 A 的位置', () => {
    const localMsgs = ['A', 'B', 'A']
    const remoteMsgs = ['A', 'D']
    const result = mergeMessages(localMsgs, remoteMsgs)
    // lastIndexOf('A') 在 remoteMsgs 中是 0
    // 所以应该合并为 ['A', 'B', 'A', 'D']
    expect(result).toEqual(['A', 'B', 'A', 'D'])
  })

  it('大量消息合并性能', () => {
    const localMsgs = Array.from({ length: 100 }, (_, i) => `msg${i}`)
    const remoteMsgs = Array.from({ length: 50 }, (_, i) => `msg${i + 90}`) // 从 msg90 开始，与本地有重叠（msg90-msg99）
    
    const trimmedRemote = trimMessages(remoteMsgs, 20) // 裁剪后为 msg30-msg49，无重叠
    // 由于无重叠，应该返回 remoteMsgs
    const result = mergeMessages(localMsgs, trimmedRemote)
    
    // 无重叠时返回远程消息（20条）
    expect(result.length).toBe(20)
    expect(result).toEqual(trimmedRemote)
  })

  it('边界情况：本地和远程完全相同', () => {
    const msgs = ['A', 'B', 'C']
    const result = mergeMessages(msgs, msgs)
    expect(result).toEqual(msgs)
  })

  it('边界情况：远程是本地的前缀', () => {
    const localMsgs = ['A', 'B', 'C', 'D']
    const remoteMsgs = ['A', 'B']
    const result = mergeMessages(localMsgs, remoteMsgs)
    // lastLocal = 'D', remote中没有'D', overlapIdx = -1, 返回remote
    expect(result).toEqual(remoteMsgs)
  })

  it('边界情况：本地是远程的子集', () => {
    const localMsgs = ['A', 'B']
    const remoteMsgs = ['A', 'B', 'C', 'D']
    const result = mergeMessages(localMsgs, remoteMsgs)
    // lastLocal = 'B', overlapIdx = 1 (remote中'B'的位置)
    // overlapIdx (1) < remote.length - 1 (3), 所以合并
    expect(result).toEqual(['A', 'B', 'C', 'D'])
  })
})
