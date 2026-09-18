import { BOARD, GameState, getStartBonus } from '@/lib/game-engine'

interface TileInfoPopupProps {
  /** 格子索引（BOARD 下标） */
  tileIndex: number
  /** 点击位置的屏幕坐标（用于定位弹窗） */
  x: number
  y: number
  game: GameState
  onClose: () => void
}

const TYPE_DESC: Record<string, string> = {
  property: '商业地产',
  railroad: '交通设施',
  utility: '公用事业',
  chance: '机会卡',
  tax: '税务',
  start: '起点',
  jail: '监狱探访',
  parking: '免费停车',
  goto_jail: '入狱',
}

/**
 * 点击/触摸棋盘格后弹出的地皮信息弹窗：
 * 展示价格、租金、拥有者、路障/涨价状态及特殊格子说明。
 */
export default function TileInfoPopup({ tileIndex, x, y, game, onClose }: TileInfoPopupProps) {
  const tile = BOARD[tileIndex]
  if (!tile) return null

  // 查找拥有者
  const owner = game.players.find(p => p.properties.includes(tile.id))

  // 查找涨价状态
  const hike = game.priceHikes?.find(h => h.tileId === tile.id)

  // 查找路障及放置者
  const roadblock = game.roadblocks?.find(r => r.tileId === tile.id)
  const roadblockOwner = roadblock ? game.players.find(p => p.id === roadblock.ownerPlayerId) : null

  // 计算弹窗位置：基于 canvas 容器
  const boardArea = document.querySelector('.flex-1.relative.flex') as HTMLElement
  const rect = boardArea?.getBoundingClientRect()
  if (!rect) return null

  const relX = x - rect.left
  const relY = y - rect.top
  const popW = Math.min(200, rect.width - 24)
  const rawPopX = relX > rect.width / 2 ? relX - popW - 20 : relX + 20
  const popX = Math.max(8, Math.min(rawPopX, rect.width - popW - 8))
  const popY = Math.max(8, Math.min(relY - 60, rect.height - 100))
  const maxPopH = rect.height - popY - 8

  return (
    <div
      className="absolute z-30 pointer-events-auto bounce-in"
      style={{ left: popX, top: popY, width: popW }}
      onClick={(e) => e.stopPropagation()}
      onTouchMove={(e) => e.stopPropagation()}
    >
      <div className="bg-[#1a1f2e]/95 backdrop-blur-md border border-white/15 rounded-xl p-3 shadow-2xl shadow-black/50 overflow-y-auto overscroll-contain [-webkit-overflow-scrolling:touch]"
        style={{ maxHeight: maxPopH }}>
        {/* 头部 */}
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-1.5">
            <span className="text-xl">{tile.emoji}</span>
            <span className="text-gray-100 font-bold text-sm">{tile.name}</span>
          </div>
          <button onClick={onClose}
            className="w-5 h-5 rounded-full bg-white/10 text-gray-400 text-xs flex items-center justify-center hover:bg-white/20 transition-colors">
            ✕
          </button>
        </div>

        {/* 类型标签 */}
        <div className="flex items-center gap-1.5 mb-2.5">
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/10 text-gray-400">
            {TYPE_DESC[tile.type] || tile.type}
          </span>
          {tile.color && (
            <span className="w-3 h-3 rounded-full border border-white/20"
              style={{ backgroundColor: tile.color }} />
          )}
          {hike && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-500/20 text-red-400 font-medium">
              📈 涨价中({hike.roundsLeft}回合)
            </span>
          )}
          {roadblock && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-orange-500/20 text-orange-400 font-medium">
              🚧 路障
            </span>
          )}
        </div>

        {/* 拥有者 */}
        {owner && (
          <div className="flex items-center gap-1.5 mb-2 py-1.5 px-2 rounded-lg bg-white/5">
            <span className="text-xs">{owner.avatar}</span>
            <span className="text-xs text-gray-300">{owner.name}</span>
            <span className="text-[10px] ml-auto px-1.5 py-0.5 rounded bg-green-500/20 text-green-400">
              拥有者
            </span>
          </div>
        )}
        {!owner && tile.price > 0 && (
          <div className="py-1.5 px-2 mb-2 rounded-lg bg-white/5">
            <span className="text-[10px] text-gray-400">暂无拥有者</span>
          </div>
        )}

        {/* 路障放置者 */}
        {roadblockOwner && (
          <div className="flex items-center gap-1.5 mb-2 py-1.5 px-2 rounded-lg bg-orange-500/10 border border-orange-500/20">
            <span className="text-xs">{roadblockOwner.avatar}</span>
            <span className="text-xs text-orange-300">{roadblockOwner.name}</span>
            <span className="text-[10px] ml-auto px-1.5 py-0.5 rounded bg-orange-500/20 text-orange-400">
              放置路障
            </span>
          </div>
        )}

        {/* 价格和租金 */}
        {tile.price > 0 && (
          <div className="space-y-1.5 text-xs">
            <div className="flex justify-between">
              <span className="text-gray-400">价格</span>
              <span className="text-amber-400 font-bold">¥{tile.price}</span>
            </div>
            {tile.rent.length > 0 && (
              <>
                <div className="flex justify-between">
                  <span className="text-gray-400">基础租金</span>
                  <span className="text-gray-300">¥{tile.rent[0]}</span>
                </div>
                {tile.rent[1] && (
                  <div className="flex justify-between">
                    <span className="text-gray-400">同色加成</span>
                    <span className="text-blue-400">¥{tile.rent[1]}</span>
                  </div>
                )}
                {tile.rent[2] && (
                  <div className="flex justify-between">
                    <span className="text-gray-400">全套租金</span>
                    <span className="text-purple-400 font-medium">¥{tile.rent[2]}</span>
                  </div>
                )}
                {hike && owner && (
                  <div className="flex justify-between">
                    <span className="text-gray-400">涨价后</span>
                    <span className="text-red-400 font-bold">¥{tile.rent[0] * 2}</span>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* 特殊格子描述 */}
        {tile.type === 'chance' && (
          <div className="text-[10px] text-gray-400 mt-2">
            停留时随机触发事件：获得/失去金钱、移动等
          </div>
        )}
        {tile.type === 'tax' && (
          <div className="text-[10px] text-gray-400 mt-2 space-y-0.5">
            {tile.name === '个人所得税' ? (
              <div>停留时缴纳固定税金 <span className="text-orange-400 font-medium">¥100</span></div>
            ) : (
              <>
                <div>停留时缴纳房产税：基础 ¥50 + 每块地 ¥20</div>
                <div>上限 ¥300</div>
                {(() => {
                  const cp = game.players[game.currentPlayer]
                  const count = cp?.properties?.length || 0
                  const tax = Math.min(50 + count * 20, 300)
                  return <div className="text-orange-400 font-medium">当前需缴：¥{tax}（你有 {count} 块地）</div>
                })()}
              </>
            )}
          </div>
        )}
        {tile.type === 'goto_jail' && (
          <div className="text-[10px] text-gray-400 mt-2">
            踩到此格直接送入监狱，无法经过起点领薪
          </div>
        )}
        {tile.type === 'start' && (
          <div className="text-[10px] text-gray-400 mt-2">
            经过或停留起点时获得 ¥{getStartBonus(game.round)} 工资
          </div>
        )}
        {tile.type === 'parking' && (
          <div className="text-[10px] text-gray-400 mt-2">
            安全区域，不会发生任何事件
          </div>
        )}
      </div>
    </div>
  )
}
