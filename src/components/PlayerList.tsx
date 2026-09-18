import { BOARD, Player, totalWealth } from '@/lib/game-engine'
import { GameMode } from '@/lib/types'

interface PlayerListProps {
  players: Player[]
  currentPlayerId: number | undefined
  mode: GameMode
  priceHikes: { tileId: number; ownerPlayerId: number }[] | undefined
}

/**
 * 信息面板中的玩家列表：掉线/破产特殊态 + 正常玩家卡片。
 * 移动端折叠为单行紧凑布局（md:hidden），桌面端两行布局含资产进度条（hidden md:flex）。
 */
export default function PlayerList({ players, currentPlayerId, mode, priceHikes }: PlayerListProps) {
  return (
    <div className="p-1.5 md:p-3 border-b border-white/8 space-y-1 md:space-y-2 max-h-44 md:max-h-60 overflow-y-auto">
      {players.map(p => {
        const isCurrent = p.id === currentPlayerId
        const propValue = p.properties.reduce((sum, id) => sum + BOARD[id].price, 0)
        const displayMoney = Math.max(0, p.money)
        if (p.disconnected && !p.bankrupt) {
          return (
            <div key={p.id}
              className="p-1.5 md:p-2 rounded-xl flex items-center gap-2 opacity-70"
              style={{ background: 'rgba(250, 204, 21, 0.08)', border: '1px dashed rgba(250, 204, 21, 0.3)' }}>
              <div className="w-6 h-6 md:w-7 md:h-7 rounded-full flex items-center justify-center text-sm md:text-base grayscale"
                style={{ background: p.color + '22', border: `1px solid ${p.color}66` }}>
                {p.avatar}
              </div>
              <span className="text-xs md:text-sm text-gray-300 font-medium flex-1 truncate">{p.name}</span>
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-yellow-500/20 text-yellow-300 font-bold whitespace-nowrap animate-pulse">掉线中 · 60s 宽限</span>
            </div>
          )
        }
        if (p.bankrupt) {
          return (
            <div key={p.id}
              className="p-1.5 md:p-2 rounded-xl flex items-center gap-2 opacity-50"
              style={{ background: 'rgba(255,255,255,0.03)' }}>
              <div className="w-6 h-6 md:w-7 md:h-7 rounded-full flex items-center justify-center text-sm md:text-base grayscale"
                style={{ background: p.color + '22', border: `1px solid ${p.color}66` }}>
                {p.avatar}
              </div>
              <span className="text-xs md:text-sm text-gray-400 font-medium flex-1 truncate">{p.name}</span>
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-500/20 text-red-400 font-bold whitespace-nowrap">已破产</span>
            </div>
          )
        }
        return (
          <div key={p.id}
            className="p-1 md:p-2.5 rounded-xl transition-all relative"
            style={{
              background: isCurrent ? p.color + '18' : 'rgba(255,255,255,0.03)',
              borderWidth: isCurrent ? 1 : 0,
              borderColor: isCurrent ? p.color + '44' : 'transparent',
              boxShadow: isCurrent ? `0 0 0 2px ${p.color}33, 0 0 12px ${p.color}15` : 'none',
            }}>
            {isCurrent && (
              <div className="absolute -left-1 top-1/2 -translate-y-1/2 flex items-center">
                <div className="animate-pulse">
                  <svg width="14" height="20" viewBox="0 0 14 20" fill="none">
                    <path d="M0 10L14 0V20L0 10Z" fill={p.color} />
                  </svg>
                </div>
              </div>
            )}
            {/* 移动端：单行紧凑布局 */}
            <div className="flex items-center gap-1.5 md:hidden">
              <div className="w-6 h-6 rounded-full flex items-center justify-center text-sm relative shrink-0"
                style={{ background: p.color + '33', border: `1.5px solid ${p.color}` }}>
                {p.avatar}
                {isCurrent && (
                  <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-green-400 border border-white animate-pulse" />
                )}
              </div>
              <div className="flex-1 min-w-0 flex items-center gap-1">
                <span className="text-xs text-gray-200 font-medium truncate">{p.name}</span>
                {isCurrent && (
                  <span className="text-[9px] px-1 py-px rounded-full font-bold shrink-0"
                    style={{ background: p.color + '33', color: p.color }}>
                    操作中
                  </span>
                )}
                {mode !== 'online' && p.isAI && (
                  <span className="text-[9px] text-gray-400 shrink-0">
                    ({p.aiPersonality === 'aggressive' ? '激进' : p.aiPersonality === 'conservative' ? '保守' : '平衡'})
                  </span>
                )}
                {p.freePassActive && <span className="text-[9px] shrink-0">🛡️</span>}
                {p.cards.length > 0 && (
                  <span className="text-[9px] text-purple-300 shrink-0">🃏×{p.cards.length}</span>
                )}
                {priceHikes?.some(h => h.ownerPlayerId === p.id) && (
                  <span className="text-[9px] shrink-0">📈</span>
                )}
              </div>
              <div className="text-right text-[10px] leading-tight shrink-0">
                <div className="font-bold" style={{ color: p.color }}>¥{displayMoney}</div>
                <div className="text-amber-400">{p.properties.length}地 ¥{propValue}</div>
              </div>
            </div>
            {/* 桌面端：两行布局 */}
            <div className="hidden md:flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-full flex items-center justify-center text-lg relative"
                  style={{ background: p.color + '33', border: `1.5px solid ${p.color}` }}>
                  {p.avatar}
                  {isCurrent && (
                    <span className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-green-400 border border-white animate-pulse" />
                  )}
                </div>
                <div>
                  <div className="text-sm text-gray-200 font-medium flex items-center gap-1.5">
                    {p.name}
                    {isCurrent && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full font-bold"
                        style={{ background: p.color + '33', color: p.color }}>
                        操作中
                      </span>
                    )}
                    {mode !== 'online' && p.isAI && (
                      <span className="text-xs text-gray-400">
                        ({p.aiPersonality === 'aggressive' ? '激进' : p.aiPersonality === 'conservative' ? '保守' : '平衡'})
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="text-xs" style={{ color: p.color }}>{p.properties.length}块地</span>
                    {/* 道具卡状态 */}
                    {p.freePassActive && (
                      <span className="text-[10px] px-1 py-0.5 rounded bg-blue-500/20 text-blue-300 border border-blue-500/30 flex items-center gap-0.5">
                        🛡️ 免费卡
                      </span>
                    )}
                    {p.cards.length > 0 && (
                      <span className="text-[10px] px-1 py-0.5 rounded bg-purple-500/20 text-purple-300 border border-purple-500/30 flex items-center gap-0.5">
                        🃏 ×{p.cards.length}
                        <span className="opacity-60 ml-0.5">{p.cards.map(c => c.emoji).join('')}</span>
                      </span>
                    )}
                    {priceHikes?.some(h => h.ownerPlayerId === p.id) && (
                      <span className="text-[10px] px-1 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30">
                        📈 涨价中
                      </span>
                    )}
                  </div>
                </div>
              </div>
              <div className="text-right">
                <div className="text-sm font-bold" style={{ color: p.color }}>💰 ¥{displayMoney}</div>
                <div className="text-xs text-amber-400 font-medium">🏠 ¥{propValue}</div>
              </div>
            </div>
            <div className="hidden md:flex items-center gap-2 mt-1">
              <div className="flex-1 h-1.5 rounded-full bg-white/5 overflow-hidden flex">
                <div className="h-full rounded-l-full transition-all duration-500" style={{ width: `${totalWealth(p) > 0 ? (displayMoney / totalWealth(p)) * 100 : 100}%`, background: p.color }} />
                <div className="h-full rounded-r-full transition-all duration-500" style={{ width: `${totalWealth(p) > 0 ? (propValue / totalWealth(p)) * 100 : 0}%`, background: '#f59e0b' }} />
              </div>
              <span className="text-[10px] text-gray-400 whitespace-nowrap">共¥{totalWealth(p)}</span>
            </div>
          </div>
        )
      })}
    </div>
  )
}
