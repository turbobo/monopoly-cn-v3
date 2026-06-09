// 大富翁中国行 - 核心游戏引擎

// ===== 类型定义 =====
export type TileType = 'property' | 'railroad' | 'chance' | 'tax' | 'start' | 'jail' | 'parking' | 'goto_jail' | 'utility'

export interface Tile {
  id: number
  type: TileType
  name: string
  price: number
  rent: number[]         // rent[0]=基础, rent[1]=同色2块, rent[2]=同色全套
  color: string          // 地皮颜色组
  emoji: string
}

export interface Player {
  id: number
  name: string
  avatar: string
  money: number
  position: number       // 0-27
  properties: number[]   // tile ids
  inJail: boolean
  jailTurns: number
  bankrupt: boolean
  isAI: boolean
  aiPersonality?: 'aggressive' | 'balanced' | 'conservative'
  color: string
}

export interface GameState {
  players: Player[]
  currentPlayer: number   // index
  round: number
  maxRounds: number
  dice: [number, number]
  phase: 'roll' | 'action' | 'auction' | 'trade' | 'end'
  log: string[]
  gameOver: boolean
  winner: number | null
  difficulty: 'easy' | 'normal' | 'hard'
}

// ===== 棋盘数据 (28格) =====
// 顺时针：底部(7) → 右侧(7) → 顶部(7) → 左侧(7)
export const BOARD: Tile[] = [
  // --- 底部 (0-6) ---
  { id: 0,  type: 'start',     name: '起点',     price: 0,    rent: [],    color: '', emoji: '🏁' },
  { id: 1,  type: 'property',  name: '厦门',     price: 60,   rent: [6, 12, 30],    color: '#8B4513', emoji: '🏖️' },
  { id: 2,  type: 'chance',    name: '机会',     price: 0,    rent: [],    color: '', emoji: '❓' },
  { id: 3,  type: 'property',  name: '青岛',     price: 80,   rent: [8, 16, 40],    color: '#8B4513', emoji: '🌊' },
  { id: 4,  type: 'tax',       name: '个人所得税', price: 0,  rent: [],    color: '', emoji: '💸' },
  { id: 5,  type: 'property',  name: '大连',     price: 100,  rent: [10, 20, 50],   color: '#87CEEB', emoji: '⛵' },
  { id: 6,  type: 'railroad',  name: '高铁站',   price: 150,  rent: [25, 50, 75],   color: '#333', emoji: '🚄' },
  // --- 右侧 (7-13) ---
  { id: 7,  type: 'jail',      name: '监狱探访', price: 0,    rent: [],    color: '', emoji: '🔒' },
  { id: 8,  type: 'property',  name: '重庆',     price: 120,  rent: [12, 24, 60],   color: '#FF4500', emoji: '🌶️' },
  { id: 9,  type: 'property',  name: '西安',     price: 140,  rent: [14, 28, 70],   color: '#FF4500', emoji: '🏛️' },
  { id: 10, type: 'utility',   name: '国家电网', price: 150,  rent: [20, 40, 60],   color: '#FFD700', emoji: '⚡' },
  { id: 11, type: 'property',  name: '长沙',     price: 160,  rent: [16, 32, 80],   color: '#FF4500', emoji: '🎆' },
  { id: 12, type: 'chance',    name: '机会',     price: 0,    rent: [],    color: '', emoji: '❓' },
  { id: 13, type: 'property',  name: '杭州',     price: 200,  rent: [20, 40, 100],  color: '#FF69B4', emoji: '🌸' },
  // --- 顶部 (14-20) ---
  { id: 14, type: 'parking',   name: '免费停车', price: 0,    rent: [],    color: '', emoji: '🅿️' },
  { id: 15, type: 'property',  name: '成都',     price: 220,  rent: [22, 44, 110],  color: '#32CD32', emoji: '🐼' },
  { id: 16, type: 'property',  name: '广州',     price: 240,  rent: [24, 48, 120],  color: '#32CD32', emoji: '🌴' },
  { id: 17, type: 'tax',       name: '房产税',   price: 0,    rent: [],    color: '', emoji: '🏦' },
  { id: 18, type: 'property',  name: '南京',     price: 260,  rent: [26, 52, 130],  color: '#32CD32', emoji: '🏯' },
  { id: 19, type: 'railroad',  name: '机场',     price: 200,  rent: [30, 60, 90],   color: '#333', emoji: '✈️' },
  { id: 20, type: 'property',  name: '深圳',     price: 300,  rent: [30, 60, 150],  color: '#4169E1', emoji: '🏙️' },
  // --- 左侧 (21-27) ---
  { id: 21, type: 'goto_jail', name: '入狱',     price: 0,    rent: [],    color: '', emoji: '👮' },
  { id: 22, type: 'property',  name: '苏州',     price: 280,  rent: [28, 56, 140],  color: '#4169E1', emoji: '🏮' },
  { id: 23, type: 'chance',    name: '机会',     price: 0,    rent: [],    color: '', emoji: '❓' },
  { id: 24, type: 'property',  name: '天津',     price: 320,  rent: [32, 64, 160],  color: '#4169E1', emoji: '🎡' },
  { id: 25, type: 'property',  name: '上海',     price: 350,  rent: [35, 70, 175],  color: '#9932CC', emoji: '🌃' },
  { id: 26, type: 'property',  name: '北京',     price: 400,  rent: [40, 80, 200],  color: '#9932CC', emoji: '🏰' },
  { id: 27, type: 'utility',   name: '中国移动', price: 180,  rent: [25, 50, 75],   color: '#FFD700', emoji: '📱' },
]

export const BOARD_SIZE = BOARD.length // 28

// 颜色分组
export const COLOR_GROUPS: Record<string, number[]> = {
  '#8B4513': [1, 3],       // 棕色: 厦门, 青岛
  '#87CEEB': [5],          // 浅蓝: 大连
  '#FF4500': [8, 9, 11],   // 橙红: 重庆, 西安, 长沙
  '#FF69B4': [13],         // 粉色: 杭州
  '#32CD32': [15, 16, 18], // 绿色: 成都, 广州, 南京
  '#4169E1': [20, 22, 24], // 蓝色: 深圳, 苏州, 天津
  '#9932CC': [25, 26],     // 紫色: 上海, 北京
}

// 机会卡
export const CHANCE_CARDS: { text: string; effect: (gs: GameState) => string }[] = [
  { text: '年终奖到账！获得 ¥100', effect: (gs) => { gs.players[gs.currentPlayer].money += 100; return '+¥100'; } },
  { text: '手机丢了，维修花 ¥50', effect: (gs) => { gs.players[gs.currentPlayer].money -= 50; return '-¥50'; } },
  { text: '中彩票了！获得 ¥200', effect: (gs) => { gs.players[gs.currentPlayer].money += 200; return '+¥200'; } },
  { text: '交通违章罚款 ¥80', effect: (gs) => { gs.players[gs.currentPlayer].money -= 80; return '-¥80'; } },
  { text: '股票大涨！获得 ¥150', effect: (gs) => { gs.players[gs.currentPlayer].money += 150; return '+¥150'; } },
  { text: '生病住院，花费 ¥120', effect: (gs) => { gs.players[gs.currentPlayer].money -= 120; return '-¥120'; } },
  { text: '朋友还钱了！获得 ¥80', effect: (gs) => { gs.players[gs.currentPlayer].money += 80; return '+¥80'; } },
  { text: '红包雨！获得 ¥60', effect: (gs) => { gs.players[gs.currentPlayer].money += 60; return '+¥60'; } },
  { text: '回起点领工资 ¥200', effect: (gs) => { gs.players[gs.currentPlayer].position = 0; gs.players[gs.currentPlayer].money += 200; return '回到起点 +¥200'; } },
  { text: '进监狱！直接入狱', effect: (gs) => {
    const player = gs.players[gs.currentPlayer]
    const oldPos = player.position
    player.position = 7
    player.inJail = true
    player.jailTurns = 0
    // 如果经过起点（从后面走到位置7），获得¥200
    if (oldPos > 7) {
      player.money += 200
      return '入狱！经过起点 +¥200'
    }
    return '入狱！'
  }},
]

// ===== 玩家颜色/头像 =====
export const PLAYER_PRESETS = [
  { avatar: '🧑', color: '#ef4444' },
  { avatar: '🤖', color: '#3b82f6' },
  { avatar: '🧠', color: '#10b981' },
  { avatar: '🎭', color: '#f59e0b' },
]

// ===== 工具函数 =====
export function rollDice(): [number, number] {
  return [Math.floor(Math.random() * 6) + 1, Math.floor(Math.random() * 6) + 1]
}

export function createPlayer(id: number, name: string, isAI: boolean, personality?: 'aggressive' | 'balanced' | 'conservative', initialMoney: number = 1500): Player {
  const preset = PLAYER_PRESETS[id % PLAYER_PRESETS.length]
  return {
    id, name, avatar: isAI ? (personality === 'aggressive' ? '🔥' : personality === 'conservative' ? '🛡️' : '🤖') : preset.avatar,
    money: initialMoney, position: 0, properties: [], inJail: false, jailTurns: 0,
    bankrupt: false, isAI, aiPersonality: personality, color: preset.color,
  }
}

// ===== 计算租金（含回合加成） =====
export function calculateRent(tile: Tile, owner: Player, allPlayers: Player[], round: number = 1): number {
  if (tile.type === 'tax') {
    return tile.name === '个人所得税' ? 100 : 150
  }

  let baseRent = 0

  if (tile.type === 'railroad') {
    const railroads = owner.properties.filter(id => BOARD[id].type === 'railroad').length
    baseRent = tile.rent[Math.min(railroads, tile.rent.length) - 1] || tile.rent[0]
  } else if (tile.type === 'utility') {
    const utilities = owner.properties.filter(id => BOARD[id].type === 'utility').length
    baseRent = tile.rent[Math.min(utilities, tile.rent.length) - 1] || tile.rent[0]
  } else if (tile.type === 'property') {
    const sameColor = (COLOR_GROUPS[tile.color] || []).filter(id =>
      owner.properties.includes(id)
    ).length
    const totalInGroup = (COLOR_GROUPS[tile.color] || []).length
    if (sameColor === totalInGroup) baseRent = tile.rent[2] || tile.rent[0]
    else if (sameColor >= 2) baseRent = tile.rent[1] || tile.rent[0]
    else baseRent = tile.rent[0]
  }

  // 回合加成：10回合后x1.5，20回合后x2.0
  const roundMultiplier = round >= 20 ? 2.0 : round >= 10 ? 1.5 : 1.0
  return Math.floor(baseRent * roundMultiplier)
}

// ===== 经过起点奖金（随回合递增） =====
export function getStartBonus(round: number): number {
  const extra = Math.floor((round - 1) / 5) * 50
  return Math.min(200 + extra, 400)
}

// ===== 玩家总资产 =====
export function totalWealth(player: Player): number {
  return player.money + player.properties.reduce((sum, id) => sum + BOARD[id].price, 0)
}

// ===== 移动玩家 =====
export function movePlayer(player: Player, steps: number, round: number = 1): number {
  const oldPos = player.position
  player.position = (player.position + steps) % BOARD_SIZE
  // 经过起点
  if (player.position < oldPos) {
    const bonus = getStartBonus(round)
    player.money += bonus
    return bonus
  }
  return 0
}

// ===== 处理机会卡 =====
export function drawChance(gs: GameState): string {
  const card = CHANCE_CARDS[Math.floor(Math.random() * CHANCE_CARDS.length)]
  const effect = card.effect(gs)
  return `${card.text}（${effect}）`
}

// ===== 购买地皮 =====
export function buyProperty(player: Player, tileId: number): boolean {
  const tile = BOARD[tileId]
  if (player.money >= tile.price) {
    player.money -= tile.price
    player.properties.push(tileId)
    return true
  }
  return false
}

// ===== 检查破产 =====
export function checkBankrupt(player: Player): { bankrupt: boolean; soldTiles: number[] } {
  const soldTiles: number[] = []
  if (player.money < 0) {
    // 尝试卖地（从最便宜的开始）
    const sorted = [...player.properties].sort((a, b) => BOARD[a].price - BOARD[b].price)
    for (const tileId of sorted) {
      player.money += Math.floor(BOARD[tileId].price * 0.6) // 6折卖
      player.properties = player.properties.filter(id => id !== tileId)
      soldTiles.push(tileId)
      if (player.money >= 0) break
    }
    if (player.money < 0) {
      player.bankrupt = true
      return { bankrupt: true, soldTiles }
    }
  }
  // 总资产为0：无现金且无地皮，判定破产
  if (player.money <= 0 && player.properties.length === 0) {
    player.bankrupt = true
    return { bankrupt: true, soldTiles }
  }
  return { bankrupt: false, soldTiles }
}

// ===== AI决策 =====
export function aiDecision(player: Player, tile: Tile, difficulty: 'easy' | 'normal' | 'hard' = 'normal'): boolean {
  if (!player.isAI) return false
  if (tile.type !== 'property' && tile.type !== 'railroad' && tile.type !== 'utility') return false

  const personality = player.aiPersonality || 'balanced'

  // 难度系数：简单=更保守，困难=更激进
  const diffMultiplier = difficulty === 'easy' ? 1.5 : difficulty === 'hard' ? 0.7 : 1.0

  if (personality === 'aggressive') {
    // 激进型：只要买得起就买
    return player.money >= tile.price * 0.8 * diffMultiplier
  }
  if (personality === 'conservative') {
    // 保守型：只买便宜且有余钱的
    return player.money >= tile.price * 1.8 * diffMultiplier && tile.price <= 200
  }
  // 平衡型：看性价比 + 保留安全资金
  if (tile.price > 300 && player.money < tile.price * 2 * diffMultiplier) return false
  return player.money >= tile.price * 1.2 * diffMultiplier
}

// ===== AI拍卖决策 =====
export function auctionDecision(player: Player, tile: Tile, currentBid: number): number {
  if (!player.isAI || player.bankrupt) return 0
  const personality = player.aiPersonality || 'balanced'
  const maxWilling = personality === 'aggressive' ? tile.price * 0.95
    : personality === 'conservative' ? tile.price * 0.6
    : tile.price * 0.8

  if (currentBid >= maxWilling || currentBid >= player.money * 0.6) return 0
  return Math.min(currentBid + 20, Math.floor(maxWilling))
}

// ===== AI交易决策（作为卖方） =====
export function tradeDecision(seller: Player, tile: Tile, offer: number): boolean {
  if (!seller.isAI) return false
  const personality = seller.aiPersonality || 'balanced'
  const minAccept = personality === 'aggressive' ? tile.price * 1.5
    : personality === 'conservative' ? tile.price * 1.2
    : tile.price * 1.3
  return offer >= minAccept
}

// ===== AI 主动变卖资产决策 =====
export function aiSellDecision(player: Player): number | null {
  if (!player.isAI || player.properties.length === 0) return null
  const personality = player.aiPersonality || 'balanced'
  const threshold = personality === 'aggressive' ? 50
    : personality === 'conservative' ? 150
    : 100
  if (player.money >= threshold) return null

  // 优先卖不在同色组内的最便宜地皮
  const sorted = [...player.properties].sort((a, b) => BOARD[a].price - BOARD[b].price)
  for (const tileId of sorted) {
    const tile = BOARD[tileId]
    const group = COLOR_GROUPS[tile.color]
    if (!group) return tileId
    const owned = group.filter(id => player.properties.includes(id)).length
    if (owned < group.length) return tileId
  }
  return sorted[0]
}

// ===== AI 主动发起交易决策（作为买方） =====
export function aiTradeInitDecision(buyer: Player, gs: GameState): { targetId: number; tileId: number; offer: number } | null {
  if (!buyer.isAI || buyer.bankrupt) return null
  const personality = buyer.aiPersonality || 'balanced'

  for (const [color, group] of Object.entries(COLOR_GROUPS)) {
    const owned = group.filter(id => buyer.properties.includes(id))
    if (owned.length === 0 || owned.length >= group.length) continue
    const missing = group.filter(id => !buyer.properties.includes(id))

    for (const tileId of missing) {
      const tile = BOARD[tileId]
      const owner = gs.players.find(p => p.properties.includes(tileId) && !p.bankrupt && p.id !== buyer.id)
      if (!owner) continue

      const mult = personality === 'aggressive' ? 1.6
        : personality === 'conservative' ? 1.3
        : 1.4
      const offer = Math.floor(tile.price * mult)

      if (offer <= buyer.money * 0.5) {
        return { targetId: owner.id, tileId, offer }
      }
    }
  }
  return null
}

// ===== 游戏回合推进 =====
export function executeTurn(gs: GameState, preRolledDice?: [number, number]): string[] {
  const messages: string[] = []
  const player = gs.players[gs.currentPlayer]

  if (player.bankrupt) {
    messages.push(`${player.name} 已破产，跳过回合`)
    nextPlayer(gs)
    return messages
  }

  // 监狱逻辑
  if (player.inJail) {
    player.jailTurns++
    if (player.jailTurns >= 3) {
      player.inJail = false
      player.jailTurns = 0
      player.money -= 50 // 保释金
      messages.push(`💰 ${player.name} 缴纳保释金 ¥50 出狱`)
    } else {
      const jailDice = preRolledDice || rollDice()
      if (jailDice[0] === jailDice[1]) {
        player.inJail = false
        player.jailTurns = 0
        messages.push(`🎲 ${player.name} 掷出双数 ${jailDice[0]}+${jailDice[1]}，越狱成功！`)
        // 使用同一个骰子移动，不再重新掷骰
        const total = jailDice[0] + jailDice[1]
        gs.dice = jailDice
        const bonus = movePlayer(player, total, gs.round)
        if (bonus > 0) messages.push(`💰 ${player.name} 经过起点，获得 ¥${bonus}`)
        const tile = BOARD[player.position]
        messages.push(`📍 ${player.name} 到达 ${tile.emoji} ${tile.name}`)
        // 继续处理格子逻辑...
        return processTile(gs, tile, messages)
      } else {
        messages.push(`🎲 ${player.name} 在监狱掷骰 ${jailDice[0]}+${jailDice[1]}，未出双数，继续等待`)
        nextPlayer(gs)
        return messages
      }
    }
  }

  // 使用预掷骰子或新掷
  const dice = preRolledDice || rollDice()
  gs.dice = dice
  const total = dice[0] + dice[1]
  messages.push(`🎲 ${player.name} 掷出 ${dice[0]} + ${dice[1]} = ${total}`)

  // 移动
  const bonus = movePlayer(player, total, gs.round)
  if (bonus > 0) messages.push(`💰 ${player.name} 经过起点，获得 ¥${bonus}`)

  const tile = BOARD[player.position]
  messages.push(`📍 ${player.name} 到达 ${tile.emoji} ${tile.name}`)

  return processTile(gs, tile, messages)
}

// 处理格子效果
function processTile(gs: GameState, tile: Tile, messages: string[]): string[] {
  const player = gs.players[gs.currentPlayer]
  switch (tile.type) {
    case 'start':
      messages.push(`😌 ${player.name} 在起点休息`)
      break
    case 'jail':
      messages.push(`👀 ${player.name} 来探监，虚惊一场`)
      break
    case 'parking':
      messages.push(`🅿️ ${player.name} 在免费停车休息`)
      break
    case 'goto_jail':
      player.inJail = true
      player.jailTurns = 0
      player.position = 7
      messages.push(`👮 ${player.name} 被送进监狱！`)
      break
    case 'tax':
      const tax = tile.name === '个人所得税' ? 100 : 150
      player.money -= tax
      messages.push(`💸 ${player.name} 缴纳${tile.name} ¥${tax}`)
      break
    case 'chance':
      const chanceMsg = drawChance(gs)
      messages.push(`❓ ${player.name} ${chanceMsg}`)
      break
    case 'property':
    case 'railroad':
    case 'utility': {
      // 检查是否有人拥有
      const owner = gs.players.find(p => p.properties.includes(tile.id))
      if (owner && owner.id !== player.id && !owner.bankrupt) {
        const rent = calculateRent(tile, owner, gs.players, gs.round)
        player.money -= rent
        owner.money += rent
        messages.push(`💰 ${player.name} 向 ${owner.name} 支付租金 ¥${rent}`)
      } else if (!owner) {
        // AI或玩家决定是否购买
        if (player.isAI) {
          if (aiDecision(player, tile, gs.difficulty)) {
            buyProperty(player, tile.id)
            messages.push(`🏠 ${player.name} 购买了 ${tile.name}（¥${tile.price}）`)
          } else {
            messages.push(`❌ ${player.name} 决定不买 ${tile.name}`)
          }
        } else {
          // 玩家需要在UI中决定（余额不足时跳过）
          if (player.money >= tile.price) {
            gs.phase = 'action'
            messages.push(`🤔 ${player.name} 是否购买 ${tile.name}？价格 ¥${tile.price}`)
            return messages
          } else {
            messages.push(`💸 ${player.name} 资金不足，无法购买 ${tile.name}（需要 ¥${tile.price}）`)
          }
        }
      } else {
        messages.push(`🏡 ${player.name} 回到自己的地盘 ${tile.name}`)
      }
      break
    }
  }

  // 检查破产（含卖地消息）
  const bankruptResult = checkBankrupt(player)
  for (const tileId of bankruptResult.soldTiles) {
    messages.push(`🏷️ ${player.name} 被迫卖出了 ${BOARD[tileId].name}（6折 ¥${Math.floor(BOARD[tileId].price * 0.6)}）`)
  }
  if (bankruptResult.bankrupt) {
    messages.push(`💀 ${player.name} 破产了！`)
  }

  // 检查游戏结束
  const activePlayers = gs.players.filter(p => !p.bankrupt)
  if (activePlayers.length <= 1) {
    gs.gameOver = true
    gs.winner = activePlayers[0]?.id ?? null
    messages.push(`🎉 游戏结束！${activePlayers[0]?.name} 获胜！`)
  }

  nextPlayer(gs)
  return messages
}

function nextPlayer(gs: GameState) {
  let next = (gs.currentPlayer + 1) % gs.players.length
  let safety = 0
  while (gs.players[next].bankrupt && safety < gs.players.length) {
    next = (next + 1) % gs.players.length
    safety++
  }
  if (next <= gs.currentPlayer) gs.round++
  gs.currentPlayer = next
  gs.phase = 'roll'

  // 检查回合上限
  if (gs.round > gs.maxRounds && !gs.gameOver) {
    gs.gameOver = true
    const richest = [...gs.players].filter(p => !p.bankrupt).sort((a, b) => totalWealth(b) - totalWealth(a))
    gs.winner = richest[0]?.id ?? null
    gs.log.push(`⏰ ${gs.maxRounds}回合结束！${richest[0]?.name} 以总资产最高获胜！`)
  }
}

// ===== 创建游戏 =====
export function createGame(mode: 'ai' | 'local', playerCount: number, initialMoney: number = 1500, difficulty: 'easy' | 'normal' | 'hard' = 'normal'): GameState {
  const players: Player[] = []

  if (mode === 'ai') {
    players.push(createPlayer(0, '你', false, undefined, initialMoney))
    // playerCount = AI对手数量（1/2/3）
    const personalities: ('aggressive' | 'balanced' | 'conservative')[] = ['aggressive', 'balanced', 'conservative']
    const names = ['小火', '阿平', '老守']
    for (let i = 0; i < Math.min(playerCount, 3); i++) {
      players.push(createPlayer(i + 1, names[i], true, personalities[i], initialMoney))
    }
  } else {
    const names = ['玩家1', '玩家2', '玩家3', '玩家4']
    for (let i = 0; i < playerCount; i++) {
      players.push(createPlayer(i, names[i], false, undefined, initialMoney))
    }
  }

  return {
    players, currentPlayer: 0, round: 1, maxRounds: 30,
    dice: [1, 1], phase: 'roll', log: ['🎲 游戏开始！'], gameOver: false, winner: null,
    difficulty,
  }
}
