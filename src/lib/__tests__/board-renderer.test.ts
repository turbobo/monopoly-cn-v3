import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { BoardRenderer } from '../board-renderer'

// ===== 环境 Mock（node 环境下无 DOM） =====
const fakeWindow = { innerWidth: 1440, innerHeight: 900, devicePixelRatio: 1 }
const computedStyle = { paddingTop: '0px', paddingBottom: '0px', fontFamily: 'Arial' }

function mkCanvas(overrides: Record<string, unknown> = {}) {
  const canvas: any = {
    getContext: vi.fn(() => ({} as any)),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 600, height: 600 }),
    style: {},
    width: 0,
    height: 0,
    parentElement: { clientWidth: 1000, clientHeight: 800 },
    ...overrides,
  }
  return canvas
}

/** 构造 renderer 并直接设定几何状态（跳过 resize，便于精确断言） */
function mkRenderer() {
  const renderer = new BoardRenderer(mkCanvas())
  ;(renderer as any).size = 600
  ;(renderer as any).cornerSize = 60
  return renderer
}

beforeEach(() => {
  vi.stubGlobal('window', fakeWindow)
  vi.stubGlobal('getComputedStyle', vi.fn(() => computedStyle))
  vi.stubGlobal('document', { body: {} })
})

afterEach(() => {
  vi.unstubAllGlobals()
  computedStyle.paddingTop = '0px'
  computedStyle.paddingBottom = '0px'
})

describe('getTilePosition 几何布局', () => {
  // size=600, cornerSize=60 → normal = (600-120)/6 = 80
  it('角格：起点(0)在右下角', () => {
    const pos = (mkRenderer() as any).getTilePosition(0)
    expect(pos).toEqual({ x: 540, y: 540, w: 60, h: 60, side: 'bottom', isCorner: true })
  })

  it('角格：入狱(7)在右上角、度假(14)在左上角、出狱(21)在右下上角', () => {
    const r = mkRenderer()
    const p7 = (r as any).getTilePosition(7)
    expect(p7).toEqual({ x: 0, y: 540, w: 60, h: 60, side: 'right', isCorner: true })
    const p14 = (r as any).getTilePosition(14)
    expect(p14).toEqual({ x: 0, y: 0, w: 60, h: 60, side: 'top', isCorner: true })
    const p21 = (r as any).getTilePosition(21)
    expect(p21).toEqual({ x: 540, y: 0, w: 60, h: 60, side: 'left', isCorner: true })
  })

  it('底边 6 格从右往左排列', () => {
    const r = mkRenderer()
    const p1 = (r as any).getTilePosition(1)
    expect(p1).toEqual({ x: 460, y: 540, w: 80, h: 60, side: 'bottom', isCorner: false })
    const p6 = (r as any).getTilePosition(6)
    expect(p6).toEqual({ x: 60, y: 540, w: 80, h: 60, side: 'bottom', isCorner: false })
  })

  it('右边 6 格从下往上排列', () => {
    const r = mkRenderer()
    const p8 = (r as any).getTilePosition(8)
    expect(p8).toEqual({ x: 0, y: 460, w: 60, h: 80, side: 'right', isCorner: false })
    const p13 = (r as any).getTilePosition(13)
    expect(p13).toEqual({ x: 0, y: 60, w: 60, h: 80, side: 'right', isCorner: false })
  })

  it('顶边与左边格位置正确', () => {
    const r = mkRenderer()
    const p15 = (r as any).getTilePosition(15)
    expect(p15).toEqual({ x: 60, y: 0, w: 80, h: 60, side: 'top', isCorner: false })
    const p22 = (r as any).getTilePosition(22)
    expect(p22).toEqual({ x: 540, y: 60, w: 60, h: 80, side: 'left', isCorner: false })
    const p27 = (r as any).getTilePosition(27)
    expect(p27).toEqual({ x: 540, y: 460, w: 60, h: 80, side: 'left', isCorner: false })
  })
})

describe('hitTest 坐标命中', () => {
  it('点击格子内部返回对应索引', () => {
    const r = mkRenderer()
    expect(r.hitTest(570, 570)).toBe(0)   // 起点（右下角 540..600）
    expect(r.hitTest(30, 30)).toBe(14)    // 度假（左上角 0..60）
    expect(r.hitTest(500, 570)).toBe(1)   // 底边第 1 格（460..540, 540..600）
  })

  it('点击棋盘外返回 -1', () => {
    const r = mkRenderer()
    expect(r.hitTest(610, 610)).toBe(-1)
    expect(r.hitTest(-5, 300)).toBe(-1)
  })

  it('边界恰好落在角格与边格接缝时，优先命中角格（索引更小）', () => {
    const r = mkRenderer()
    // y=540 是 index 7（角格 y∈[540,600]）与 index 8（边格 y∈[460,540]）的接缝，7 < 8 先命中
    expect(r.hitTest(30, 540)).toBe(7)
  })
})

describe('getTileScreenCenter', () => {
  it('返回 CSS 像素中心坐标（含画布偏移）', () => {
    const canvas = mkCanvas({ getBoundingClientRect: () => ({ left: 10, top: 20, width: 300, height: 300 }) })
    const r = new BoardRenderer(canvas)
    ;(r as any).size = 600
    ;(r as any).cornerSize = 60
    expect(r.getTileScreenCenter(0)).toEqual({ x: 580, y: 590 }) // 10+570, 20+570
    expect(r.getTileScreenCenter(14)).toEqual({ x: 40, y: 50 })  // 10+30, 20+30
  })

  it('越界索引返回 null', () => {
    const r = mkRenderer()
    expect(r.getTileScreenCenter(-1)).toBeNull()
    expect(r.getTileScreenCenter(28)).toBeNull()
  })
})

describe('resize 尺寸计算', () => {
  it('桌面端：限制在视口 60% 宽与 90% 高内', () => {
    fakeWindow.innerWidth = 1440
    fakeWindow.innerHeight = 900
    fakeWindow.devicePixelRatio = 2
    const canvas = mkCanvas() // 容器 1000x800
    const r = new BoardRenderer(canvas)
    r.resize()
    // maxW = min(864, 810) = 810; w = min(992, 792, 810) = 792
    expect(canvas.style.width).toBe('792px')
    expect(canvas.width).toBe(1584)
    expect((r as any).size).toBe(1584)
    // cornerSize = tileSize * 1.3 = (1584/8.5)*1.3 ≈ 242.26
    expect((r as any).cornerSize).toBeCloseTo(242.26, 0)
  })

  it('移动端：上限为 min(视口宽-8, 视口高×0.62)', () => {
    fakeWindow.innerWidth = 375
    fakeWindow.innerHeight = 667
    fakeWindow.devicePixelRatio = 2
    const canvas = mkCanvas({ parentElement: { clientWidth: 500, clientHeight: 500 } })
    const r = new BoardRenderer(canvas)
    r.resize()
    // maxW = min(367, 413.5) = 367 → w = 367
    expect(canvas.style.width).toBe('367px')
    expect(canvas.width).toBe(734)

    // 视口更矮时按 0.62 系数收紧
    fakeWindow.innerHeight = 400
    r.resize()
    // maxW = min(367, 248) = 248
    expect(canvas.style.width).toBe('248px')
  })

  it('扣除容器垂直 padding，避免棋盘侵入按钮区域', () => {
    fakeWindow.innerWidth = 375
    fakeWindow.innerHeight = 667
    const container = { clientWidth: 500, clientHeight: 300 }
    const canvas = mkCanvas({ parentElement: container })
    const r = new BoardRenderer(canvas)
    r.resize()
    // 无 padding：w = min(492, 292, 367) = 292
    expect(canvas.style.width).toBe('292px')

    computedStyle.paddingTop = '10px'
    computedStyle.paddingBottom = '6px'
    r.resize()
    // padV=16 → w = min(492, 276, 367) = 276
    expect(canvas.style.width).toBe('276px')
  })
})
