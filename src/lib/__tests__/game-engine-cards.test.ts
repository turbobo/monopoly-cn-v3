import { describe, it, expect } from 'vitest'
import {
  useRemoteDice, useSwapCard, useRoadblockCard, useFreePassCard, usePriceHikeCard,
  checkRoadblock, tickPriceHikes, aiUseCardDecision, checkBankrupt,
  BOARD, Player, GameState, GameCard, CardType,
} from '../game-engine'

/** 构造一张道具卡 */
function mkCard(type: CardType, id = `card-${type}`): GameCard {
  return { id, type, name: type, emoji: '🃏', description: 'test card' }
}

/** 构造一名玩家 */
function mkPlayer(overrides: Partial<Player> = {}): Player {
  return {
    id: 1, name: 'P1', avatar: '👤', money: 1500, position: 0,
    properties: [], inJail: false, jailTurns: 0, bankrupt: false,
    isAI: false, color: '#ff0000', cards: [], freePassActive: false,
    ...overrides,
  }
}

/** 构造游戏状态 */
function mkGame(players: Player[], overrides: Partial<GameState> = {}): GameState {
  return {
    players, currentPlayer: 0, round: 1, maxRounds: 0, dice: [1, 1],
    phase: 'roll', log: [], gameOver: false, winner: null, difficulty: 'normal',
    roadblocks: [], priceHikes: [], lastCardRound: 0,
    ...overrides,
  }
}

describe('useRemoteDice', () => {
  it('点数被钳制到 2-12 范围', () => {
    const [d1, d2] = useRemoteDice(2)
    expect(d1 + d2).toBe(2)
    const [d3, d4] = useRemoteDice(12)
    expect(d3 + d4).toBe(12)
    const [d5, d6] = useRemoteDice(99)
    expect(d5 + d6).toBe(12)
    const [d7, d8] = useRemoteDice(0)
    expect(d7 + d8).toBe(2)
  })

  it('两枚骰子都在 1-6 之间', () => {
    for (let total = 2; total <= 12; total++) {
      const [d1, d2] = useRemoteDice(total)
      expect(d1).toBeGreaterThanOrEqual(1)
      expect(d1).toBeLessThanOrEqual(6)
      expect(d2).toBeGreaterThanOrEqual(1)
      expect(d2).toBeLessThanOrEqual(6)
      expect(d1 + d2).toBe(total)
    }
  })
})

describe('useSwapCard', () => {
  it('交换两名玩家的位置与监狱状态，并消耗卡', () => {
    const p1 = mkPlayer({ id: 1, position: 5, cards: [mkCard('swap', 's1')] })
    const p2 = mkPlayer({ id: 2, position: 20, inJail: true, jailTurns: 2 })
    const gs = mkGame([p1, p2])
    const msg = useSwapCard(gs, 1, 2)
    expect(msg).toContain('互换')
    expect(p1.position).toBe(20)
    expect(p2.position).toBe(5)
    // 监狱状态同步交换
    expect(p1.inJail).toBe(true)
    expect(p1.jailTurns).toBe(2)
    expect(p2.inJail).toBe(false)
    expect(p1.cards.length).toBe(0)
  })

  it('目标玩家破产时拒绝交换', () => {
    const p1 = mkPlayer({ id: 1, cards: [mkCard('swap', 's1')] })
    const p2 = mkPlayer({ id: 2, bankrupt: true })
    const gs = mkGame([p1, p2])
    const msg = useSwapCard(gs, 1, 2)
    expect(msg).toBe('')
    expect(p1.cards.length).toBe(1) // 卡未消耗
  })

  it('用户无交换卡时拒绝', () => {
    const p1 = mkPlayer({ id: 1 })
    const p2 = mkPlayer({ id: 2 })
    const gs = mkGame([p1, p2])
    const msg = useSwapCard(gs, 1, 2)
    expect(msg).toBe('')
    expect(p1.position).toBe(0)
    expect(p2.position).toBe(0)
  })
})

describe('useRoadblockCard', () => {
  it('在普通地皮放置路障并消耗卡', () => {
    const p1 = mkPlayer({ id: 1, cards: [mkCard('roadblock', 'r1')] })
    const gs = mkGame([p1])
    const msg = useRoadblockCard(gs, 1, 5) // 5 = 大连（普通地皮）
    expect(msg).toContain('路障')
    expect(gs.roadblocks).toHaveLength(1)
    expect(gs.roadblocks[0]).toEqual({ tileId: 5, ownerPlayerId: 1 })
    expect(p1.cards.length).toBe(0)
  })

  it('特殊格子（起点/监狱/停车/入狱）拒绝放置', () => {
    const p1 = mkPlayer({ id: 1, cards: [mkCard('roadblock', 'r1')] })
    const gs = mkGame([p1])
    const msg = useRoadblockCard(gs, 1, 0) // 0 = 起点
    expect(msg).toContain('不能')
    expect(gs.roadblocks).toHaveLength(0)
    expect(p1.cards.length).toBe(1)
  })

  it('同一格子重复放置被拒绝', () => {
    const p1 = mkPlayer({ id: 1, cards: [mkCard('roadblock', 'r1'), mkCard('roadblock', 'r2')] })
    const gs = mkGame([p1])
    useRoadblockCard(gs, 1, 5)
    const msg = useRoadblockCard(gs, 1, 5)
    expect(msg).toContain('已有路障')
    expect(gs.roadblocks).toHaveLength(1)
    expect(p1.cards.length).toBe(1)
  })

  it('无路障卡时返回空串', () => {
    const p1 = mkPlayer({ id: 1 })
    const gs = mkGame([p1])
    expect(useRoadblockCard(gs, 1, 5)).toBe('')
  })
})

describe('useFreePassCard', () => {
  it('激活免费卡标记并消耗卡', () => {
    const p1 = mkPlayer({ id: 1, cards: [mkCard('free_pass', 'f1')] })
    const gs = mkGame([p1])
    const msg = useFreePassCard(gs, 1)
    expect(msg).toContain('免费卡')
    expect(p1.freePassActive).toBe(true)
    expect(p1.cards.length).toBe(0)
  })

  it('无卡时拒绝', () => {
    const p1 = mkPlayer({ id: 1 })
    const gs = mkGame([p1])
    expect(useFreePassCard(gs, 1)).toBe('')
    expect(p1.freePassActive).toBe(false)
  })
})

describe('usePriceHikeCard', () => {
  it('对自己的地皮涨价 3 回合并消耗卡', () => {
    const p1 = mkPlayer({ id: 1, properties: [5], cards: [mkCard('price_hike', 'h1')] })
    const gs = mkGame([p1])
    const msg = usePriceHikeCard(gs, 1, 5)
    expect(msg).toContain('涨价')
    expect(gs.priceHikes).toEqual([{ tileId: 5, ownerPlayerId: 1, roundsLeft: 3 }])
    expect(p1.cards.length).toBe(0)
  })

  it('非自己地皮拒绝涨价', () => {
    const p1 = mkPlayer({ id: 1, cards: [mkCard('price_hike', 'h1')] })
    const gs = mkGame([p1])
    expect(usePriceHikeCard(gs, 1, 6)).toBe('')
    expect(gs.priceHikes).toHaveLength(0)
    expect(p1.cards.length).toBe(1)
  })
})

describe('checkRoadblock', () => {
  it('踩中他人路障时移除路障并返回消息', () => {
    const p1 = mkPlayer({ id: 1, position: 5 })
    const gs = mkGame([p1], { roadblocks: [{ tileId: 5, ownerPlayerId: 2 }] })
    const msg = checkRoadblock(gs)
    expect(msg).toContain('路障')
    expect(gs.roadblocks).toHaveLength(0)
  })

  it('踩中自己放置的路障不触发', () => {
    const p1 = mkPlayer({ id: 1, position: 5 })
    const gs = mkGame([p1], { roadblocks: [{ tileId: 5, ownerPlayerId: 1 }] })
    expect(checkRoadblock(gs)).toBeNull()
    expect(gs.roadblocks).toHaveLength(1)
  })
})

describe('tickPriceHikes', () => {
  it('回合递减，过期移除并返回结束消息', () => {
    const p1 = mkPlayer({ id: 1 })
    const gs = mkGame([p1], {
      priceHikes: [
        { tileId: 5, ownerPlayerId: 1, roundsLeft: 2 },
        { tileId: 6, ownerPlayerId: 1, roundsLeft: 1 },
      ],
    })
    const msgs = tickPriceHikes(gs)
    expect(gs.priceHikes).toHaveLength(1)
    expect(gs.priceHikes[0]).toEqual({ tileId: 5, ownerPlayerId: 1, roundsLeft: 1 })
    expect(msgs.some(m => m.includes(BOARD[6].name) && m.includes('结束'))).toBe(true)
  })
})

describe('aiUseCardDecision', () => {
  it('非 AI 玩家或无卡时直接返回', () => {
    const human = mkPlayer({ id: 1, isAI: false, cards: [mkCard('free_pass')] })
    const gs = mkGame([human])
    expect(aiUseCardDecision(gs)).toEqual({ messages: [], forcedDice: null })
    const ai = mkPlayer({ id: 1, isAI: true })
    const gs2 = mkGame([ai])
    expect(aiUseCardDecision(gs2)).toEqual({ messages: [], forcedDice: null })
  })

  it('资金紧张时激活免费卡', () => {
    const ai = mkPlayer({ id: 1, isAI: true, aiPersonality: 'conservative', money: 200, cards: [mkCard('free_pass', 'f1')] })
    const gs = mkGame([ai])
    const result = aiUseCardDecision(gs)
    expect(result.messages.some(m => m.includes('免费卡'))).toBe(true)
    expect(ai.freePassActive).toBe(true)
  })

  it('资金充足时不使用免费卡', () => {
    const ai = mkPlayer({ id: 1, isAI: true, aiPersonality: 'conservative', money: 1500, cards: [mkCard('free_pass', 'f1')] })
    const gs = mkGame([ai])
    const result = aiUseCardDecision(gs)
    expect(result.messages.some(m => m.includes('免费卡'))).toBe(false)
    expect(ai.freePassActive).toBe(false)
  })
})

describe('checkBankrupt 零资产判定', () => {
  it('现金为 0 且无地皮 → 破产', () => {
    const p = mkPlayer({ money: 0, properties: [] })
    const result = checkBankrupt(p)
    expect(result.bankrupt).toBe(true)
    expect(p.bankrupt).toBe(true)
  })

  it('现金为 0 但有地皮 → 不破产', () => {
    const p = mkPlayer({ money: 0, properties: [5] })
    const result = checkBankrupt(p)
    expect(result.bankrupt).toBe(false)
    expect(p.bankrupt).toBe(false)
  })

  it('现金为负时先卖地，卖地后还清债务则不破产', () => {
    // 大连 price=100，6 折回收 60：-50 + 60 = 10 ≥ 0 → 不破产
    const p = mkPlayer({ money: -50, properties: [5] })
    const result = checkBankrupt(p)
    expect(result.bankrupt).toBe(false)
    expect(result.soldTiles).toEqual([5])
    expect(p.properties).toEqual([])
  })

  it('现金为负且卖光地皮仍不足 → 破产并清空地皮', () => {
    // 大连 price=100，6 折回收 60：-100 + 60 = -40 < 0 → 破产
    const p = mkPlayer({ money: -100, properties: [5] })
    const result = checkBankrupt(p)
    expect(result.bankrupt).toBe(true)
    expect(p.bankrupt).toBe(true)
    expect(result.soldTiles).toEqual([5])
    expect(p.properties).toEqual([])
  })
})
