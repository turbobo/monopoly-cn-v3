// 大富翁中国行 - Canvas棋盘渲染 (v4: 占领强化+逐格移动动画)
import { BOARD, BOARD_SIZE, Player, Roadblock } from './game-engine'

// 道具卡地图标记数据
interface TileEffects {
  roadblocks: Roadblock[]
  priceHikes: { tileId: number; ownerPlayerId: number; roundsLeft: number }[]
}

interface Particle {
  x: number; y: number; vx: number; vy: number
  size: number; alpha: number; color: string; life: number; maxLife: number
}

interface FloatingText {
  text: string; x: number; y: number; color: string
  life: number; maxLife: number; fontSize: number
}

// 移动动画状态
interface MoveAnim {
  active: boolean
  playerId: number
  fromTile: number
  currentTile: number
  targetTile: number
  stepsLeft: number
  progress: number
  speed: number
  color: string
  avatar: string
  onComplete: (() => void) | null
  onStep: (() => void) | null
}

// 金币飞行粒子（收租动画）
interface CoinParticle {
  sx: number; sy: number; ex: number; ey: number  // 起点终点
  cx1: number; cy1: number; cx2: number; cy2: number  // 贝塞尔控制点
  progress: number; speed: number; delay: number
  arrived: boolean
}

// 建筑升起动画
interface BuildAnim {
  tileIndex: number; color: string; emoji: string
  progress: number; speed: number; settled: boolean; settleTimer: number
}

// 卡片全屏特效
interface CardEffectAnim {
  type: string; tileIndex?: number; tileIndex2?: number
  progress: number; speed: number; active: boolean
}

// NPC 入场动画
interface NPCAnim {
  type: 'god_wealth' | 'god_poverty' | 'police' | 'dog'
  tileIndex: number
  progress: number    // 0→1 入场, 1→2 表演, 2→3 离场
  speed: number
  emoji: string
}

export class BoardRenderer {
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private size: number = 0
  private tileSize: number = 0
  private cornerSize: number = 0
  private dpr: number = 1
  private animId: number = -1
  private time: number = 0
  private dt: number = 1
  private particles: Particle[] = []
  private floatingTexts: FloatingText[] = []

  private diceAnim = {
    active: false, values: [1, 1] as [number, number], progress: 0,
    shuffleValues: [1, 1] as [number, number], landed: false,
    onLand: null as (() => void) | null,
    landBounce: 0, showResult: 0, speedMultiplier: 1,
  }
  private lastDice: [number, number] = [1, 1]
  private diceVisible = false
  private currentHighlight = -1
  private lastPlayers: Player[] | undefined
  private lastHighlightTile: number | undefined
  private lastEffects: TileEffects = { roadblocks: [], priceHikes: [] }

  // 逐格移动动画
  private moveAnim: MoveAnim = {
    active: false, playerId: -1, fromTile: 0, currentTile: 0, targetTile: 0,
    stepsLeft: 0, progress: 0, speed: 0.039, color: '', avatar: '', onComplete: null, onStep: null,
  }

  // 事件动画
  private coinAnims: CoinParticle[] = []
  private buildAnims: BuildAnim[] = []
  private cardEffects: CardEffectAnim[] = []
  private shakeTimer = 0
  private npcAnims: NPCAnim[] = []

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    this.ctx = canvas.getContext('2d')!
  }

  /** 按 DPR 缩放像素值 */
  private px(n: number): number { return Math.round(n * this.dpr) }
  /** 生成 DPR 适配的 font 字符串 */
  private font(size: number, family: string = 'sans-serif', weight: string = ''): string {
    return `${weight} ${this.px(size)}px ${family}`.trim()
  }

  resize() {
    const container = this.canvas.parentElement
    if (!container) return
    const isMobile = window.innerWidth < 768
    const maxW = isMobile
      ? Math.min(window.innerWidth - 16, window.innerHeight * 0.55)
      : Math.min(window.innerWidth * 0.6, window.innerHeight * 0.9)
    const w = Math.min(container.clientWidth - 8, container.clientHeight - 8, maxW)
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    this.dpr = dpr
    this.canvas.width = w * dpr
    this.canvas.height = w * dpr
    this.canvas.style.width = w + 'px'
    this.canvas.style.height = w + 'px'
    this.size = w * dpr
    this.tileSize = this.size / 8.5
    this.cornerSize = this.tileSize * 1.3
  }

  private _lastTimestamp = 0

  start() {
    this.stop()  // 防止重复创建 rAF 循环
    this._lastTimestamp = 0
    const loop = (timestamp: number) => {
      const dt = this._lastTimestamp ? Math.min((timestamp - this._lastTimestamp) / 16.667, 3) : 1
      this._lastTimestamp = timestamp
      this.dt = dt
      this.time += 0.016 * dt
      this.updateParticles(dt)
      this.updateMoveAnim(dt)
      this.updateCoinAnims(dt)
      this.updateBuildAnims(dt)
      this.updateCardEffects(dt)
      this.updateNPCAnims(dt)
      if (this.shakeTimer > 0) this.shakeTimer -= dt
      this.draw()
      this.animId = requestAnimationFrame(loop)
    }
    this.animId = requestAnimationFrame(loop)
  }

  stop() { cancelAnimationFrame(this.animId) }

  setCurrentPlayer(index: number) { this.currentHighlight = index }
  isMoving(): boolean { return this.moveAnim.active }

  // ===== 逐格移动动画 =====
  playMoveAnimation(playerId: number, fromTile: number, steps: number, color: string, avatar: string, onComplete: () => void, onStep?: () => void, speedMultiplier: number = 1) {
    if (steps <= 0) {
      onComplete()
      return
    }
    this.moveAnim = {
      active: true, playerId, fromTile, currentTile: fromTile,
      targetTile: (fromTile + steps) % BOARD_SIZE, stepsLeft: steps,
      progress: 0, speed: 0.039 * Math.max(speedMultiplier, 0.1), color, avatar,
      onComplete, onStep: onStep || null,
    }
  }

  private updateMoveAnim(dt: number = 1) {
    if (!this.moveAnim.active) return
    const m = this.moveAnim
    m.progress += m.speed * dt

    if (m.progress >= 1) {
      m.currentTile = (m.currentTile + 1) % BOARD_SIZE
      m.stepsLeft--
      m.progress = 0

      // 每经过一格：粒子 + 音效
      const pos = this.getTilePosition(m.currentTile)
      this.emitBurst(pos.x + pos.w / 2, pos.y + pos.h / 2, 3, m.color)
      if (m.onStep) m.onStep()

      if (m.stepsLeft <= 0) {
        m.active = false
        const endPos = this.getTilePosition(m.currentTile)
        this.emitBurst(endPos.x + endPos.w / 2, endPos.y + endPos.h / 2, 15, m.color)
        if (m.onComplete) m.onComplete()
      }
    }
  }

  // 获取移动动画中玩家当前的插值位置+旋转+缩放
  private getMoveAnimPosition(): { x: number; y: number; rotation: number; scaleX: number; scaleY: number } | null {
    if (!this.moveAnim.active) return null
    const m = this.moveAnim
    const fromPos = this.getTilePosition(m.currentTile)
    const toPos = this.getTilePosition((m.currentTile + 1) % BOARD_SIZE)

    const fx = fromPos.x + fromPos.w / 2
    const fy = fromPos.y + fromPos.h / 2 + 24
    const tx = toPos.x + toPos.w / 2
    const ty = toPos.y + toPos.h / 2 + 24

    const t = m.progress

    // 跳跃弧线（抛物线）
    const jumpHeight = 25
    const arcY = -Math.sin(t * Math.PI) * jumpHeight

    // 水平移动（缓入缓出）
    const easeX = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2

    // 形变效果（起跳拉伸，落地压扁）
    let scaleX = 1, scaleY = 1
    if (t < 0.15) {
      // 起跳：纵向拉伸
      const stretch = t / 0.15
      scaleX = 1 - stretch * 0.2
      scaleY = 1 + stretch * 0.3
    } else if (t > 0.85) {
      // 落地：横向压扁
      const squash = (t - 0.85) / 0.15
      scaleX = 1 + squash * 0.25
      scaleY = 1 - squash * 0.2
    }

    // 旋转（前进方向旋转）
    const rotation = t * Math.PI * 2

    return {
      x: fx + (tx - fx) * easeX,
      y: fy + (ty - fy) * easeX + arcY,
      rotation,
      scaleX,
      scaleY,
    }
  }

  // ===== 浮动文字 =====
  showFloatingText(tileIndex: number, text: string, color: string) {
    const pos = this.getTilePosition(tileIndex)
    this.floatingTexts.push({ text, x: pos.x + pos.w / 2, y: pos.y - 10, color, life: 0, maxLife: 117, fontSize: 20 })
  }

  showCenterFloat(text: string, color: string) {
    this.floatingTexts.push({ text, x: this.size / 2, y: this.size / 2 + 120, color, life: 0, maxLife: 104, fontSize: 24 })
  }

  // ===== 骰子动画 =====
  playDiceAnimation(values: [number, number], onLand?: () => void, speedMultiplier: number = 1) {
    this.diceAnim = {
      active: true, values, progress: 0,
      shuffleValues: [Math.ceil(Math.random() * 6), Math.ceil(Math.random() * 6)],
      landed: false, onLand: onLand || null,
      landBounce: 0, showResult: 0,
      speedMultiplier,
    }
    this.diceVisible = true
    this.lastDice = values
  }

  private updateDiceAnim() {
    const d = this.diceAnim
    if (!d.active) {
      if (d.showResult > 0 && d.showResult < 1) d.showResult = Math.min(1, d.showResult + 0.04)
      return
    }
    d.progress += 0.022 * (d.speedMultiplier || 1) * this.dt

    // 翻滚阶段：快速切换面值（越接近结束越慢）
    const shuffleRate = d.progress < 0.5 ? 0.6 : d.progress < 0.75 ? 0.35 : 0.12
    if (d.progress < 0.85 && Math.random() < shuffleRate) {
      d.shuffleValues = [Math.ceil(Math.random() * 6), Math.ceil(Math.random() * 6)]
    }

    // 落地
    if (d.progress >= 1 && !d.landed) {
      d.landed = true
      d.active = false
      d.landBounce = 1
      d.showResult = 0.01
      // 多色粒子爆发
      const cx = this.size / 2, cy = this.size / 2 + 55
      this.emitBurst(cx - 42, cy, 12, '#f59e0b')
      this.emitBurst(cx + 42, cy, 12, '#f59e0b')
      this.emitBurst(cx - 42, cy, 6, '#fbbf24')
      this.emitBurst(cx + 42, cy, 6, '#fbbf24')
      if (d.onLand) d.onLand()
    }

    // 落地弹跳衰减（三段式）
    if (d.landBounce > 0) {
      const decay = d.landBounce > 0.5 ? 0.88 : d.landBounce > 0.2 ? 0.82 : 0.75
      d.landBounce *= decay
      if (d.landBounce < 0.005) d.landBounce = 0
    }
  }

  // ===== 粒子 =====
  private emitBurst(x: number, y: number, count: number, color: string) {
    for (let i = 0; i < count; i++) {
      const angle = (Math.PI * 2 * i) / count + Math.random() * 0.5
      const speed = Math.random() * 3 + 1.5
      this.particles.push({ x, y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, size: Math.random() * 4 + 2, alpha: 1, color, life: 0, maxLife: 40 + Math.random() * 20 })
    }
  }

  private updateParticles(dt: number = 1) {
    this.particles = this.particles.filter(p => {
      p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 0.05 * dt; p.life += dt
      p.alpha = Math.max(0, 1 - p.life / p.maxLife)
      return p.life < p.maxLife
    })
  }

  // ===== 主绘制 =====
  draw(players?: Player[], highlightTile?: number, effects?: TileEffects) {
    if (players) this.lastPlayers = players
    if (highlightTile !== undefined) this.lastHighlightTile = highlightTile
    if (effects) this.lastEffects = effects

    const usePlayers = players || this.lastPlayers
    const useHighlight = highlightTile ?? this.lastHighlightTile
    const useEffects = effects || this.lastEffects

    const { ctx, size } = this
    ctx.clearRect(0, 0, size, size)

    // 屏幕震动偏移
    if (this.shakeTimer > 0) {
      const intensity = this.shakeTimer * 3
      ctx.save()
      ctx.translate(
        (Math.random() - 0.5) * intensity * 2,
        (Math.random() - 0.5) * intensity * 2,
      )
    }

    // 高级深蓝背景（与设置界面一致）
    const bgGrad = ctx.createRadialGradient(size * 0.4, size * 0.35, 0, size / 2, size / 2, size * 0.75)
    bgGrad.addColorStop(0, '#243040')
    bgGrad.addColorStop(0.5, '#1a2332')
    bgGrad.addColorStop(1, '#131a26')
    ctx.fillStyle = bgGrad
    ctx.fillRect(0, 0, size, size)

    // 微妙对角线织纹
    ctx.save()
    ctx.globalAlpha = 0.025
    ctx.strokeStyle = '#ffffff'
    ctx.lineWidth = 0.5
    for (let t = -size; t < size * 2; t += 16) {
      ctx.beginPath()
      ctx.moveTo(t, 0)
      ctx.lineTo(t + size, size)
      ctx.stroke()
      ctx.beginPath()
      ctx.moveTo(t + size, 0)
      ctx.lineTo(t, size)
      ctx.stroke()
    }
    ctx.restore()

    // 顶部柔光
    ctx.save()
    ctx.globalAlpha = 0.05
    const topLight = ctx.createRadialGradient(size * 0.4, 0, 0, size * 0.4, 0, size * 0.6)
    topLight.addColorStop(0, '#ffffff')
    topLight.addColorStop(1, 'transparent')
    ctx.fillStyle = topLight
    ctx.fillRect(0, 0, size, size * 0.5)
    ctx.restore()

    this.drawBoard(useHighlight, usePlayers, useEffects)
    this.drawCenter()
    if (usePlayers) this.drawPlayers(usePlayers)
    this.drawFloatingTexts()
    this.drawParticles()
    this.drawCoinAnims()
    this.drawBuildAnims()
    this.drawCardEffects()
    this.drawNPCAnims()
    this.updateDiceAnim()

    // 屏幕震动恢复
    if (this.shakeTimer > 0) ctx.restore()
  }

  // ===== 格子位置 =====
  private getTilePosition(index: number) {
    const s = this.size, cs = this.cornerSize, normal = (s - cs * 2) / 6
    let x = 0, y = 0, w = 0, h = 0, side: 'bottom' | 'right' | 'top' | 'left' = 'bottom', isCorner = false

    if (index === 0) { x = s - cs; y = s - cs; w = cs; h = cs; isCorner = true }
    else if (index >= 1 && index <= 6) { const i = index - 1; x = s - cs - normal * (i + 1); y = s - cs; w = normal; h = cs }
    else if (index === 7) { x = 0; y = s - cs; w = cs; h = cs; side = 'right'; isCorner = true }
    else if (index >= 8 && index <= 13) { const i = index - 8; x = 0; y = s - cs - normal * (i + 1); w = cs; h = normal; side = 'right' }
    else if (index === 14) { x = 0; y = 0; w = cs; h = cs; side = 'top'; isCorner = true }
    else if (index >= 15 && index <= 20) { const i = index - 15; x = cs + normal * i; y = 0; w = normal; h = cs; side = 'top' }
    else if (index === 21) { x = s - cs; y = 0; w = cs; h = cs; side = 'left'; isCorner = true }
    else if (index >= 22 && index <= 27) { const i = index - 22; x = s - cs; y = cs + normal * i; w = cs; h = normal; side = 'left' }

    return { x, y, w, h, side, isCorner }
  }

  // 将屏幕坐标转换为棋盘格子索引，未命中返回 -1
  hitTest(clientX: number, clientY: number): number {
    const rect = this.canvas.getBoundingClientRect()
    const dpr = this.dpr || Math.min(window.devicePixelRatio || 1, 2)
    const px = (clientX - rect.left) * dpr
    const py = (clientY - rect.top) * dpr

    for (let i = 0; i < BOARD_SIZE; i++) {
      const pos = this.getTilePosition(i)
      if (px >= pos.x && px <= pos.x + pos.w && py >= pos.y && py <= pos.y + pos.h) {
        return i
      }
    }
    return -1
  }

  // 获取指定格子在屏幕上的中心坐标（CSS像素）
  getTileScreenCenter(index: number): { x: number; y: number } | null {
    if (index < 0 || index >= BOARD_SIZE) return null
    const pos = this.getTilePosition(index)
    const dpr = this.dpr || Math.min(window.devicePixelRatio || 1, 2)
    const rect = this.canvas.getBoundingClientRect()
    return {
      x: rect.left + (pos.x + pos.w / 2) / dpr,
      y: rect.top + (pos.y + pos.h / 2) / dpr,
    }
  }

  // ===== 棋盘（深色高级格子） =====
  private drawBoard(highlightTile?: number, players?: Player[], effects?: TileEffects) {
    const { ctx } = this
    const pad = 2

    for (let i = 0; i < BOARD_SIZE; i++) {
      const tile = BOARD[i]
      const pos = this.getTilePosition(i)
      const owner = players?.find(p => p.properties.includes(tile.id))
      const cx = pos.x + pos.w / 2
      const cy = pos.y + pos.h / 2

      // 检查该格子是否有道具卡效果
      const hasRoadblock = effects?.roadblocks.some(r => r.tileId === tile.id)
      const hasPriceHike = effects?.priceHikes.some(h => h.tileId === tile.id)

      // --- 格子卡片背景 ---
      const bgColor = i === highlightTile ? 'rgba(139,92,246,0.3)'
        : hasRoadblock ? 'rgba(255,100,50,0.2)'
        : hasPriceHike ? 'rgba(255,200,50,0.2)'
        : owner ? 'rgba(255,255,255,0.12)'
        : 'rgba(255,255,255,0.06)'

      ctx.fillStyle = bgColor
      this.roundedRect(pos.x + pad, pos.y + pad, pos.w - pad * 2, pos.h - pad * 2, 6)
      ctx.fill()

      // --- 格子内容 ---
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'

      if (pos.isCorner) {
        ctx.font = this.font(30)
        ctx.fillText(tile.emoji, cx, cy - this.px(12))
        ctx.fillStyle = '#e8e8e8'
        ctx.font = this.font(17, '"Noto Sans SC", sans-serif', 'bold')
        ctx.fillText(tile.name, cx, cy + this.px(20))
      } else {
        ctx.font = this.font(22)
        ctx.fillText(tile.emoji, cx, cy - this.px(16))

        ctx.fillStyle = '#f0f0f0'
        ctx.font = this.font(16, '"Noto Sans SC", sans-serif', 'bold')
        ctx.fillText(tile.name, cx, cy + this.px(5))

        if (owner) {
          ctx.font = this.font(15)
          ctx.fillText(owner.avatar, cx, cy + this.px(23))
        } else if (tile.price > 0) {
          ctx.fillStyle = '#8899aa'
          ctx.font = this.font(13, '"Noto Sans SC", sans-serif')
          ctx.fillText(`¥${tile.price}`, cx, cy + this.px(23))
        }
      }

      // --- 道具卡效果角标 ---
      if (hasRoadblock) {
        const roadblock = useEffects?.roadblocks.find(r => r.tileId === tile.id)
        const badgeX = pos.x + pos.w - pad - 4
        const badgeY = pos.y + pad + 4
        ctx.font = this.font(14)
        ctx.textAlign = 'right'
        ctx.textBaseline = 'top'
        ctx.fillText('🚧', badgeX, badgeY)

        // 显示放置者头像（小尺寸，在路障左侧）
        if (roadblock && usePlayers) {
          const owner = usePlayers.find(p => p.id === roadblock.ownerPlayerId)
          if (owner) {
            ctx.font = this.font(10)
            ctx.fillText(owner.avatar, badgeX - this.px(14), badgeY)
          }
        }
      }
      if (hasPriceHike) {
        const badgeX = pos.x + pad + 4
        const badgeY = pos.y + pad + 4
        ctx.font = this.font(14)
        ctx.textAlign = 'left'
        ctx.textBaseline = 'top'
        ctx.fillText('📈', badgeX, badgeY)
      }
    }
  }

  // ===== 中心（标题+骰子） =====
  private drawCenter() {
    const { ctx, size } = this
    const cx = size / 2, cy = size / 2
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'

    ctx.fillStyle = 'rgba(139,92,246,0.15)'
    ctx.font = this.font(44, '"Noto Sans SC", sans-serif', 'bold')
    ctx.fillText('大富翁', cx + this.px(2), cy - this.px(38))
    ctx.fillStyle = '#8b5cf6'
    ctx.font = this.font(42, '"Noto Sans SC", sans-serif', 'bold')
    ctx.fillText('大富翁', cx, cy - this.px(40))
    ctx.fillStyle = '#6366f1'
    ctx.font = this.font(24, '"Noto Sans SC", sans-serif')
    ctx.fillText('中国行', cx, cy - this.px(5))

    if (this.diceAnim.active) {
      const p = this.diceAnim.progress
      // 动画分阶段：0-0.6 翻滚上升，0.6-0.85 悬停翻滚，0.85-1.0 下落落地

      let spread, flyUp, shake, scale, rot1, rot2

      if (p < 0.6) {
        // 阶段1：上升 + 分开
        const t = p / 0.6
        spread = 20 + t * 35
        flyUp = Math.sin(t * Math.PI * 0.5) * 50
        shake = Math.sin(t * 80) * 4
        scale = 0.8 + t * 0.4
        rot1 = t * Math.PI * 12
        rot2 = -t * Math.PI * 10
      } else if (p < 0.85) {
        // 阶段2：悬停 + 快速切换面值
        const t = (p - 0.6) / 0.25
        spread = 55 + Math.sin(t * Math.PI * 4) * 5
        flyUp = 50 - t * 10
        shake = Math.sin(t * 100) * 6 * (1 - t)
        scale = 1.2 - t * 0.1
        rot1 = Math.PI * 7.2 + t * Math.PI * 6
        rot2 = -Math.PI * 6 + t * Math.PI * 5
      } else {
        // 阶段3：下落 + 落地
        const t = (p - 0.85) / 0.15
        spread = 55 - t * 13
        flyUp = 40 * (1 - t * t) // 加速下落
        shake = (1 - t) * Math.sin(t * 30) * 3
        scale = 1.1 - t * 0.1
        rot1 = Math.PI * 13.2 * (1 - t * 0.3)
        rot2 = -Math.PI * 11 * (1 - t * 0.3)

        // 下落时拖尾粒子
        if (Math.random() < 0.3) {
          const diceX1 = cx - spread
          const diceX2 = cx + spread
          const diceY = cy + 55 - flyUp
          this.particles.push({ x: diceX1, y: diceY, vx: (Math.random() - 0.5) * 2, vy: Math.random() * 2, size: 2 + Math.random() * 2, alpha: 0.6, color: '#f59e0b', life: 0, maxLife: 15 })
          this.particles.push({ x: diceX2, y: diceY, vx: (Math.random() - 0.5) * 2, vy: Math.random() * 2, size: 2 + Math.random() * 2, alpha: 0.6, color: '#f59e0b', life: 0, maxLife: 15 })
        }
      }

      // 快速切换面值时加模糊效果（缩小点的大小）
      const blurFactor = (p > 0.6 && p < 0.85) ? 0.7 : 1

      this.drawDice(cx - spread + shake, cy + 55 - flyUp, this.diceAnim.shuffleValues[0], p, scale, rot1, blurFactor)
      this.drawDice(cx + spread - shake, cy + 55 - flyUp, this.diceAnim.shuffleValues[1], p, scale, rot2, blurFactor)
    } else if (this.diceVisible) {
      // 落地弹跳（多段弹跳）
      const bouncePhase = this.diceAnim.landBounce
      let bounceY = 0, bounceScale = 1

      if (bouncePhase > 0.5) {
        // 第一段弹跳：向上
        const t = (bouncePhase - 0.5) * 2
        bounceY = Math.sin(t * Math.PI) * 15
        bounceScale = 1 + Math.sin(t * Math.PI) * 0.15
      } else if (bouncePhase > 0.2) {
        // 第二段弹跳：压扁
        const t = (bouncePhase - 0.2) / 0.3
        bounceY = -Math.sin(t * Math.PI) * 5
        bounceScale = 1 - Math.sin(t * Math.PI) * 0.1
      } else if (bouncePhase > 0) {
        // 第三段：轻微抖动
        const t = bouncePhase / 0.2
        bounceY = Math.sin(t * Math.PI * 2) * 2
        bounceScale = 1 + Math.sin(t * Math.PI * 2) * 0.03
      }

      this.drawDice(cx - 42, cy + 55 - bounceY, this.lastDice[0], 1, bounceScale, 0, 1)
      this.drawDice(cx + 42, cy + 55 - bounceY, this.lastDice[1], 1, bounceScale, 0, 1)

      // 落地光环
      if (bouncePhase > 0.3) {
        ctx.save()
        ctx.globalAlpha = (bouncePhase - 0.3) * 0.4
        ctx.strokeStyle = '#f59e0b'
        ctx.lineWidth = 2
        const ringRadius = 55 + (1 - bouncePhase) * 20
        ctx.beginPath()
        ctx.ellipse(cx, cy + 58, ringRadius, ringRadius * 0.3, 0, 0, Math.PI * 2)
        ctx.stroke()
        ctx.restore()
      }

      // 结果数字（淡入+弹出+背景胶囊）
      const sr = this.diceAnim.showResult
      if (sr > 0) {
        const resultScale = sr < 0.5 ? 1 + (1 - sr * 2) * 0.5 : 1
        ctx.save()
        ctx.globalAlpha = Math.min(1, sr * 2)
        ctx.translate(cx, cy + 115)
        ctx.scale(resultScale, resultScale)

        // 背景胶囊
        const total = this.lastDice[0] + this.lastDice[1]
        const text = `${total}`
        ctx.font = this.font(28, '"Noto Sans SC", sans-serif', 'bold')
        const textW = ctx.measureText(text).width + this.px(30)
        ctx.fillStyle = 'rgba(245,158,11,0.15)'
        this.roundedRect(-textW / 2, -this.px(18), textW, this.px(36), this.px(18))
        ctx.fill()
        ctx.strokeStyle = 'rgba(245,158,11,0.4)'
        ctx.lineWidth = 1.5
        this.roundedRect(-textW / 2, -this.px(18), textW, this.px(36), this.px(18))
        ctx.stroke()

        // 数字
        ctx.shadowColor = '#f59e0b'
        ctx.shadowBlur = 12
        ctx.fillStyle = '#f59e0b'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(text, 0, 0)
        ctx.shadowBlur = 0
        ctx.restore()
      }
    }
  }

  private drawDice(x: number, y: number, value: number, progress: number, scale = 1, rotation = 0, blurFactor = 1) {
    const { ctx } = this
    const s = 52 * scale

    ctx.save()
    ctx.translate(x, y)
    ctx.rotate(rotation)

    // 3D 透视变形（根据旋转角模拟倾斜）
    const tilt = Math.sin(rotation) * 0.15
    ctx.transform(1, tilt, -tilt, 1, 0, 0)

    // 翻滚中的金色光晕
    if (blurFactor < 1) {
      ctx.shadowColor = 'rgba(245,158,11,0.4)'
      ctx.shadowBlur = 20 * (1 - blurFactor)
    }

    // 阴影（动态偏移，翻滚时更大）
    const shadowOff = 3 + Math.abs(Math.sin(rotation)) * 4 + (1 - blurFactor) * 5
    ctx.fillStyle = `rgba(0,0,0,${0.2 + (1 - blurFactor) * 0.1})`
    this.roundedRect(shadowOff, shadowOff, s, s, 10)
    ctx.fill()
    ctx.shadowBlur = 0

    // 骰子本体（渐变模拟光照）
    const lightAngle = rotation + Math.PI / 4
    const grad = ctx.createLinearGradient(
      Math.cos(lightAngle) * s / 2, Math.sin(lightAngle) * s / 2,
      -Math.cos(lightAngle) * s / 2, -Math.sin(lightAngle) * s / 2
    )
    grad.addColorStop(0, '#ffffff')
    grad.addColorStop(0.5, '#f8f8fc')
    grad.addColorStop(1, '#e0e0e8')
    ctx.fillStyle = grad
    this.roundedRect(-s / 2, -s / 2, s, s, 10)
    ctx.fill()

    // 边框
    ctx.strokeStyle = 'rgba(0,0,0,0.12)'
    ctx.lineWidth = 1.5
    this.roundedRect(-s / 2, -s / 2, s, s, 10)
    ctx.stroke()

    // 内阴影效果
    ctx.save()
    ctx.globalAlpha = 0.05
    ctx.fillStyle = '#000'
    this.roundedRect(-s / 2 + 3, -s / 2 + 3, s - 6, s - 6, 8)
    ctx.fill()
    ctx.restore()

    // 点数（带模糊效果：翻滚时点变小变淡，模拟运动模糊）
    ctx.fillStyle = value === 1 || value === 4 ? '#dc2626' : '#1a1a2e'
    const dotR = 5 * scale * blurFactor, offset = 13 * scale
    ctx.globalAlpha = 0.5 + blurFactor * 0.5
    const positions: Record<number, [number, number][]> = {
      1: [[0, 0]], 2: [[-offset, -offset], [offset, offset]],
      3: [[-offset, -offset], [0, 0], [offset, offset]],
      4: [[-offset, -offset], [offset, -offset], [-offset, offset], [offset, offset]],
      5: [[-offset, -offset], [offset, -offset], [0, 0], [-offset, offset], [offset, offset]],
      6: [[-offset, -offset], [offset, -offset], [-offset, 0], [offset, 0], [-offset, offset], [offset, offset]],
    }
    for (const [dx, dy] of (positions[value] || positions[1])) {
      // 点数带微妙凹陷效果
      ctx.beginPath(); ctx.arc(dx, dy, dotR, 0, Math.PI * 2); ctx.fill()
      if (blurFactor > 0.8) {
        ctx.save()
        ctx.globalAlpha = 0.3
        ctx.fillStyle = '#000'
        ctx.beginPath(); ctx.arc(dx + 0.5, dy + 0.5, dotR * 0.6, 0, Math.PI * 2); ctx.fill()
        ctx.restore()
      }
    }
    ctx.globalAlpha = 1

    ctx.restore()
  }

  private roundedRect(x: number, y: number, w: number, h: number, r: number) {
    const { ctx } = this
    ctx.beginPath()
    ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r)
    ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h)
    ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r)
    ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y); ctx.closePath()
  }

  // ===== 玩家棋子（含移动动画覆盖） =====
  private drawPlayers(players: Player[]) {
    const { ctx } = this
    const animPos = this.getMoveAnimPosition()

    // 移动过程中：在已经过的格子上绘制 ♟️ 路径标记
    if (this.moveAnim.active) {
      this.drawMovePath()
    }

    const posMap = new Map<number, Player[]>()
    for (const p of players) {
      if (p.bankrupt) continue
      if (this.moveAnim.active && p.id === this.moveAnim.playerId) continue
      const arr = posMap.get(p.position) || []
      arr.push(p)
      posMap.set(p.position, arr)
    }

    posMap.forEach((playersAtPos, tileIdx) => {
      const pos = this.getTilePosition(tileIdx)
      const cx = pos.x + pos.w / 2, cy = pos.y + pos.h / 2

      playersAtPos.forEach((p, i) => {
        const offsetX = (i - (playersAtPos.length - 1) / 2) * 26
        const bobble = Math.sin(this.time * 3 + p.id * 1.5) * 3
        this.drawToken(cx + offsetX, cy + 24 + bobble, p, p.id === this.currentHighlight)
      })
    })

    // 画移动动画中的棋子（带旋转+缩放）
    if (this.moveAnim.active && animPos) {
      const movingPlayer = players.find(p => p.id === this.moveAnim.playerId)
      if (movingPlayer) {
        this.drawTokenAnimated(animPos.x, animPos.y, movingPlayer, animPos.rotation, animPos.scaleX, animPos.scaleY)
      }
    }
  }

  // ===== 移动路径标记 ♟️ =====
  private drawMovePath() {
    const { ctx } = this
    const m = this.moveAnim
    const totalSteps = ((m.targetTile - m.fromTile + BOARD_SIZE) % BOARD_SIZE)
    const steppedCount = totalSteps - m.stepsLeft

    for (let i = 0; i <= steppedCount; i++) {
      const tileIdx = (m.fromTile + i) % BOARD_SIZE
      if (tileIdx === m.currentTile && i === steppedCount) continue
      const pos = this.getTilePosition(tileIdx)
      const cx = pos.x + pos.w / 2
      const cy = pos.y + pos.h / 2

      const fadeProgress = i / Math.max(steppedCount, 1)
      const alpha = 0.3 + fadeProgress * 0.5

      ctx.save()
      ctx.globalAlpha = alpha
      ctx.font = this.font(18)
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText('♟️', cx, cy + 24)
      ctx.restore()
    }
  }

  // 绘制移动中的棋子（♟️标记 + 旋转和形变）
  private drawTokenAnimated(x: number, y: number, p: Player, rotation: number, scaleX: number, scaleY: number) {
    const { ctx } = this
    const r = this.px(18)

    ctx.save()
    ctx.translate(x, y)

    // 阴影（根据高度变化大小）
    const shadowScale = Math.max(0.1, 1 - (25 - Math.abs(y - (this.getTilePosition(this.moveAnim.currentTile).y + this.getTilePosition(this.moveAnim.currentTile).h / 2 + 24))) / 50)
    ctx.beginPath()
    ctx.ellipse(2, 20, r * shadowScale * 0.8, r * shadowScale * 0.3, 0, 0, Math.PI * 2)
    ctx.fillStyle = 'rgba(0,0,0,0.3)'
    ctx.fill()

    // 应用旋转和缩放
    ctx.rotate(rotation)
    ctx.scale(scaleX, scaleY)

    // 棋子本体
    const grad = ctx.createRadialGradient(-r * 0.3, -r * 0.3, 0, 0, 0, r)
    grad.addColorStop(0, '#ffffff')
    grad.addColorStop(0.25, p.color)
    grad.addColorStop(1, this.darkenColor(p.color, 0.5))
    ctx.beginPath()
    ctx.arc(0, 0, r, 0, Math.PI * 2)
    ctx.fillStyle = grad
    ctx.fill()
    ctx.strokeStyle = '#ffffff'
    ctx.lineWidth = 3
    ctx.stroke()

    // ♟️ 标记（反向旋转保持正立）
    ctx.rotate(-rotation)
    ctx.font = this.font(24)
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText('♟️', 0, 1)

    ctx.restore()
  }

  private drawToken(tokenX: number, tokenY: number, p: Player, isCurrent: boolean) {
    const { ctx } = this
    const r = isCurrent ? this.px(18) : this.px(12)

    // ===== 当前玩家：高亮光标 =====
    if (isCurrent) {
      // 底部发光光圈
      const glowR = r + this.px(10)
      const glowGrad = ctx.createRadialGradient(tokenX, tokenY, r * 0.8, tokenX, tokenY, glowR)
      glowGrad.addColorStop(0, p.color + '55')
      glowGrad.addColorStop(1, p.color + '00')
      ctx.beginPath(); ctx.arc(tokenX, tokenY, glowR, 0, Math.PI * 2)
      ctx.fillStyle = glowGrad; ctx.fill()

      // 脉冲外圈
      const pulseR = r + this.px(4) + Math.sin(this.time * 5) * this.px(2)
      ctx.beginPath(); ctx.arc(tokenX, tokenY, pulseR, 0, Math.PI * 2)
      ctx.strokeStyle = p.color
      ctx.lineWidth = 2.5
      ctx.stroke()

      // 顶部指示箭头（向下指）
      const arrowY = tokenY - r - this.px(6)
      ctx.beginPath()
      ctx.moveTo(tokenX - this.px(7), arrowY - this.px(12))
      ctx.lineTo(tokenX + this.px(7), arrowY - this.px(12))
      ctx.lineTo(tokenX, arrowY)
      ctx.closePath()
      ctx.fillStyle = p.color
      ctx.fill()
      ctx.strokeStyle = '#ffffff'
      ctx.lineWidth = 1.5
      ctx.stroke()
    }

    // 棋子阴影
    ctx.beginPath(); ctx.arc(tokenX + 2, tokenY + 2, r, 0, Math.PI * 2)
    ctx.fillStyle = 'rgba(0,0,0,0.4)'; ctx.fill()

    // 棋子本体（3D渐变：高光+主色+暗部）
    const grad = ctx.createRadialGradient(tokenX - r * 0.3, tokenY - r * 0.3, 0, tokenX, tokenY, r)
    grad.addColorStop(0, '#ffffff')
    grad.addColorStop(0.25, p.color)
    grad.addColorStop(1, this.darkenColor(p.color, 0.5))
    ctx.beginPath(); ctx.arc(tokenX, tokenY, r, 0, Math.PI * 2)
    ctx.fillStyle = grad; ctx.fill()
    ctx.strokeStyle = '#ffffff'
    ctx.lineWidth = isCurrent ? 3 : 2
    ctx.stroke()

    // 头像
    ctx.font = this.font(isCurrent ? 22 : 14)
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.fillText(p.avatar, tokenX, tokenY + 1)

    // ===== 标签 =====
    const labelStartY = tokenY + r + (isCurrent ? this.px(14) : this.px(10))

    // 玩家名（当前玩家显示）
    if (isCurrent) {
      ctx.font = this.font(11, '"Noto Sans SC", sans-serif', 'bold')
      const nameW = ctx.measureText(p.name).width + this.px(12)
      ctx.fillStyle = p.color
      this.roundedRect(tokenX - nameW / 2, labelStartY - this.px(7), nameW, this.px(14), this.px(7))
      ctx.fill()
      ctx.fillStyle = '#ffffff'
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
      ctx.fillText(p.name, tokenX, labelStartY)
    }

    // 现金（紧凑显示）
    const cashY = labelStartY + (isCurrent ? this.px(15) : 0)
    const cashText = `¥${p.money}`
    ctx.font = this.font(isCurrent ? 11 : 10, '"Noto Sans SC", sans-serif', 'bold')
    const cashW = ctx.measureText(cashText).width + this.px(8)
    ctx.fillStyle = 'rgba(0,0,0,0.7)'
    this.roundedRect(tokenX - cashW / 2, cashY - this.px(6), cashW, this.px(12), this.px(6))
    ctx.fill()
    ctx.fillStyle = p.money > 500 ? '#4ade80' : p.money > 200 ? '#fbbf24' : '#ef4444'
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.fillText(cashText, tokenX, cashY)
  }

  // ===== 浮动文字 =====
  private drawFloatingTexts() {
    const { ctx } = this
    this.floatingTexts = this.floatingTexts.filter(ft => {
      ft.life += this.dt
      const progress = ft.life / ft.maxLife
      const alpha = progress < 0.2 ? progress / 0.2 : progress > 0.7 ? (1 - progress) / 0.3 : 1
      const floatY = ft.y - progress * 40

      ctx.save(); ctx.globalAlpha = alpha
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
      ctx.font = this.font(ft.fontSize, '"Noto Sans SC", sans-serif', 'bold')
      const textW = ctx.measureText(ft.text).width
      const pillW = textW + this.px(20), pillH = ft.fontSize * this.dpr + this.px(10)
      ctx.fillStyle = 'rgba(0,0,0,0.7)'
      this.roundedRect(ft.x - pillW / 2, floatY - pillH / 2, pillW, pillH, pillH / 2); ctx.fill()
      ctx.fillStyle = ft.color
      ctx.fillText(ft.text, ft.x, floatY)
      ctx.restore()
      return ft.life < ft.maxLife
    })
  }

  private drawParticles() {
    const { ctx } = this
    for (const p of this.particles) {
      ctx.beginPath(); ctx.arc(p.x, p.y, p.size * p.alpha, 0, Math.PI * 2)
      ctx.fillStyle = p.color + Math.round(p.alpha * 255).toString(16).padStart(2, '0')
      ctx.fill()
    }
  }

  // ===== 收租金币飞行动画 =====
  playRentAnimation(fromTile: number, toTile: number, amount: number) {
    const from = this.getTilePosition(fromTile)
    const to = this.getTilePosition(toTile)
    const sx = from.x + from.w / 2, sy = from.y + from.h / 2
    const ex = to.x + to.w / 2, ey = to.y + to.h / 2
    const count = Math.min(12, Math.max(6, Math.floor(amount / 100)))
    for (let i = 0; i < count; i++) {
      const offset = 80 + Math.random() * 60
      this.coinAnims.push({
        sx, sy, ex, ey,
        cx1: sx + (Math.random() - 0.5) * offset * 2,
        cy1: sy - offset - Math.random() * 40,
        cx2: ex + (Math.random() - 0.5) * offset * 2,
        cy2: ey - offset - Math.random() * 40,
        progress: 0, speed: 0.018 + Math.random() * 0.008,
        delay: i * 3 + Math.random() * 2,
        arrived: false,
      })
    }
    // 到达后显示 +¥xxx
    this.showFloatingText(toTile, `+¥${amount}`, '#4ade80')
  }

  private updateCoinAnims(dt: number = 1) {
    this.coinAnims = this.coinAnims.filter(c => {
      if (c.delay > 0) { c.delay -= dt; return true }
      c.progress += c.speed * dt
      if (c.progress >= 1 && !c.arrived) {
        c.arrived = true
        // 到达时爆发小粒子
        for (let i = 0; i < 4; i++) {
          const angle = Math.random() * Math.PI * 2
          this.particles.push({
            x: c.ex, y: c.ey, vx: Math.cos(angle) * 2, vy: Math.sin(angle) * 2,
            size: 2 + Math.random() * 2, alpha: 1, color: '#fbbf24', life: 0, maxLife: 20,
          })
        }
        return false
      }
      return c.progress < 1.2
    })
  }

  private drawCoinAnims() {
    const { ctx } = this
    for (const c of this.coinAnims) {
      if (c.delay > 0 || c.progress <= 0) continue
      const t = Math.min(c.progress, 1)
      // 三次贝塞尔曲线
      const mt = 1 - t
      const x = mt*mt*mt*c.sx + 3*mt*mt*t*c.cx1 + 3*mt*t*t*c.cx2 + t*t*t*c.ex
      const y = mt*mt*mt*c.sy + 3*mt*mt*t*c.cy1 + 3*mt*t*t*c.cy2 + t*t*t*c.ey
      // 金币圆形 + 光泽
      const r = this.px(5)
      ctx.save()
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2)
      const coinGrad = ctx.createRadialGradient(x - r * 0.3, y - r * 0.3, 0, x, y, r)
      coinGrad.addColorStop(0, '#ffe066')
      coinGrad.addColorStop(0.7, '#f59e0b')
      coinGrad.addColorStop(1, '#b45309')
      ctx.fillStyle = coinGrad
      ctx.fill()
      // 拖尾
      ctx.globalAlpha = 0.3
      ctx.beginPath(); ctx.arc(x - (x - c.sx) * 0.05, y - (y - c.sy) * 0.05, r * 0.6, 0, Math.PI * 2)
      ctx.fillStyle = '#fbbf24'
      ctx.fill()
      ctx.restore()
    }
  }

  // ===== 买地建筑升起动画 =====
  playBuildAnimation(tileIndex: number, ownerColor: string) {
    const emojis = ['🏠', '🏢', '🏬']
    this.buildAnims.push({
      tileIndex, color: ownerColor,
      emoji: emojis[Math.floor(Math.random() * emojis.length)],
      progress: 0, speed: 0.025, settled: false, settleTimer: 0,
    })
  }

  private updateBuildAnims(dt: number = 1) {
    this.buildAnims = this.buildAnims.filter(b => {
      if (b.settled) {
        b.settleTimer -= dt
        return b.settleTimer > 0
      }
      b.progress += b.speed * dt
      if (b.progress >= 1) {
        b.progress = 1
        b.settled = true
        b.settleTimer = 60  // 保持约1秒
        // 落地尘土
        const pos = this.getTilePosition(b.tileIndex)
        const cx = pos.x + pos.w / 2, cy = pos.y + pos.h
        for (let i = 0; i < 6; i++) {
          const angle = -Math.PI * 0.2 - Math.random() * Math.PI * 0.6
          this.particles.push({
            x: cx + (Math.random() - 0.5) * pos.w * 0.6, y: cy,
            vx: Math.cos(angle) * (1 + Math.random()), vy: Math.sin(angle) * (1 + Math.random()),
            size: 2 + Math.random() * 2, alpha: 0.8, color: '#a8a29e', life: 0, maxLife: 25,
          })
        }
      }
      return true
    })
  }

  private drawBuildAnims() {
    const { ctx } = this
    for (const b of this.buildAnims) {
      const pos = this.getTilePosition(b.tileIndex)
      const cx = pos.x + pos.w / 2, baseY = pos.y + pos.h * 0.7
      // easeOutBack 弹跳升起
      const t = b.progress
      const c1 = 1.70158, c3 = c1 + 1
      const eased = t < 1 ? 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2) : 1
      const riseH = pos.h * 0.5
      const y = baseY - eased * riseH
      const scale = b.settled ? 1 : 0.8 + eased * 0.2

      ctx.save()
      ctx.globalAlpha = b.settled ? Math.min(b.settleTimer / 20, 1) : 1
      ctx.font = this.font(Math.round(18 * scale))
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
      ctx.fillText(b.emoji, cx, y)
      ctx.restore()
    }
  }

  // ===== 破产爆炸动画 =====
  playBankruptAnimation(tileIndex: number, _color: string) {
    const pos = this.getTilePosition(tileIndex)
    const cx = pos.x + pos.w / 2, cy = pos.y + pos.h / 2
    // 大量红/橙粒子爆发
    for (let i = 0; i < 30; i++) {
      const angle = Math.random() * Math.PI * 2
      const speed = 2 + Math.random() * 4
      this.particles.push({
        x: cx, y: cy, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
        size: 3 + Math.random() * 4, alpha: 1,
        color: Math.random() > 0.5 ? '#ef4444' : '#f97316',
        life: 0, maxLife: 40 + Math.random() * 20,
      })
    }
    // 屏幕震动
    this.shakeTimer = 12
    // 浮动文字
    this.showFloatingText(tileIndex, '破产！', '#ef4444')
  }

  // ===== 卡片全屏特效 =====
  playCardEffect(type: string, tileIndex?: number, tileIndex2?: number) {
    this.cardEffects.push({
      type, tileIndex, tileIndex2,
      progress: 0, speed: 0.02, active: true,
    })
  }

  private updateCardEffects(dt: number = 1) {
    this.cardEffects = this.cardEffects.filter(e => {
      e.progress += e.speed * dt
      if (e.progress >= 1) { e.active = false; return false }
      return true
    })
  }

  private drawCardEffects() {
    const { ctx, size } = this
    for (const e of this.cardEffects) {
      const t = e.progress
      const cx = size / 2, cy = size / 2

      ctx.save()

      switch (e.type) {
        case 'remote_dice': {
          // 瞄准镜动画：中心十字准星 + 脉冲环
          const alpha = t < 0.3 ? t / 0.3 : t > 0.7 ? (1 - t) / 0.3 : 1
          ctx.globalAlpha = alpha * 0.7
          ctx.strokeStyle = '#f97316'
          ctx.lineWidth = this.px(2)
          // 十字线
          const len = 40 + t * 20
          ctx.beginPath()
          ctx.moveTo(cx - len, cy + 55); ctx.lineTo(cx + len, cy + 55)
          ctx.moveTo(cx, cy + 55 - len); ctx.lineTo(cx, cy + 55 + len)
          ctx.stroke()
          // 脉冲环
          const ringR = 30 + t * 30
          ctx.beginPath(); ctx.arc(cx, cy + 55, ringR, 0, Math.PI * 2)
          ctx.stroke()
          // 中心点
          ctx.fillStyle = '#f97316'
          ctx.beginPath(); ctx.arc(cx, cy + 55, 4, 0, Math.PI * 2)
          ctx.fill()
          break
        }
        case 'roadblock': {
          if (e.tileIndex === undefined) break
          const pos = this.getTilePosition(e.tileIndex)
          const tx = pos.x + pos.w / 2, baseY = pos.y + pos.h * 0.7
          // 路障从上方落下
          const fallT = Math.min(t * 2, 1)
          const bounce = fallT >= 1 ? Math.sin((t - 0.5) * 8) * (1 - t) * 8 : 0
          const dropY = -50
          const y = dropY + (baseY - dropY) * this.easeOutBounce(fallT) + bounce
          ctx.font = this.font(22)
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
          ctx.globalAlpha = t < 0.8 ? 1 : (1 - t) / 0.2
          ctx.fillText('🚧', tx, y)
          // 落地冲击波环
          if (fallT >= 1) {
            const ringProgress = (t - 0.5) * 2
            ctx.globalAlpha = Math.max(0, 1 - ringProgress) * 0.5
            ctx.strokeStyle = '#f97316'
            ctx.lineWidth = this.px(2)
            ctx.beginPath()
            ctx.arc(tx, baseY, ringProgress * 30, 0, Math.PI * 2)
            ctx.stroke()
          }
          break
        }
        case 'swap': {
          if (e.tileIndex === undefined || e.tileIndex2 === undefined) break
          const pos1 = this.getTilePosition(e.tileIndex)
          const pos2 = this.getTilePosition(e.tileIndex2)
          const x1 = pos1.x + pos1.w / 2, y1 = pos1.y + pos1.h / 2
          const x2 = pos2.x + pos2.w / 2, y2 = pos2.y + pos2.h / 2
          // 闪烁虚线连接两点
          ctx.globalAlpha = 0.6 * (t < 0.7 ? 1 : (1 - t) / 0.3)
          ctx.strokeStyle = '#a78bfa'
          ctx.lineWidth = this.px(2)
          ctx.setLineDash([this.px(6), this.px(4)])
          ctx.lineDashOffset = -this.time * 80
          ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2)
          ctx.stroke()
          ctx.setLineDash([])
          // 两端光圈
          const pulseR = 15 + Math.sin(this.time * 8) * 5
          ctx.strokeStyle = '#a78bfa'
          ctx.beginPath(); ctx.arc(x1, y1, pulseR, 0, Math.PI * 2); ctx.stroke()
          ctx.beginPath(); ctx.arc(x2, y2, pulseR, 0, Math.PI * 2); ctx.stroke()
          break
        }
        case 'free_pass': {
          if (e.tileIndex === undefined) break
          const pos = this.getTilePosition(e.tileIndex)
          const tx = pos.x + pos.w / 2, ty = pos.y + pos.h / 2
          // 护盾光环
          ctx.globalAlpha = 0.5 * (t < 0.6 ? 1 : (1 - t) / 0.4)
          const shieldR = 20 + t * 10
          const shieldGrad = ctx.createRadialGradient(tx, ty, shieldR * 0.3, tx, ty, shieldR)
          shieldGrad.addColorStop(0, 'rgba(59,130,246,0.4)')
          shieldGrad.addColorStop(0.7, 'rgba(59,130,246,0.15)')
          shieldGrad.addColorStop(1, 'rgba(59,130,246,0)')
          ctx.fillStyle = shieldGrad
          ctx.beginPath(); ctx.arc(tx, ty, shieldR, 0, Math.PI * 2)
          ctx.fill()
          // 盾牌边框
          ctx.strokeStyle = '#3b82f6'
          ctx.lineWidth = this.px(2)
          ctx.beginPath(); ctx.arc(tx, ty, shieldR, 0, Math.PI * 2)
          ctx.stroke()
          break
        }
        case 'price_hike': {
          if (e.tileIndex === undefined) break
          const pos = this.getTilePosition(e.tileIndex)
          const tx = pos.x + pos.w / 2, ty = pos.y + pos.h / 2
          // 金色脉冲光晕
          const pulseAlpha = Math.sin(t * Math.PI * 3) * 0.5
          ctx.globalAlpha = Math.abs(pulseAlpha) * (t < 0.8 ? 1 : (1 - t) / 0.2)
          const glowR = pos.w * 0.6 + t * 10
          const glowGrad = ctx.createRadialGradient(tx, ty, 0, tx, ty, glowR)
          glowGrad.addColorStop(0, 'rgba(251,191,36,0.5)')
          glowGrad.addColorStop(1, 'rgba(251,191,36,0)')
          ctx.fillStyle = glowGrad
          ctx.beginPath(); ctx.arc(tx, ty, glowR, 0, Math.PI * 2)
          ctx.fill()
          // 上升箭头
          ctx.globalAlpha = t < 0.7 ? 1 : (1 - t) / 0.3
          ctx.font = this.font(16)
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
          ctx.fillStyle = '#fbbf24'
          ctx.fillText('📈', tx, ty - 15 - t * 20)
          break
        }
      }
      ctx.restore()
    }
  }

  // 弹跳缓动函数
  private easeOutBounce(x: number): number {
    const n1 = 7.5625, d1 = 2.75
    if (x < 1 / d1) return n1 * x * x
    if (x < 2 / d1) return n1 * (x -= 1.5 / d1) * x + 0.75
    if (x < 2.5 / d1) return n1 * (x -= 2.25 / d1) * x + 0.9375
    return n1 * (x -= 2.625 / d1) * x + 0.984375
  }

  // ===== NPC 入场动画 =====
  private static readonly NPC_MAP: Record<string, string> = {
    god_wealth: '🤑', god_poverty: '👻', police: '👮', dog: '🐕',
  }

  spawnNPC(type: string, tileIndex: number) {
    const emoji = BoardRenderer.NPC_MAP[type] || '❓'
    this.npcAnims.push({
      type: type as NPCAnim['type'],
      tileIndex, progress: 0, speed: 0.018, emoji,
    })
  }

  private updateNPCAnims(dt: number = 1) {
    this.npcAnims = this.npcAnims.filter(n => {
      n.progress += n.speed * dt
      // 表演阶段产生持续粒子
      if (n.progress >= 1 && n.progress < 2) {
        const pos = this.getTilePosition(n.tileIndex)
        const cx = pos.x + pos.w / 2, cy = pos.y + pos.h / 2
        this.spawnNPCParticles(n.type, cx, cy, dt)
      }
      return n.progress < 3
    })
  }

  private spawnNPCParticles(type: string, cx: number, cy: number, dt: number) {
    if (Math.random() > 0.3 * dt) return
    switch (type) {
      case 'god_wealth':
        this.particles.push({
          x: cx + (Math.random() - 0.5) * 30, y: cy,
          vx: (Math.random() - 0.5) * 1.5, vy: -1 - Math.random() * 2,
          size: 2 + Math.random() * 3, alpha: 1, color: '#fbbf24', life: 0, maxLife: 30,
        })
        break
      case 'god_poverty':
        this.particles.push({
          x: cx + (Math.random() - 0.5) * 25, y: cy + 10,
          vx: (Math.random() - 0.5) * 0.5, vy: 0.5 + Math.random(),
          size: 2 + Math.random() * 2, alpha: 0.7, color: '#78716c', life: 0, maxLife: 25,
        })
        break
      case 'police':
        this.particles.push({
          x: cx + (Math.random() - 0.5) * 20, y: cy + (Math.random() - 0.5) * 20,
          vx: (Math.random() - 0.5) * 2, vy: (Math.random() - 0.5) * 2,
          size: 1.5 + Math.random() * 2, alpha: 1,
          color: Math.random() > 0.5 ? '#3b82f6' : '#ef4444', life: 0, maxLife: 15,
        })
        break
      case 'dog':
        this.particles.push({
          x: cx + (Math.random() - 0.5) * 15, y: cy,
          vx: (Math.random() - 0.5) * 3, vy: -Math.random() * 1.5,
          size: 2 + Math.random() * 2, alpha: 1, color: '#ef4444', life: 0, maxLife: 18,
        })
        break
    }
  }

  private drawNPCAnims() {
    const { ctx, size } = this
    const centerX = size / 2, centerY = size / 2

    for (const n of this.npcAnims) {
      const pos = this.getTilePosition(n.tileIndex)
      const tx = pos.x + pos.w / 2, ty = pos.y + pos.h / 2
      const p = n.progress

      ctx.save()

      if (p < 1) {
        // === 入场阶段：从棋盘中心沿弧线飘入目标格子 ===
        const t = p
        const eased = this.easeOutBack(t)
        // 起始点：棋盘中心偏上方
        const sx = centerX + (Math.random() * 0.01 - 0.005)  // 微抖动
        const sy = centerY - 20
        const x = sx + (tx - sx) * eased
        const y = sy + (ty - sy) * eased - Math.sin(t * Math.PI) * 40  // 弧线
        const scale = 0.3 + eased * 0.9
        const alpha = Math.min(t * 2, 1)

        ctx.globalAlpha = alpha
        ctx.font = this.font(Math.round(28 * scale))
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
        ctx.fillText(n.emoji, x, y)

        // 入场拖尾
        ctx.globalAlpha = alpha * 0.2
        ctx.font = this.font(Math.round(20 * scale))
        ctx.fillText(n.emoji, x - (x - sx) * 0.08, y - (y - sy) * 0.08)
      } else if (p < 2) {
        // === 表演阶段：停在格子中心 + 类型特有特效 ===
        const t = p - 1
        const bob = Math.sin(t * Math.PI * 4) * 3  // 上下浮动

        ctx.font = this.font(30)
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
        ctx.fillText(n.emoji, tx, ty + bob)

        // 类型特效
        switch (n.type) {
          case 'god_wealth': {
            // 金色光环脉冲
            const glowR = 25 + Math.sin(t * Math.PI * 3) * 8
            ctx.globalAlpha = 0.25 + Math.sin(t * Math.PI * 3) * 0.15
            const grad = ctx.createRadialGradient(tx, ty, 0, tx, ty, glowR)
            grad.addColorStop(0, 'rgba(251,191,36,0.5)')
            grad.addColorStop(1, 'rgba(251,191,36,0)')
            ctx.fillStyle = grad
            ctx.beginPath(); ctx.arc(tx, ty, glowR, 0, Math.PI * 2); ctx.fill()
            break
          }
          case 'god_poverty': {
            // 灰色烟雾扩散
            const smokeR = 20 + t * 25
            ctx.globalAlpha = Math.max(0, 0.3 - t * 0.15)
            const grad = ctx.createRadialGradient(tx, ty, 0, tx, ty, smokeR)
            grad.addColorStop(0, 'rgba(120,113,108,0.4)')
            grad.addColorStop(1, 'rgba(120,113,108,0)')
            ctx.fillStyle = grad
            ctx.beginPath(); ctx.arc(tx, ty, smokeR, 0, Math.PI * 2); ctx.fill()
            break
          }
          case 'police': {
            // 红蓝交替警灯环
            const isBlue = Math.sin(t * Math.PI * 8) > 0
            const ringR = 22 + Math.sin(t * Math.PI * 6) * 5
            ctx.globalAlpha = 0.5
            ctx.strokeStyle = isBlue ? '#3b82f6' : '#ef4444'
            ctx.lineWidth = this.px(3)
            ctx.beginPath(); ctx.arc(tx, ty, ringR, 0, Math.PI * 2); ctx.stroke()
            // 第二环反色
            ctx.strokeStyle = isBlue ? '#ef4444' : '#3b82f6'
            ctx.globalAlpha = 0.3
            ctx.beginPath(); ctx.arc(tx, ty, ringR * 0.6, 0, Math.PI * 2); ctx.stroke()
            break
          }
          case 'dog': {
            // 左右摇晃 + 锯齿撕咬线
            const shakeX = Math.sin(t * Math.PI * 12) * 6
            ctx.font = this.font(30)
            ctx.clearRect(tx - 20, ty - 20, 40, 40)
            ctx.fillText(n.emoji, tx + shakeX, ty)
            // 锯齿线
            ctx.globalAlpha = 0.6 * (1 - t)
            ctx.strokeStyle = '#ef4444'
            ctx.lineWidth = this.px(2)
            ctx.beginPath()
            for (let i = 0; i < 5; i++) {
              const sx = tx - 15 + i * 7.5
              const sy = ty + 15 + (i % 2 === 0 ? -5 : 5)
              if (i === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy)
            }
            ctx.stroke()
            break
          }
        }

        // 浮动文字标签（表演阶段前半段显示）
        if (t < 0.5) {
          const labelAlpha = t < 0.15 ? t / 0.15 : t > 0.35 ? (0.5 - t) / 0.15 : 1
          ctx.globalAlpha = labelAlpha
          const labels: Record<string, { text: string; color: string }> = {
            god_wealth: { text: '财神赐福', color: '#fbbf24' },
            god_poverty: { text: '破财消灾', color: '#78716c' },
            police: { text: '逮捕！', color: '#3b82f6' },
            dog: { text: '汪！咬你！', color: '#ef4444' },
          }
          const label = labels[n.type]
          if (label) {
            ctx.font = this.font(14, '"Noto Sans SC", sans-serif', 'bold')
            ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
            ctx.fillStyle = 'rgba(0,0,0,0.7)'
            const tw = ctx.measureText(label.text).width
            this.roundedRect(tx - tw / 2 - 8, ty - 35, tw + 16, 20, 10)
            ctx.fill()
            ctx.fillStyle = label.color
            ctx.fillText(label.text, tx, ty - 25)
          }
        }
      } else {
        // === 离场阶段：缩小淡出 + 向棋盘中心飘走 ===
        const t = p - 2
        const scale = 1 - t * 0.7
        const alpha = 1 - t
        const ex = tx + (centerX - tx) * t * 0.3
        const ey = ty + (centerY - ty) * t * 0.3 - t * 15

        ctx.globalAlpha = Math.max(0, alpha)
        ctx.font = this.font(Math.round(28 * Math.max(0.3, scale)))
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
        ctx.fillText(n.emoji, ex, ey)
      }

      ctx.restore()
    }
  }

  // easeOutBack 缓动
  private easeOutBack(x: number): number {
    const c1 = 1.70158, c3 = c1 + 1
    return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2)
  }

  private darkenColor(hex: string, factor: number) {
    let h = hex
    if (h.length === 4) h = '#' + h[1] + h[1] + h[2] + h[2] + h[3] + h[3]
    const r = parseInt(h.slice(1, 3), 16) || 0, g = parseInt(h.slice(3, 5), 16) || 0, b = parseInt(h.slice(5, 7), 16) || 0
    return `rgb(${Math.round(r * factor)},${Math.round(g * factor)},${Math.round(b * factor)})`
  }
}
