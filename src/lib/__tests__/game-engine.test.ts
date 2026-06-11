import { describe, it, expect, beforeEach } from 'vitest'
import {
  createGame,
  createPlayer,
  executeTurn,
  nextPlayer,
  finalizeTurn,
  buyProperty,
  rollDice,
  movePlayer,
  calculateRent,
  checkBankrupt,
  totalWealth,
  getStartBonus,
  BOARD,
  BOARD_SIZE,
  COLOR_GROUPS,
  Player,
  GameState,
} from '../game-engine'

describe('createGame', () => {
  it('创建 AI 模式游戏，验证玩家数量和类型', () => {
    const gs = createGame('ai', 2)
    expect(gs.players.length).toBe(3) // 1 human + 2 AI
    expect(gs.players[0].isAI).toBe(false)
    expect(gs.players[1].isAI).toBe(true)
    expect(gs.players[2].isAI).toBe(true)
  })

  it('创建本地模式游戏，验证所有玩家都不是 AI', () => {
    const gs = createGame('local', 3)
    expect(gs.players.length).toBe(3)
    gs.players.forEach((p) => {
      expect(p.isAI).toBe(false)
    })
  })

  it('验证初始状态', () => {
    const gs = createGame('ai', 1)
    expect(gs.currentPlayer).toBe(0)
    expect(gs.round).toBe(1)
    expect(gs.phase).toBe('roll')
    expect(gs.gameOver).toBe(false)
  })

  it('验证自定义初始金额', () => {
    const gs = createGame('local', 2, 2000)
    gs.players.forEach((p) => {
      expect(p.money).toBe(2000)
    })
  })
})

describe('nextPlayer', () => {
  it('2人游戏中正常轮换 0→1→0', () => {
    const gs = createGame('local', 2)
    expect(gs.currentPlayer).toBe(0)
    nextPlayer(gs)
    expect(gs.currentPlayer).toBe(1)
    nextPlayer(gs)
    expect(gs.currentPlayer).toBe(0)
  })

  it('跳过破产玩家', () => {
    const gs = createGame('local', 3)
    gs.players[1].bankrupt = true
    nextPlayer(gs) // 0 -> 2 (跳过1)
    expect(gs.currentPlayer).toBe(2)
    nextPlayer(gs) // 2 -> 0
    expect(gs.currentPlayer).toBe(0)
  })

  it('回合递增（从最后一个玩家回到第一个时 round++）', () => {
    const gs = createGame('local', 2)
    expect(gs.round).toBe(1)
    nextPlayer(gs) // 0 -> 1
    expect(gs.round).toBe(1)
    nextPlayer(gs) // 1 -> 0 (回绕)
    expect(gs.round).toBe(2)
  })

  it('phase 重置为 roll', () => {
    const gs = createGame('local', 2)
    gs.phase = 'action'
    nextPlayer(gs)
    expect(gs.phase).toBe('roll')
  })

  it('4人游戏中间2个破产，验证正确跳过', () => {
    const gs = createGame('local', 4)
    gs.players[1].bankrupt = true
    gs.players[2].bankrupt = true
    nextPlayer(gs) // 0 -> 3 (跳过1,2)
    expect(gs.currentPlayer).toBe(3)
    nextPlayer(gs) // 3 -> 0 (回绕)
    expect(gs.currentPlayer).toBe(0)
    expect(gs.round).toBe(2)
  })
})

describe('executeTurn', () => {
  it('使用预掷骰子 [3,2] 验证移动到正确位置', () => {
    const gs = createGame('local', 2)
    executeTurn(gs, [3, 2])
    expect(gs.players[0].position).toBe(5) // 0 + 5 = 5
  })

  it('落在起点格子上，验证消息', () => {
    const gs = createGame('local', 2)
    gs.players[0].position = 23 // 23 + 5 = 28 % 28 = 0 (起点)
    const messages = executeTurn(gs, [3, 2])
    expect(messages.some((m) => m.includes('起点'))).toBe(true)
  })

  it('落在可购买空地上（非AI玩家），验证 phase=action 且不调用 nextPlayer', () => {
    const gs = createGame('local', 2)
    // 移动到大连 (id=5)，这是一个 property
    executeTurn(gs, [5, 0]) // 0 + 5 = 5
    expect(gs.phase).toBe('action')
    expect(gs.currentPlayer).toBe(0) // 没有调用 nextPlayer
  })

  it('AI 玩家落在空地上，验证自动购买决策', () => {
    const gs = createGame('ai', 1)
    // AI 玩家 (player 1) 的回合，先切换到 AI
    gs.currentPlayer = 1
    gs.players[1].money = 2000 // 确保有钱
    // 移动到厦门 (id=1)，需要掷出 1
    const messages = executeTurn(gs, [1, 0])
    // AI 应该做出购买决策（买或不买）
    expect(messages.some((m) => m.includes('购买了') || m.includes('决定不买'))).toBe(true)
  })

  it('落在已有业主的地产上，验证支付租金', () => {
    const gs = createGame('local', 2)
    // player 0 购买大连 (id=5)
    buyProperty(gs.players[0], 5)
    // player 1 移动到大连
    gs.currentPlayer = 1
    gs.players[1].position = 0
    const messages = executeTurn(gs, [5, 0]) // 0 + 5 = 5
    expect(messages.some((m) => m.includes('支付租金'))).toBe(true)
    expect(gs.players[1].money).toBeLessThan(1500)
  })

  it('落在税务格子上，验证扣款', () => {
    const gs = createGame('local', 2)
    // 移动到个人所得税 (id=4)
    const messages = executeTurn(gs, [4, 0])
    expect(messages.some((m) => m.includes('缴纳'))).toBe(true)
    expect(gs.players[0].money).toBe(1400) // 1500 - 100
  })

  it('破产玩家跳过回合', () => {
    const gs = createGame('local', 2)
    gs.players[0].bankrupt = true
    const messages = executeTurn(gs, [3, 2])
    expect(messages.some((m) => m.includes('已破产'))).toBe(true)
    expect(gs.currentPlayer).toBe(1) // 切换到下一个玩家
  })

  it('落在入狱格子上(goto_jail id=21)，验证位置设为7且 inJail=true', () => {
    const gs = createGame('local', 2)
    // 移动到入狱格子 (id=21)，需要掷出 21
    // 但棋盘只有28格，所以从位置0移动21步到达id=21
    const messages = executeTurn(gs, [21, 0])
    expect(gs.players[0].position).toBe(7)
    expect(gs.players[0].inJail).toBe(true)
    expect(messages.some((m) => m.includes('监狱'))).toBe(true)
  })
})

describe('buyProperty', () => {
  it('购买成功，验证扣款和地产列表', () => {
    const player = createPlayer(0, 'Test', false)
    const result = buyProperty(player, 1) // 厦门 price=60
    expect(result).toBe(true)
    expect(player.money).toBe(1440) // 1500 - 60
    expect(player.properties).toContain(1)
  })

  it('余额不足购买失败', () => {
    const player = createPlayer(0, 'Test', false)
    player.money = 50
    const result = buyProperty(player, 1) // 厦门 price=60
    expect(result).toBe(false)
    expect(player.money).toBe(50)
    expect(player.properties.length).toBe(0)
  })
})

describe('finalizeTurn', () => {
  it('正常结束回合，验证 nextPlayer 被调用', () => {
    const gs = createGame('local', 2)
    gs.phase = 'action'
    finalizeTurn(gs)
    expect(gs.currentPlayer).toBe(1)
    expect(gs.phase).toBe('roll')
  })

  it('购买后破产检查', () => {
    const gs = createGame('local', 2)
    // 让玩家购买多个地产导致破产
    buyProperty(gs.players[0], 26) // 北京 price=400, money=1100
    buyProperty(gs.players[0], 25) // 上海 price=350, money=750
    buyProperty(gs.players[0], 24) // 天津 price=320, money=430
    buyProperty(gs.players[0], 22) // 苏州 price=280, money=150
    buyProperty(gs.players[0], 20) // 深圳 price=300, 钱不够，购买失败
    // 当前 money = 150, properties = [26, 25, 24, 22]
    // 手动扣款让它破产
    gs.players[0].money = -200
    const messages = finalizeTurn(gs)
    // 应该触发卖地或破产
    expect(messages.some((m) => m.includes('卖出') || m.includes('破产'))).toBe(true)
  })
})

describe('calculateRent', () => {
  it('基础租金', () => {
    const tile = BOARD[1] // 厦门 rent[0]=6
    const owner = createPlayer(0, 'Owner', false)
    owner.properties.push(1)
    const rent = calculateRent(tile, owner, [], 1)
    expect(rent).toBe(6)
  })

  it('同色两块加成', () => {
    const tile = BOARD[1] // 厦门 color=#8B4513, 同色组只有[1, 3]两个
    const owner = createPlayer(0, 'Owner', false)
    owner.properties.push(1) // 厦门
    owner.properties.push(3) // 青岛 (同色组)
    const rent = calculateRent(tile, owner, [], 1)
    // 同色组总共2个，拥有2个即全套，使用rent[2]=30
    expect(rent).toBe(30) // rent[2]=30
  })

  it('同色全套加成', () => {
    const tile = BOARD[8] // 重庆 color=#FF4500
    const owner = createPlayer(0, 'Owner', false)
    owner.properties.push(8) // 重庆
    owner.properties.push(9) // 西安
    owner.properties.push(11) // 长沙 (全套)
    const rent = calculateRent(tile, owner, [], 1)
    expect(rent).toBe(60) // rent[2]=60
  })

  it('回合加成（10回合后x1.5, 20回合后x2.0）', () => {
    const tile = BOARD[1] // 厦门 rent[0]=6
    const owner = createPlayer(0, 'Owner', false)
    owner.properties.push(1)

    const rent1 = calculateRent(tile, owner, [], 1)
    expect(rent1).toBe(6)

    const rent10 = calculateRent(tile, owner, [], 10)
    expect(rent10).toBe(9) // 6 * 1.5 = 9

    const rent20 = calculateRent(tile, owner, [], 20)
    expect(rent20).toBe(12) // 6 * 2.0 = 12
  })
})

describe('movePlayer', () => {
  it('正常移动', () => {
    const player = createPlayer(0, 'Test', false)
    movePlayer(player, 5, 1)
    expect(player.position).toBe(5)
  })

  it('经过起点获得奖金', () => {
    const player = createPlayer(0, 'Test', false)
    player.position = 25
    const bonus = movePlayer(player, 5, 1) // 25 + 5 = 30 % 28 = 2，经过起点
    expect(bonus).toBe(200)
    expect(player.money).toBe(1700) // 1500 + 200
  })

  it('环绕（position 27 + 5 = 4）', () => {
    const player = createPlayer(0, 'Test', false)
    player.position = 27
    movePlayer(player, 5, 1)
    expect(player.position).toBe(4) // (27 + 5) % 28 = 4
  })
})

describe('checkBankrupt', () => {
  it('正数余额不破产', () => {
    const player = createPlayer(0, 'Test', false)
    const result = checkBankrupt(player)
    expect(result.bankrupt).toBe(false)
    expect(result.soldTiles.length).toBe(0)
  })

  it('负余额有地产自动卖地', () => {
    const player = createPlayer(0, 'Test', false)
    player.money = -100
    // 添加多个地产确保卖地后能还清债务
    player.properties.push(1) // 厦门 price=60, 卖出得36
    player.properties.push(3) // 青岛 price=80, 卖出得48
    // 总共可得 36+48=84，仍不够，需要更多
    player.properties.push(5) // 大连 price=100, 卖出得60
    // 总共可得 36+48+60=144 > 100
    const result = checkBankrupt(player)
    expect(result.bankrupt).toBe(false)
    expect(result.soldTiles.length).toBeGreaterThan(0)
    expect(player.money).toBeGreaterThanOrEqual(0)
  })

  it('负余额无地产直接破产', () => {
    const player = createPlayer(0, 'Test', false)
    player.money = -100
    const result = checkBankrupt(player)
    expect(result.bankrupt).toBe(true)
    expect(result.soldTiles.length).toBe(0)
  })
})

describe('totalWealth', () => {
  it('无地产时等于现金', () => {
    const player = createPlayer(0, 'Test', false)
    expect(totalWealth(player)).toBe(1500)
  })

  it('有地产时等于现金加地产价值', () => {
    const player = createPlayer(0, 'Test', false)
    player.properties.push(1) // 厦门 price=60
    player.properties.push(3) // 青岛 price=80
    expect(totalWealth(player)).toBe(1640) // 1500 + 60 + 80
  })
})

describe('getStartBonus', () => {
  it('第1回合 200', () => {
    expect(getStartBonus(1)).toBe(200)
  })

  it('第6回合 250', () => {
    expect(getStartBonus(6)).toBe(250) // 200 + floor((6-1)/5)*50 = 200 + 50 = 250
  })

  it('高回合上限 400', () => {
    expect(getStartBonus(30)).toBe(400) // 上限
    expect(getStartBonus(100)).toBe(400)
  })
})
