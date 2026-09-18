import { GameMode } from '@/lib/types'

interface ControlBarProps {
  mode: GameMode
  paused: boolean
  muted: boolean
  /** 主操作：本地/AI=重新开始，在线=离开房间 */
  onPrimaryAction: () => void
  onTogglePause: () => void
  onToggleMute: () => void
}

/**
 * 游戏左上角控制按钮栏：暂停（仅本地/AI）、重新开始/离开房间、音效开关。
 * 移动端 32px 圆钮置顶排列，棋盘容器顶部预留空间避免遮挡棋盘格。
 */
export default function ControlBar({ mode, paused, muted, onPrimaryAction, onTogglePause, onToggleMute }: ControlBarProps) {
  return (
    <div className="absolute top-2 left-2 md:top-3 md:left-3 z-10 flex gap-1.5 md:gap-2">
      {mode !== 'online' && (
        <button onClick={onTogglePause}
          aria-label={paused ? '继续游戏' : '暂停游戏'}
          className="w-8 h-8 md:w-10 md:h-10 rounded-full bg-white/10 backdrop-blur-sm border border-white/20 text-white text-base md:text-lg hover:bg-white/20 active:scale-90 transition-all">
          {paused ? '▶️' : '⏸️'}
        </button>
      )}
      <button onClick={onPrimaryAction}
        aria-label={mode === 'online' ? '离开房间' : '重新开始'}
        className="w-8 h-8 md:w-10 md:h-10 rounded-full bg-white/10 backdrop-blur-sm border border-white/20 text-white text-base md:text-lg hover:bg-white/20 active:scale-90 transition-all">
        🔄
      </button>
      <button onClick={onToggleMute}
        aria-label={muted ? '取消静音' : '静音'}
        className="w-8 h-8 md:w-10 md:h-10 rounded-full bg-white/10 backdrop-blur-sm border border-white/20 text-white text-base md:text-lg hover:bg-white/20 active:scale-90 transition-all">
        {muted ? '🔇' : '🔊'}
      </button>
    </div>
  )
}
