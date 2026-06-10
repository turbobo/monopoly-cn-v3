// 大富翁中国行 - Canvas棋盘渲染 (v4: 占领强化+逐格移动动画)
import { BOARD, BOARD_SIZE, Player } from './game-engine'

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

export class BoardRenderer {
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private size: number = 0
  private tileSize: number = 0
  private cornerSize: number = 0
  private animId: number = 0
  private time: number = 0
  private particles: Particle[] = []
  private floatingTexts: FloatingText[] = []

  private diceAnim = {
    active: false, values: [1, 1] as [number, number], progress: 0,
    shuffleValues: [1, 1] as [number, number], landed: false,
    onLand: null as (() => void) | null,
    landBounce: 0, showResult: 0,
  }
  private lastDice: [number, number] = [1, 1]
  private diceVisible = false
  private currentHighlight = -1
  private lastPlayers: Player[] | undefined
  private lastHighlightTile: number | undefined

  // 逐格移动动画
  private moveAnim: MoveAnim = {
    active: false, playerId: -1, fromTile: 0, currentTile: 0, targetTile: 0,
    stepsLeft: 0, progress: 0, speed: 0.039, color: '', avatar: '', onComplete: null, onStep: null,
  }

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    this.ctx = canvas.getContext('2d')!
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
    this.canvas.width = w * dpr
    this.canvas.height = w * dpr
    this.canvas.style.width = w + 'px'
    this.canvas.style.height = w + 'px'
    this.size = w * dpr
    this.tileSize = this.size / 8.5
    this.cornerSize = this.tileSize * 1.3
  }

  start() {
    const loop = () => {
      this.time += 0.016
      this.updateParticles()
      this.updateMoveAnim()
      this.draw()
      this.animId = requestAnimationFrame(loop)
    }
    this.animId = requestAnimationFrame(loop)
  }

  stop() { cancelAnimationFrame(this.animId) }

  setCurrentPlayer(index: number) { this.currentHighlight = index }
  isMoving(): boolean { return this.moveAnim.active }

  // ===== 逐格移动动画 =====
  playMoveAnimation(playerId: number, fromTile: number, steps: number, color: string, avatar: string, onComplete: () => void, onStep?: () => void) {
    this.moveAnim = {
      active: true, playerId, fromTile, currentTile: fromTile,
      targetTile: (fromTile + steps) % BOARD_SIZE, stepsLeft: steps,
      progress: 0, speed: 0.039, color, avatar,
      onComplete, onStep: onStep || null,
    }
  }

  private updateMoveAnim() {
    if (!this.moveAnim.active) return
    const m = this.moveAnim
    m.progress += m.speed

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
  playDiceAnimation(values: [number, number], onLand?: () => void) {
    this.diceAnim = {
      active: true, values, progress: 0,
      shuffleValues: [Math.ceil(Math.random() * 6), Math.ceil(Math.random() * 6)],
      landed: false, onLand: onLand || null,
      landBounce: 0, showResult: 0,
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
    d.progress += 0.022

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

  private updateParticles() {
    this.particles = this.particles.filter(p => {
      p.x += p.vx; p.y += p.vy; p.vy += 0.05; p.life++
      p.alpha = Math.max(0, 1 - p.life / p.maxLife)
      return p.life < p.maxLife
    })
  }

  // ===== 主绘制 =====
  draw(players?: Player[], highlightTile?: number) {
    if (players) this.lastPlayers = players
    if (highlightTile !== undefined) this.lastHighlightTile = highlightTile

    const usePlayers = players || this.lastPlayers
    const useHighlight = highlightTile ?? this.lastHighlightTile

    const { ctx, size } = this
    ctx.clearRect(0, 0, size, size)

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

    this.drawBoard(useHighlight, usePlayers)
    this.drawCenter()
    if (usePlayers) this.drawPlayers(usePlayers)
    this.drawFloatingTexts()
    this.drawParticles()
    this.updateDiceAnim()
  }

  // ===== 格子位置 =====
  private getTilePosition(index: number) {
    const s = this.size, cs = this.cornerSize, normal = (s - cs * 2) / 6
    let x = 0, y = 0, w = 0, h = 0, side: any = 'bottom', isCorner = false

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

  // ===== 棋盘（深色高级格子） =====
  private drawBoard(highlightTile?: number, players?: Player[]) {
    const { ctx } = this
    const pad = 2

    for (let i = 0; i < BOARD_SIZE; i++) {
      const tile = BOARD[i]
      const pos = this.getTilePosition(i)
      const owner = players?.find(p => p.properties.includes(tile.id))
      const cx = pos.x + pos.w / 2
      const cy = pos.y + pos.h / 2

      // --- 格子卡片背景 ---
      const bgColor = i === highlightTile ? 'rgba(139,92,246,0.3)'
        : owner ? 'rgba(255,255,255,0.12)'
        : 'rgba(255,255,255,0.06)'

      ctx.fillStyle = bgColor
      this.roundedRect(pos.x + pad, pos.y + pad, pos.w - pad * 2, pos.h - pad * 2, 6)
      ctx.fill()

      // --- 格子内容 ---
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'

      if (pos.isCorner) {
        ctx.font = '30px sans-serif'
        ctx.fillText(tile.emoji, cx, cy - 12)
        ctx.fillStyle = '#e8e8e8'
        ctx.font = 'bold 17px "Noto Sans SC", sans-serif'
        ctx.fillText(tile.name, cx, cy + 20)
      } else {
        ctx.font = '22px sans-serif'
        ctx.fillText(tile.emoji, cx, cy - 16)

        ctx.fillStyle = '#f0f0f0'
        ctx.font = 'bold 16px "Noto Sans SC", sans-serif'
        ctx.fillText(tile.name, cx, cy + 5)

        if (owner) {
          ctx.font = '15px sans-serif'
          ctx.fillText(owner.avatar, cx, cy + 23)
        } else if (tile.price > 0) {
          ctx.fillStyle = '#8899aa'
          ctx.font = '13px "Noto Sans SC", sans-serif'
          ctx.fillText(`¥${tile.price}`, cx, cy + 23)
        }
      }
    }
  }

  // ===== 中心（标题+骰子） =====
  private drawCenter() {
    const { ctx, size } = this
    const cx = size / 2, cy = size / 2
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'

    ctx.fillStyle = 'rgba(139,92,246,0.15)'
    ctx.font = 'bold 44px "Noto Sans SC", sans-serif'
    ctx.fillText('大富翁', cx + 2, cy - 38)
    ctx.fillStyle = '#8b5cf6'
    ctx.font = 'bold 42px "Noto Sans SC", sans-serif'
    ctx.fillText('大富翁', cx, cy - 40)
    ctx.fillStyle = '#6366f1'
    ctx.font = '24px "Noto Sans SC", sans-serif'
    ctx.fillText('中国行', cx, cy - 5)

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
        ctx.font = 'bold 28px "Noto Sans SC", sans-serif'
        const textW = ctx.measureText(text).width + 30
        ctx.fillStyle = 'rgba(245,158,11,0.15)'
        this.roundedRect(-textW / 2, -18, textW, 36, 18)
        ctx.fill()
        ctx.strokeStyle = 'rgba(245,158,11,0.4)'
        ctx.lineWidth = 1.5
        this.roundedRect(-textW / 2, -18, textW, 36, 18)
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
      ctx.font = '18px sans-serif'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText('♟️', cx, cy + 24)
      ctx.restore()
    }
  }

  // 绘制移动中的棋子（♟️标记 + 旋转和形变）
  private drawTokenAnimated(x: number, y: number, p: Player, rotation: number, scaleX: number, scaleY: number) {
    const { ctx } = this
    const r = 18

    ctx.save()
    ctx.translate(x, y)

    // 阴影（根据高度变化大小）
    const shadowScale = 1 - (25 - Math.abs(y - (this.getTilePosition(this.moveAnim.currentTile).y + this.getTilePosition(this.moveAnim.currentTile).h / 2 + 24))) / 50
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
    ctx.font = '24px sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText('♟️', 0, 1)

    ctx.restore()
  }

  private drawToken(tokenX: number, tokenY: number, p: Player, isCurrent: boolean) {
    const { ctx } = this
    const r = isCurrent ? 18 : 12

    // ===== 当前玩家：高亮光标 =====
    if (isCurrent) {
      // 底部发光光圈
      const glowR = r + 10
      const glowGrad = ctx.createRadialGradient(tokenX, tokenY, r * 0.8, tokenX, tokenY, glowR)
      glowGrad.addColorStop(0, p.color + '55')
      glowGrad.addColorStop(1, p.color + '00')
      ctx.beginPath(); ctx.arc(tokenX, tokenY, glowR, 0, Math.PI * 2)
      ctx.fillStyle = glowGrad; ctx.fill()

      // 脉冲外圈
      const pulseR = r + 4 + Math.sin(this.time * 5) * 2
      ctx.beginPath(); ctx.arc(tokenX, tokenY, pulseR, 0, Math.PI * 2)
      ctx.strokeStyle = p.color
      ctx.lineWidth = 2.5
      ctx.stroke()

      // 顶部指示箭头（向下指）
      const arrowY = tokenY - r - 6
      ctx.beginPath()
      ctx.moveTo(tokenX - 7, arrowY - 12)
      ctx.lineTo(tokenX + 7, arrowY - 12)
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
    ctx.font = `${isCurrent ? 22 : 14}px sans-serif`
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.fillText(p.avatar, tokenX, tokenY + 1)

    // ===== 标签 =====
    const labelStartY = tokenY + r + (isCurrent ? 14 : 10)

    // 玩家名（当前玩家显示）
    if (isCurrent) {
      ctx.font = 'bold 11px "Noto Sans SC", sans-serif'
      const nameW = ctx.measureText(p.name).width + 12
      ctx.fillStyle = p.color
      this.roundedRect(tokenX - nameW / 2, labelStartY - 7, nameW, 14, 7)
      ctx.fill()
      ctx.fillStyle = '#ffffff'
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
      ctx.fillText(p.name, tokenX, labelStartY)
    }

    // 现金（紧凑显示）
    const cashY = labelStartY + (isCurrent ? 15 : 0)
    const cashText = `¥${p.money}`
    ctx.font = `bold ${isCurrent ? 11 : 10}px "Noto Sans SC", sans-serif`
    const cashW = ctx.measureText(cashText).width + 8
    ctx.fillStyle = 'rgba(0,0,0,0.7)'
    this.roundedRect(tokenX - cashW / 2, cashY - 6, cashW, 12, 6)
    ctx.fill()
    ctx.fillStyle = p.money > 500 ? '#4ade80' : p.money > 200 ? '#fbbf24' : '#ef4444'
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.fillText(cashText, tokenX, cashY)
  }

  // ===== 浮动文字 =====
  private drawFloatingTexts() {
    const { ctx } = this
    this.floatingTexts = this.floatingTexts.filter(ft => {
      ft.life++
      const progress = ft.life / ft.maxLife
      const alpha = progress < 0.2 ? progress / 0.2 : progress > 0.7 ? (1 - progress) / 0.3 : 1
      const floatY = ft.y - progress * 40

      ctx.save(); ctx.globalAlpha = alpha
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
      ctx.font = `bold ${ft.fontSize}px "Noto Sans SC", sans-serif`
      const textW = ctx.measureText(ft.text).width
      const pillW = textW + 20, pillH = ft.fontSize + 10
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

  private darkenColor(hex: string, factor: number) {
    const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16)
    return `rgb(${Math.round(r * factor)},${Math.round(g * factor)},${Math.round(b * factor)})`
  }
}
