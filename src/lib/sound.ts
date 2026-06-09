// 大富翁中国行 - 音效引擎 (Web Audio API)

let audioCtx: AudioContext | null = null
let muted = false

function getCtx(): AudioContext {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)()
  }
  if (audioCtx.state === 'suspended') audioCtx.resume()
  return audioCtx
}

export function setMuted(m: boolean) { muted = m }
export function isMuted() { return muted }

// 骰子翻滚：快速连续短促的敲击声
export function playDiceRoll() {
  if (muted) return
  const ctx = getCtx()
  const now = ctx.currentTime
  const hits = 8

  for (let i = 0; i < hits; i++) {
    const t = now + i * 0.07 + Math.random() * 0.03
    const vol = 0.08 + (i / hits) * 0.12

    // 白噪声短脉冲
    const bufSize = Math.floor(ctx.sampleRate * 0.03)
    const buf = ctx.createBuffer(1, bufSize, ctx.sampleRate)
    const data = buf.getChannelData(0)
    for (let j = 0; j < bufSize; j++) {
      data[j] = (Math.random() * 2 - 1) * (1 - j / bufSize)
    }
    const src = ctx.createBufferSource()
    src.buffer = buf

    // 带通滤波，模拟骰子在桌面滚动
    const filter = ctx.createBiquadFilter()
    filter.type = 'bandpass'
    filter.frequency.value = 2000 + Math.random() * 3000
    filter.Q.value = 2

    const gain = ctx.createGain()
    gain.gain.setValueAtTime(vol, t)
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.04)

    src.connect(filter).connect(gain).connect(ctx.destination)
    src.start(t)
    src.stop(t + 0.05)
  }
}

// 骰子落地：沉闷的撞击声
export function playDiceLand() {
  if (muted) return
  const ctx = getCtx()
  const now = ctx.currentTime

  // 低频撞击
  const osc = ctx.createOscillator()
  osc.type = 'sine'
  osc.frequency.setValueAtTime(180, now)
  osc.frequency.exponentialRampToValueAtTime(60, now + 0.15)

  const gain = ctx.createGain()
  gain.gain.setValueAtTime(0.35, now)
  gain.gain.exponentialRampToValueAtTime(0.001, now + 0.2)

  osc.connect(gain).connect(ctx.destination)
  osc.start(now)
  osc.stop(now + 0.25)

  // 高频碎裂
  const bufSize = Math.floor(ctx.sampleRate * 0.06)
  const buf = ctx.createBuffer(1, bufSize, ctx.sampleRate)
  const data = buf.getChannelData(0)
  for (let j = 0; j < bufSize; j++) {
    data[j] = (Math.random() * 2 - 1) * Math.pow(1 - j / bufSize, 2)
  }
  const src = ctx.createBufferSource()
  src.buffer = buf

  const filter = ctx.createBiquadFilter()
  filter.type = 'highpass'
  filter.frequency.value = 3000

  const g2 = ctx.createGain()
  g2.gain.setValueAtTime(0.15, now)
  g2.gain.exponentialRampToValueAtTime(0.001, now + 0.08)

  src.connect(filter).connect(g2).connect(ctx.destination)
  src.start(now)
  src.stop(now + 0.1)
}

// 棋子逐格跳动音效（每跳一格播放一次）
export function playStepSound() {
  if (muted) return
  const ctx = getCtx()
  const now = ctx.currentTime

  const osc = ctx.createOscillator()
  osc.type = 'sine'
  osc.frequency.setValueAtTime(600 + Math.random() * 200, now)
  osc.frequency.exponentialRampToValueAtTime(300, now + 0.08)

  const gain = ctx.createGain()
  gain.gain.setValueAtTime(0.1, now)
  gain.gain.exponentialRampToValueAtTime(0.001, now + 0.1)

  osc.connect(gain).connect(ctx.destination)
  osc.start(now)
  osc.stop(now + 0.12)
}

// 购买地皮：成功叮咚声
export function playBuySound() {
  if (muted) return
  const ctx = getCtx()
  const now = ctx.currentTime

  const notes = [523, 659, 784] // C5, E5, G5
  notes.forEach((freq, i) => {
    const osc = ctx.createOscillator()
    osc.type = 'sine'
    osc.frequency.value = freq
    const gain = ctx.createGain()
    gain.gain.setValueAtTime(0, now + i * 0.08)
    gain.gain.linearRampToValueAtTime(0.12, now + i * 0.08 + 0.02)
    gain.gain.exponentialRampToValueAtTime(0.001, now + i * 0.08 + 0.2)
    osc.connect(gain).connect(ctx.destination)
    osc.start(now + i * 0.08)
    osc.stop(now + i * 0.08 + 0.25)
  })
}

// 支付/扣钱：低沉的下降音
export function playPaySound() {
  if (muted) return
  const ctx = getCtx()
  const now = ctx.currentTime

  const osc = ctx.createOscillator()
  osc.type = 'triangle'
  osc.frequency.setValueAtTime(400, now)
  osc.frequency.exponentialRampToValueAtTime(150, now + 0.2)

  const gain = ctx.createGain()
  gain.gain.setValueAtTime(0.12, now)
  gain.gain.exponentialRampToValueAtTime(0.001, now + 0.25)

  osc.connect(gain).connect(ctx.destination)
  osc.start(now)
  osc.stop(now + 0.3)
}

// 破产：警示音
export function playBankruptSound() {
  if (muted) return
  const ctx = getCtx()
  const now = ctx.currentTime

  for (let i = 0; i < 3; i++) {
    const osc = ctx.createOscillator()
    osc.type = 'sawtooth'
    osc.frequency.value = 220 - i * 40
    const gain = ctx.createGain()
    gain.gain.setValueAtTime(0.08, now + i * 0.15)
    gain.gain.exponentialRampToValueAtTime(0.001, now + i * 0.15 + 0.18)
    osc.connect(gain).connect(ctx.destination)
    osc.start(now + i * 0.15)
    osc.stop(now + i * 0.15 + 0.2)
  }
}
