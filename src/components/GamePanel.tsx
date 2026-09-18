import { RefObject } from 'react'
import { BOARD, GameCard, GameState, Tile, totalWealth } from '@/lib/game-engine'
import { GameMode } from '@/lib/types'
import PlayerList from '@/components/PlayerList'

interface GamePanelProps {
  game: GameState
  messages: string[]
  buyPrompt: { tile: Tile } | null
  selectedCard: GameCard | null
  showCardPanel: boolean
  diceResult: number | null
  rolling: boolean
  paused: boolean
  isMyTurn: boolean
  myName: string
  mode: GameMode
  turnAnim: 'idle' | 'out' | 'in'
  logRef: RefObject<HTMLDivElement>
  onRoll: () => void
  onBuy: (decision: boolean) => void
  onUseCard: (card: GameCard, target?: { playerIdx?: number; tileId?: number; diceTotal?: number }) => void
  onSelectCard: (card: GameCard | null) => void
  onToggleCardPanel: (show: boolean) => void
}

/**
 * 右侧信息面板：当前玩家 → 玩家列表 → 操作区（掷骰/购买/道具卡）→ 游戏日志 → 地皮归属。
 * 移动端限高 44dvh 上下排列，桌面端固定 320px 侧栏。
 */
export default function GamePanel(props: GamePanelProps) {
  const {
    game, messages, buyPrompt, selectedCard, showCardPanel, diceResult,
    rolling, paused, isMyTurn, myName, mode, turnAnim, logRef,
    onRoll, onBuy, onUseCard, onSelectCard, onToggleCardPanel,
  } = props

  const currentPlayer = game.players[game.currentPlayer]
  const isCurrentPlayerHuman = mode === 'online' ? true : (currentPlayer && !currentPlayer.isAI)

  return (
    <div className="w-full max-h-[44dvh] md:max-h-none md:w-80 bg-[#1a2332] md:border-l border-t md:border-t-0 border-white/8 flex flex-col overflow-y-auto md:overflow-hidden shrink-0">
      {/* 当前玩家 */}
      <div className="p-2 md:p-4 border-b border-white/8 relative overflow-hidden">
        <div className="absolute inset-0 opacity-10" style={{ background: `linear-gradient(135deg, ${currentPlayer?.color}44, transparent)` }} />
        <div className="absolute top-0 left-0 w-full h-1" style={{ background: currentPlayer?.color }} />
        <div className={`relative flex items-center justify-between ${turnAnim === 'out' ? 'turn-slide-out' : turnAnim === 'in' ? 'turn-slide-in' : ''}`}>
          <div className="flex items-center gap-2.5 md:gap-3">
            <div className="w-8 h-8 md:w-12 md:h-12 rounded-full flex items-center justify-center text-lg md:text-2xl shadow-lg"
              style={{ background: currentPlayer?.color + '33', border: `2px solid ${currentPlayer?.color}` }}>
              {currentPlayer?.avatar}
            </div>
            <div>
              <div className="text-gray-100 font-bold text-sm md:text-lg">{currentPlayer?.name}的回合</div>
              <div className="text-[10px] md:text-xs text-gray-400">第{game.round}回合{game.maxRounds > 0 ? ` / 共${game.maxRounds}回合` : ' · 淘汰制'}</div>
            </div>
          </div>
          <div className="text-right">
            <div className="text-[10px] md:text-xs text-gray-400">现金 <span className="text-sm font-bold" style={{ color: currentPlayer?.color }}>¥{currentPlayer?.money}</span></div>
            <div className="text-[10px] md:text-xs text-gray-400">资产 <span className="text-sm font-bold text-amber-400">¥{currentPlayer ? totalWealth(currentPlayer) : 0}</span></div>
          </div>
        </div>
      </div>

      {/* 玩家列表 */}
      <PlayerList
        players={game.players}
        currentPlayerId={currentPlayer?.id}
        mode={mode}
        priceHikes={game.priceHikes}
      />

      {/* 操作区 */}
      <div className="p-2 md:p-4 border-b border-white/8">
        {diceResult && !buyPrompt && !selectedCard && (
          <div className="text-center text-sm text-amber-400 font-bold mb-2 bounce-in">
            🎲 {diceResult}
          </div>
        )}
        {selectedCard ? (
          <div className="card-flip-in">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-xl">{selectedCard.emoji}</span>
              <span className="text-gray-100 font-bold">{selectedCard.name}</span>
            </div>
            <div className="text-xs text-gray-400 mb-3">{selectedCard.description}</div>

            {selectedCard.type === 'remote_dice' && (
              <div className="space-y-2">
                <div className="text-xs text-gray-300 mb-1">选择点数 (2-12)：</div>
                <div className="grid grid-cols-6 gap-1.5">
                  {[2,3,4,5,6,7,8,9,10,11,12].map(n => (
                    <button key={n} onClick={() => onUseCard(selectedCard, { diceTotal: n })}
                      className="py-2 bg-white/10 rounded text-white text-sm font-bold hover:bg-amber-500/40 transition-colors">
                      {n}
                    </button>
                  ))}
                </div>
                <button onClick={() => onSelectCard(null)}
                  className="w-full mt-2 py-2 bg-white/5 rounded text-gray-400 text-sm hover:bg-white/10">
                  取消
                </button>
              </div>
            )}

            {selectedCard.type === 'swap' && (
              <div className="space-y-2">
                <div className="text-xs text-gray-300 mb-1">选择要交换位置的玩家：</div>
                {game.players.filter(p => p.id !== currentPlayer?.id && !p.bankrupt && !p.disconnected).map(p => (
                  <button key={p.id} onClick={() => onUseCard(selectedCard, { playerIdx: p.id })}
                    className="w-full py-2.5 bg-white/8 rounded-xl text-left px-3 hover:bg-white/15 transition-colors flex items-center gap-2">
                    <span>{p.avatar}</span>
                    <span className="text-sm text-gray-200">{p.name}</span>
                    <span className="text-xs text-gray-400 ml-auto">¥{Math.max(0, p.money)}</span>
                  </button>
                ))}
                <button onClick={() => onSelectCard(null)}
                  className="w-full mt-2 py-2 bg-white/5 rounded text-gray-400 text-sm hover:bg-white/10">
                  取消
                </button>
              </div>
            )}

            {selectedCard.type === 'roadblock' && (
              <div className="space-y-2">
                <div className="text-xs text-gray-300 mb-1">选择放置路障的格子：</div>
                <div className="max-h-40 overflow-y-auto space-y-1">
                  {BOARD.filter(t => t.type === 'property' || t.type === 'railroad' || t.type === 'utility').map(t => (
                    <button key={t.id} onClick={() => onUseCard(selectedCard, { tileId: t.id })}
                      className="w-full py-2 bg-white/8 rounded text-left px-3 hover:bg-white/15 transition-colors flex items-center gap-2 text-sm">
                      <span>{t.emoji}</span>
                      <span className="text-gray-200">{t.name}</span>
                    </button>
                  ))}
                </div>
                <button onClick={() => onSelectCard(null)}
                  className="w-full mt-2 py-2 bg-white/5 rounded text-gray-400 text-sm hover:bg-white/10">
                  取消
                </button>
              </div>
            )}

            {selectedCard.type === 'free_pass' && (
              <div className="flex gap-2">
                <button onClick={() => onUseCard(selectedCard)}
                  className="flex-1 py-2.5 bg-blue-600 rounded-xl text-white text-sm font-bold hover:bg-blue-500 transition-colors">
                  立即激活
                </button>
                <button onClick={() => onSelectCard(null)}
                  className="flex-1 py-2.5 bg-white/8 rounded-xl text-gray-400 text-sm hover:bg-white/10">
                  取消
                </button>
              </div>
            )}

            {selectedCard.type === 'price_hike' && (
              <div className="space-y-2">
                <div className="text-xs text-gray-300 mb-1">选择要涨价的地皮（你的地皮）：</div>
                <div className="max-h-40 overflow-y-auto space-y-1">
                  {(currentPlayer?.properties || []).map(tid => {
                    const t = BOARD[tid]
                    return (
                      <button key={tid} onClick={() => onUseCard(selectedCard, { tileId: tid })}
                        className="w-full py-2 bg-white/8 rounded text-left px-3 hover:bg-white/15 transition-colors flex items-center gap-2 text-sm">
                        <span>{t.emoji}</span>
                        <span className="text-gray-200">{t.name}</span>
                        <span className="text-xs text-gray-400 ml-auto">租金 ¥{t.rent[0]} → ¥{t.rent[0]*2}</span>
                      </button>
                    )
                  })}
                </div>
                {(!currentPlayer?.properties || currentPlayer.properties.length === 0) && (
                  <div className="text-xs text-gray-400 text-center py-2">你没有地皮可以使用涨价卡</div>
                )}
                <button onClick={() => onSelectCard(null)}
                  className="w-full mt-2 py-2 bg-white/5 rounded text-gray-400 text-sm hover:bg-white/10">
                  取消
                </button>
              </div>
            )}
          </div>
        ) : buyPrompt ? (
          <div className="bounce-in">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-xl">{buyPrompt.tile.emoji}</span>
              <span className="text-gray-100 font-bold">{buyPrompt.tile.name}</span>
            </div>
            <div className="text-xs text-gray-400 mb-3">
              价格 ¥{buyPrompt.tile.price} · 基础租金 ¥{buyPrompt.tile.rent[0]}
              {buyPrompt.tile.rent[2] && ` · 全套租金 ¥${buyPrompt.tile.rent[2]}`}
            </div>
            <div className="flex gap-2">
              <button onClick={() => onBuy(true)}
                className="flex-1 py-2.5 bg-green-600 rounded-xl text-white text-sm font-bold hover:bg-green-500 transition-all shadow-lg shadow-green-600/30 active:scale-[0.98]">
                💰 购买
              </button>
              <button onClick={() => onBuy(false)}
                className="flex-1 py-2.5 bg-white/8 rounded-xl text-gray-400 text-sm hover:bg-white/15 transition-all active:scale-[0.98]">
                跳过
              </button>
            </div>
          </div>
        ) : isCurrentPlayerHuman && !rolling ? (
          <div className="space-y-2">
            <button onClick={onRoll}
              disabled={paused || rolling || currentPlayer?.bankrupt || (currentPlayer?.disconnected && currentPlayer?.name !== myName) || (mode === 'online' && !isMyTurn)}
              className="w-full py-2.5 md:py-3.5 bg-gradient-to-r from-orange-500 to-red-500 rounded-xl text-white font-bold hover:from-orange-400 hover:to-red-400 transition-all shadow-lg shadow-orange-500/30 active:scale-95 text-base md:text-lg disabled:opacity-50 disabled:cursor-not-allowed">
              {mode === 'online' && !isMyTurn
                ? `⏳ 等待 ${currentPlayer?.name} 操作...`
                : currentPlayer?.disconnected && currentPlayer?.name === myName
                ? '🎲 重连成功，继续掷骰子'
                : '🎲 掷骰子'}
            </button>
            {/* 道具卡按钮 */}
            {currentPlayer && currentPlayer.cards.length > 0 && game.phase === 'roll' && (mode !== 'online' || isMyTurn) && (
              <button onClick={() => onToggleCardPanel(!showCardPanel)}
                className="w-full py-2 bg-purple-600/30 border border-purple-500/40 rounded-xl text-purple-300 text-sm font-medium hover:bg-purple-600/50 transition-colors flex items-center justify-center gap-2">
                🃏 道具卡 ({currentPlayer.cards.length})
                {showCardPanel ? ' ▲' : ' ▼'}
              </button>
            )}
            {showCardPanel && currentPlayer && currentPlayer.cards.length > 0 && (
              <div className="space-y-1.5 bounce-in">
                {currentPlayer.cards.map((card, i) => (
                  <button key={card.id || i} onClick={() => onSelectCard(card)}
                    className="w-full py-2 px-3 bg-white/5 border border-white/10 rounded-xl text-left hover:bg-white/10 transition-colors flex items-center gap-2">
                    <span className="text-lg">{card.emoji}</span>
                    <div className="flex-1">
                      <div className="text-sm text-gray-200 font-medium">{card.name}</div>
                      <div className="text-[10px] text-gray-400">{card.description}</div>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="text-center text-gray-500 py-3 animate-pulse">
            {rolling ? '🎲 骰子翻滚中...' : '⏳ 等待中...'}
          </div>
        )}
      </div>

      {/* 游戏日志（移动端限高，桌面端自适应） */}
      <div className="max-h-24 md:max-h-none md:flex-1 overflow-hidden flex flex-col">
        <div className="px-2.5 pt-2 md:px-4 md:pt-3 text-xs text-gray-400 font-medium">游戏日志</div>
        <div ref={logRef} className="flex-1 overflow-y-auto p-2.5 md:p-4 space-y-1.5">
          {messages.map((msg, i) => {
            const isLast = i === messages.length - 1
            return (
              <div key={i} className={`text-xs transition-all ${isLast ? 'text-gray-100 font-medium fade-in' : 'text-gray-500'}`}>
                {msg}
              </div>
            )
          })}
        </div>
      </div>

      {/* 地皮归属 */}
      <div className="p-2 md:p-3 border-t border-white/8 max-h-20 md:max-h-44 overflow-y-auto">
        <div className="text-xs text-gray-400 mb-2">地皮归属</div>
        {game.players.filter(p => p.properties.length > 0).map(p => (
          <div key={p.id} className="mb-2">
            <div className="flex items-center gap-1 mb-1">
              <span className="text-xs">{p.avatar}</span>
              <span className="text-xs font-medium" style={{ color: p.color }}>{p.name}</span>
            </div>
            <div className="flex flex-wrap gap-1">
              {p.properties.map(id => (
                <span key={id} className="text-xs px-1.5 py-0.5 rounded text-white font-medium"
                  style={{ background: BOARD[id].color + '99' }}>
                  {BOARD[id].name}
                </span>
              ))}
            </div>
          </div>
        ))}
        {game.players.every(p => p.properties.length === 0) && (
          <span className="text-xs text-gray-500">暂无地皮</span>
        )}
      </div>
    </div>
  )
}
