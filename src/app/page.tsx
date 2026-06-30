'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { BoardRenderer } from '@/lib/board-renderer'
import {
  GameState, BOARD, BOARD_SIZE, Player, GameCard, CardType,
  createGame, executeTurn, buyProperty, totalWealth, getStartBonus,
  rollDice, finalizeTurn, nextPlayer, useRemoteDice, useSwapCard, useRoadblockCard,
  useFreePassCard, usePriceHikeCard, aiUseCardDecision,
} from '@/lib/game-engine'
import { playDiceRoll, playDiceLand, playStepSound, playBuySound, playPaySound, playBankruptSound, playPlayerJoinSound, playPlayerLeaveSound, setMuted } from '@/lib/sound'
import { GoEasyManager, PeerMessage } from '@/lib/goeasy-manager'
import { slimGame, trimMessages, mergeMessages } from '@/lib/online-utils'

type Screen = 'menu' | 'setup' | 'lobby' | 'game' | 'end'
type GameMode = 'ai' | 'local' | 'online'
type OnlineRole = 'host' | 'guest' | null

interface OnlinePlayer {
  id: string
  name: string
  isHost: boolean
}

export default function MonopolyGame() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rendererRef = useRef<BoardRenderer | null>(null)
  const peerRef = useRef<GoEasyManager | null>(null)
  const logRef = useRef<HTMLDivElement>(null)

  // Keep refs for latest state (avoids stale closures in callbacks)
  const gameRef = useRef<GameState | null>(null)
  const messagesRef = useRef<string[]>([])
  const onlinePlayersRef = useRef<OnlinePlayer[]>([])
  const myNameRef = useRef('')
  const buyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const aiTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)   // AI 回合延迟
  const guestRollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)  // Guest 掷骰超时
  const playersRef = useRef<OnlinePlayer[]>([])
  const screenRef = useRef<Screen>('menu')
  const animatingRef = useRef(false)
  const roomValidatedRef = useRef(false)
  const buyPromptRef = useRef<{ tile: typeof BOARD[0] } | null>(null)
  const pendingDiceRolledRef = useRef<PeerMessage[]>([])
  const forcedDiceRef = useRef<[number, number] | null>(null)  // 游戏状态
  const [screen, setScreen] = useState<Screen>('menu')
  const [mode, setMode] = useState<GameMode>('local')
  const [playerCount, setPlayerCount] = useState(2)
  const [initialMoney, setInitialMoney] = useState(1500)
  const [maxRounds, setMaxRounds] = useState(0) // 0=无限（纯淘汰制）
  const [difficulty, setDifficulty] = useState<'easy' | 'normal' | 'hard'>('normal')
  const [game, setGame] = useState<GameState | null>(null)
  const [messages, setMessages] = useState<string[]>([])
  const [rolling, setRolling] = useState(false)
  const [diceResult, setDiceResult] = useState<number | null>(null)
  const [buyPrompt, setBuyPrompt] = useState<{ tile: typeof BOARD[0] } | null>(null)
  const [paused, setPaused] = useState(false)
  const [copied, setCopied] = useState(false)
  const [muted, setMutedState] = useState(false)
  const [selectedCard, setSelectedCard] = useState<GameCard | null>(null)
  const [showCardPanel, setShowCardPanel] = useState(false)
  const [tileInfo, setTileInfo] = useState<{ tileIndex: number; x: number; y: number } | null>(null)

  // 回合切换过渡动画
  const [turnAnim, setTurnAnim] = useState<'idle' | 'out' | 'in'>('idle')
  const prevPlayerRef = useRef<number>(-1)

  // 在线模式状态
  const [onlineRole, setOnlineRole] = useState<OnlineRole>(null)
  const [playerName, setPlayerName] = useState(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('monopoly-player-name')
      if (saved) return saved
    }
    return `玩家${Math.floor(1000 + Math.random() * 9000)}`
  })
  const [roomId, setRoomId] = useState('')
  const [joinRoomId, setJoinRoomId] = useState('')
  const [onlinePlayers, setOnlinePlayers] = useState<OnlinePlayer[]>([])
  const [connecting, setConnecting] = useState(false)
  const [connectionError, setConnectionError] = useState('')
  const [isMyTurn, setIsMyTurn] = useState(false)
  const [gameStarting, setGameStarting] = useState(false)

  // Sync refs with state
  useEffect(() => { gameRef.current = game }, [game])
  useEffect(() => { messagesRef.current = messages }, [messages])
  useEffect(() => { onlinePlayersRef.current = onlinePlayers }, [onlinePlayers])
  useEffect(() => {
    myNameRef.current = playerName
    if (playerName.trim()) localStorage.setItem('monopoly-player-name', playerName)
  }, [playerName])
  useEffect(() => { playersRef.current = onlinePlayers }, [onlinePlayers])
  useEffect(() => { screenRef.current = screen }, [screen])
  useEffect(() => { buyPromptRef.current = buyPrompt }, [buyPrompt])

  // 回合切换过渡动画（仅本地/AI模式）
  useEffect(() => {
    if (!game || mode === 'online') return
    const cp = game.currentPlayer
    if (prevPlayerRef.current >= 0 && prevPlayerRef.current !== cp) {
      setTurnAnim('out')
      const t1 = setTimeout(() => setTurnAnim('in'), 300)
      const t2 = setTimeout(() => { setTurnAnim('idle'); prevPlayerRef.current = cp }, 600)
      return () => { clearTimeout(t1); clearTimeout(t2) }
    }
    prevPlayerRef.current = cp
  }, [game?.currentPlayer, mode])

  // 页面卸载时清理 LCManager，防止僵尸连接
  useEffect(() => {
    const cleanup = () => {
      if (peerRef.current) {
        peerRef.current.destroy()
        peerRef.current = null
      }
    }
    window.addEventListener('beforeunload', cleanup)
    return () => {
      window.removeEventListener('beforeunload', cleanup)
      cleanup()
    }
  }, [])

  // 初始化 Canvas
  useEffect(() => {
    if (!canvasRef.current) return
    const renderer = new BoardRenderer(canvasRef.current)
    rendererRef.current = renderer
    renderer.resize()
    renderer.start()

    let resizeTimer: ReturnType<typeof setTimeout>
    let orientTimer: ReturnType<typeof setTimeout>
    const handleResize = () => {
      clearTimeout(resizeTimer)
      resizeTimer = setTimeout(() => renderer.resize(), 100)
    }
    const handleOrientation = () => {
      clearTimeout(orientTimer)
      orientTimer = setTimeout(() => renderer.resize(), 150)
    }
    window.addEventListener('resize', handleResize)
    window.addEventListener('orientationchange', handleOrientation)

    return () => {
      clearTimeout(resizeTimer)
      clearTimeout(orientTimer)
      renderer.stop()
      window.removeEventListener('resize', handleResize)
      window.removeEventListener('orientationchange', handleOrientation)
    }
  }, [])

  // 清理 LeanCloud 连接
  useEffect(() => {
    return () => {
      if (peerRef.current) {
        peerRef.current.destroy()
      }
    }
  }, [])

  // 同步游戏状态到 Canvas
  useEffect(() => {
    if (game && rendererRef.current) {
      rendererRef.current.draw(game.players, game.players[game.currentPlayer]?.position, {
        roadblocks: game.roadblocks,
        priceHikes: game.priceHikes,
      })
      rendererRef.current.setCurrentPlayer(game.currentPlayer)
    }
  }, [game])

  // 滚动日志
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight
    }
  }, [messages])

  // 音效开关
  useEffect(() => {
    setMuted(muted)
  }, [muted])

  // 检查是否轮到我
  useEffect(() => {
    if (mode !== 'online' || !game) {
      setIsMyTurn(true)
      return
    }
    const myIdx = game.players.findIndex(p => p.name === myNameRef.current)
    setIsMyTurn(myIdx === game.currentPlayer)
  }, [game, mode, playerName])

  // ===== 在线模式：广播游戏状态 =====
  const broadcastState = useCallback((gs: GameState, msgs: string[]) => {
    const peer = peerRef.current
    if (!peer) return
    peer.broadcast({
      type: 'game-state',
      payload: { game: slimGame(gs), messages: trimMessages(msgs) },
    })
  }, [])

  // ===== 在线模式：处理消息 =====

  // ===== 注册 LeanCloud 消息处理 =====
  const setupPeerHandlers = useCallback((peer: GoEasyManager) => {

    // Guest 端播放 dice-rolled 动画（提取为函数，支持补播）
    const playGuestDiceRolled = (
      diceValues: [number, number], playerIndex: number, fromTile: number,
      newGame: GameState | null, newMsgs: string[]
    ) => {
      if (newGame) {
        gameRef.current = newGame
        messagesRef.current = newMsgs || []
      }
      animatingRef.current = true
      setRolling(true)
      playDiceRoll()

      rendererRef.current?.playDiceAnimation(diceValues, () => {
        playDiceLand()
        setDiceResult(diceValues[0] + diceValues[1])

        const gs = gameRef.current || newGame
        if (gs) {
          const player = gs.players[playerIndex]
          if (player) {
            const oldPos = fromTile ?? player.position
            const steps = diceValues[0] + diceValues[1]

            rendererRef.current?.playMoveAnimation(
              player.id, oldPos, steps, player.color, player.avatar,
              () => {
                animatingRef.current = false
                // 用 gameRef 更新棋盘/金钱等最新状态
                const latestGame = gameRef.current || newGame
                const latestMsgs = messagesRef.current || newMsgs || []
                if (latestGame) {
                  setGame(latestGame)
                  setMessages(latestMsgs)
                  setRolling(false)
                  gameRef.current = latestGame
                  if (latestGame.gameOver) setScreen('end')
                }
                // 购买提示必须用 dice-rolled 时的 newGame（gameRef 可能被后续 game-state 覆盖导致 currentPlayer 不对）
                const buyDecisionGame = (newGame && newGame.phase === 'action') ? newGame : latestGame
                if (buyDecisionGame && !buyDecisionGame.gameOver && buyDecisionGame.phase === 'action') {
                  const buyer = buyDecisionGame.players[buyDecisionGame.currentPlayer]
                  if (buyer && buyer.name === myNameRef.current) {
                    setBuyPrompt({ tile: BOARD[buyer.position] })
                  }
                } else {
                  setBuyPrompt(null)
                }
                const lastMsg = latestMsgs[latestMsgs.length - 1] || ''
                if (lastMsg.includes('购买')) playBuySound()
                if (lastMsg.includes('支付') || lastMsg.includes('缴纳')) playPaySound()
                if (lastMsg.includes('破产')) playBankruptSound()

                // 检查是否有待播放的 dice-rolled
                if (pendingDiceRolledRef.current.length > 0) {
                  const pending = pendingDiceRolledRef.current.shift()!
                  const p = pending.payload
                  // 用更快的速度补播（3x 骰子，2.5x 移动）
                  setTimeout(() => {
                    playGuestDiceRolled(p.dice, p.playerIndex, p.fromTile, p.game, p.messages)
                  }, 100)
                }
              },
              () => playStepSound(),
              1.8
            )
          } else {
            animatingRef.current = false
            setRolling(false)
          }
        } else {
          animatingRef.current = false
          setRolling(false)
        }
      }, 2)
    }

    const messageHandler = (message: PeerMessage, fromPeerId: string) => {
      switch (message.type) {
        case 'player-join': {
          if (peer.getIsHost()) {
            if (playersRef.current.length >= 4) {
              peer.broadcast({
                type: 'error',
                payload: { message: '房间已满（最多4人）', target: message.from },
              })
              break
            }
            let joinName: string = message.payload.name
            const existingNames = playersRef.current.map(p => p.name)
            if (existingNames.includes(joinName)) {
              let suffix = 2
              while (existingNames.includes(`${joinName}(${suffix})`)) suffix++
              joinName = `${joinName}(${suffix})`
            }
            const newPlayer: OnlinePlayer = {
              id: message.from,
              name: joinName,
              isHost: false,
            }
            peer.trackPeer(message.from)
            const updated = [...playersRef.current, newPlayer]
            playersRef.current = updated
            setOnlinePlayers(updated)
            playPlayerJoinSound()
            peer.broadcast({
              type: 'room-info',
              payload: {
                players: updated.map(p => ({ id: p.id, name: p.name, isHost: p.isHost })),
              }
            })
          }
          break
        }

        case 'room-info': {
          if (!peer.getIsHost()) {
            roomValidatedRef.current = true
            peer.trackPeer(fromPeerId)
            const players = message.payload.players.map((p: any) => ({
              id: p.id,
              name: p.name,
              isHost: p.isHost,
            }))
            const prevCount = playersRef.current.length
            playersRef.current = players
            setOnlinePlayers(players)
            // 人数变化时播放提示音
            if (prevCount > 0 && players.length > prevCount) playPlayerJoinSound()
            else if (prevCount > 0 && players.length < prevCount) playPlayerLeaveSound()
            const myEntry = players.find((p: OnlinePlayer) => p.id === peer.getClientId())
            if (myEntry && myEntry.name !== myNameRef.current) {
              setConnectionError(`名称已被占用，已自动改为「${myEntry.name}」`)
              setPlayerName(myEntry.name)
            }
          }
          break
        }

        case 'error': {
          if (!peer.getIsHost() && message.payload.target === peer.getClientId()) {
            setConnectionError(message.payload.message)
            peer.destroy()
            peerRef.current = null
            setScreen('setup')
            setOnlineRole(null)
            setOnlinePlayers([])
          }
          break
        }

        case 'dice-rolled': {
          if (!peer.getIsHost()) {
            const { dice: diceValues, playerIndex, fromTile, game: newGame, messages: remoteMsgs } = message.payload
            const newMsgs = mergeMessages(messagesRef.current, remoteMsgs || [])

            // 如果上一个动画还在播放，保存到待播放队列，动画完成后补播
            if (animatingRef.current) {
              pendingDiceRolledRef.current.push({ ...message, payload: { ...message.payload, messages: newMsgs } })
              if (newGame) {
                gameRef.current = newGame
                messagesRef.current = newMsgs
              }
              return
            }

            playGuestDiceRolled(diceValues, playerIndex, fromTile, newGame, newMsgs)
          }
          break
        }

        case 'game-state': {
          if (!peer.getIsHost()) {
            const { game: newGame, messages: remoteMsgs } = message.payload
            const newMsgs = mergeMessages(messagesRef.current, remoteMsgs || [])

            // 动画进行中：仅缓存到ref，不打断动画（dice-rolled回调会处理状态更新）
            if (animatingRef.current) {
              gameRef.current = newGame
              messagesRef.current = newMsgs
              return
            }

            setGame(newGame)
            setMessages(newMsgs)
            messagesRef.current = newMsgs
            setRolling(false)
            // 收到游戏状态时自动进入游戏画面
            if (newGame && screenRef.current !== 'game' && screenRef.current !== 'end') {
              setScreen('game')
              setDiceResult(null)
              peer.startHeartbeat()
            }
            if (newGame.gameOver) setScreen('end')

            // 如果是自己的回合且需要购买决策，显示购买提示
            if (newGame && !newGame.gameOver && newGame.phase === 'action') {
              const buyer = newGame.players[newGame.currentPlayer]
              if (buyer && buyer.name === myNameRef.current) {
                const tile = BOARD[buyer.position]
                setBuyPrompt({ tile })
              }
            } else {
              setBuyPrompt(null)
            }

            const lastMsg = newMsgs[newMsgs.length - 1] || ''
            if (lastMsg.includes('掷出')) playDiceLand()
            if (lastMsg.includes('购买')) playBuySound()
            if (lastMsg.includes('支付') || lastMsg.includes('缴纳')) playPaySound()
            if (lastMsg.includes('破产')) playBankruptSound()
          }
          break
        }

        case 'player-action': {
          if (peer.getIsHost()) {
            const gs = gameRef.current
            if (!gs) break
            const actionPlayerIdx = gs.players.findIndex(p => p.name === message.payload.playerName)
            if (actionPlayerIdx !== gs.currentPlayer) break

            if (message.payload.type === 'roll') {
              // 房主代替 Guest 执行掷骰
              executeHostRollRef.current()
            } else if (message.payload.type === 'buy') {
              if (gs.phase !== 'action') break
              const buyPlayerIdx = gs.players.findIndex(p => p.name === message.payload.playerName)
              if (buyPlayerIdx !== gs.currentPlayer) break

              if (buyTimeoutRef.current) {
                clearTimeout(buyTimeoutRef.current)
                buyTimeoutRef.current = null
              }
              const newState: GameState = JSON.parse(JSON.stringify(gs))
              const player = newState.players[newState.currentPlayer]
              const tile = BOARD[player.position]
              const newMsgs = [...messagesRef.current]

              if (message.payload.buy) {
                if (buyProperty(player, tile.id)) {
                  newMsgs.push(`🏠 ${player.name} 购买了 ${tile.name}`)
                  playBuySound()
                } else {
                  newMsgs.push(`❌ ${player.name} 资金不足，无法购买 ${tile.name}（需要 ¥${tile.price}）`)
                }
              } else {
                newMsgs.push(`❌ ${player.name} 放弃购买 ${tile.name}`)
              }

              const finalMsgs = finalizeTurn(newState)
              for (const msg of finalMsgs) {
                if (msg.includes('破产')) playBankruptSound()
              }
              newMsgs.push(...finalMsgs)

              setMessages(newMsgs)
              setGame(newState)
              gameRef.current = newState
              broadcastState(newState, newMsgs)

              if (newState.gameOver) setScreen('end')
            }
          }
          break
        }

        case 'card-action': {
          if (peer.getIsHost()) {
            const gs = gameRef.current
            if (!gs || gs.phase !== 'roll') break
            const { cardType, cardId, playerName: actorName, target } = message.payload
            const actorIdx = gs.players.findIndex(p => p.name === actorName)
            if (actorIdx !== gs.currentPlayer) break // 必须是当前回合的玩家才能用卡
            const actor = gs.players[actorIdx]
            if (!actor || actor.bankrupt) break
            // 验证卡片确实属于该玩家
            if (!actor.cards.some((c: GameCard) => c.id === cardId)) break

            const newState: GameState = JSON.parse(JSON.stringify(gs))
            const player = newState.players[actorIdx]
            const newMsgs = [...messagesRef.current]
            let msg = ''
            let autoRoll = false

            switch (cardType) {
              case 'remote_dice':
                if (target?.diceTotal) {
                  if (forcedDiceRef.current) break // 防止竞态：已有待处理的强制骰子
                  const [d1, d2] = useRemoteDice(target.diceTotal)
                  msg = `🎯 ${player.name} 使用遥控骰子，指定点数 ${d1}+${d2}=${d1+d2}`
                  const ci = player.cards.findIndex((c: GameCard) => c.id === cardId)
                  if (ci >= 0) player.cards.splice(ci, 1)
                  // 设置强制骰子并自动掷骰
                  forcedDiceRef.current = [d1, d2]
                  autoRoll = true
                }
                break
              case 'swap':
                if (target?.playerIdx !== undefined) {
                  const targetPlayer = newState.players.find(p => p.id === target.playerIdx)
                  if (targetPlayer) msg = useSwapCard(newState, player.id, targetPlayer.id)
                }
                break
              case 'roadblock':
                if (target?.tileId !== undefined) {
                  msg = useRoadblockCard(newState, player.id, target.tileId)
                }
                break
              case 'free_pass':
                msg = useFreePassCard(newState, player.id)
                break
              case 'price_hike':
                if (target?.tileId !== undefined) {
                  msg = usePriceHikeCard(newState, player.id, target.tileId)
                }
                break
            }

            if (msg) {
              newMsgs.push(msg)
              setMessages(newMsgs)
              setGame(newState)
              gameRef.current = newState
              broadcastState(newState, newMsgs)

              // 遥控骰子：延迟 500ms 后自动执行掷骰
              if (autoRoll) {
                aiTimeoutRef.current = setTimeout(() => executeHostRollRef.current(), 500)
              }
            }
          }
          break
        }

        case 'player-leave': {
          if (peer.getIsHost()) {
            peer.untrackPeer(fromPeerId)
            const leaverInfo = playersRef.current.find(p => p.id === fromPeerId)
            const updated = playersRef.current.filter(p => p.id !== fromPeerId)
            playersRef.current = updated
            setOnlinePlayers(updated)
            playPlayerLeaveSound()
            peer.broadcast({
              type: 'room-info',
              payload: {
                players: updated.map(p => ({ id: p.id, name: p.name, isHost: p.isHost })),
              }
            })
            // 如果游戏进行中，处理断线玩家的游戏状态
            if (leaverInfo) {
              handlePlayerDisconnect(leaverInfo.name, peer)
            }
          } else {
            const leaver = message.payload.name
            const isHostLeaving = playersRef.current.find(p => p.name === leaver)?.isHost
            if (isHostLeaving) {
              setConnectionError('房主已离开房间')
              // Guest 清理并返回大厅
              peerRef.current?.destroy()
              peerRef.current = null
              setScreen('setup')
              setGame(null)
              setOnlinePlayers([])
              setOnlineRole(null)
              setRoomId('')
            }
            // Guest 端也更新玩家列表（不依赖 room-info 延迟到达）
            const updated = playersRef.current.filter(p => p.name !== leaver)
            playersRef.current = updated
            setOnlinePlayers(updated)
          }
          break
        }

        case 'sync-request': {
          // Host 收到 Guest 的同步请求，广播当前游戏状态
          if (peer.getIsHost()) {
            const currentGs = gameRef.current
            const currentMsgs = messagesRef.current
            if (currentGs) {
              broadcastState(currentGs, currentMsgs)
            }
          }
          break
        }
      }
    }

    // 处理玩家断线：标记破产 + 跳过回合 + 广播状态
    const handlePlayerDisconnect = (disconnectedName: string, peer: GoEasyManager) => {
      const gs = gameRef.current
      if (!gs || gs.gameOver) return

      const playerIdx = gs.players.findIndex(p => p.name === disconnectedName)
      if (playerIdx === -1) return
      if (gs.players[playerIdx].bankrupt) return // 已破产，无需处理

      // 如果断线玩家正在购买决策中，清除购买超时
      if (buyTimeoutRef.current && gs.currentPlayer === playerIdx) {
        clearTimeout(buyTimeoutRef.current)
        buyTimeoutRef.current = null
      }

      const newState: GameState = JSON.parse(JSON.stringify(gs))
      const player = newState.players[playerIdx]
      player.bankrupt = true
      // 金钱可能已为负，先归零再变卖
      player.money = Math.max(0, player.money)
      // 变卖所有地皮
      for (const tileId of player.properties) {
        player.money += Math.floor(BOARD[tileId].price * 0.6)
      }
      player.properties = []

      const newMsgs = [...messagesRef.current]
      newMsgs.push(`💀 ${disconnectedName} 断开连接，自动破产退出`)

      // 如果断线的是当前玩家，跳过其回合
      if (newState.currentPlayer === playerIdx) {
        // 使用 nextPlayer 统一处理回合推进（含涨价卡递减、道具卡发放、回合上限）
        const logBefore = newState.log.length
        nextPlayer(newState)
        // 提取 nextPlayer 产生的日志消息
        const newLogMsgs = newState.log.slice(logBefore)
        newMsgs.push(...newLogMsgs)
      }

      setMessages(newMsgs)
      setGame(newState)
      gameRef.current = newState
      broadcastState(newState, newMsgs)

      if (newState.gameOver) setScreen('end')
    }

    const disconnectionHandler = (peerId: string) => {
      if (peer.getIsHost()) {
        peer.untrackPeer(peerId)
        const leaverInfo = playersRef.current.find(p => p.id === peerId)
        const updated = playersRef.current.filter(p => p.id !== peerId)
        playersRef.current = updated
        setOnlinePlayers(updated)
        playPlayerLeaveSound()
        peer.broadcast({
          type: 'room-info',
          payload: {
            players: updated.map(p => ({ id: p.id, name: p.name, isHost: p.isHost })),
          }
        })
        // 如果游戏进行中，处理断线玩家的游戏状态
        if (leaverInfo) {
          handlePlayerDisconnect(leaverInfo.name, peer)
        }
      } else {
        // Guest 端：检查断开的是否为房主
        const disconnectedPeer = playersRef.current.find(p => p.id === peerId)
        if (disconnectedPeer?.isHost) {
          setConnectionError('房主已断开连接')
          // Guest 清理并返回大厅
          peerRef.current?.destroy()
          peerRef.current = null
          setScreen('setup')
          setGame(null)
          setOnlinePlayers([])
          setOnlineRole(null)
          setRoomId('')
        }
      }
    }

    peer.onMessage(messageHandler)
    peer.onDisconnection(disconnectionHandler)
  }, [broadcastState])

  // ===== 创建房间 =====
  const createRoom = async () => {
    if (!playerName.trim()) {
      setConnectionError('请输入你的名字')
      return
    }
    setConnecting(true)
    setConnectionError('')

    try {
      // 先销毁旧的连接
      if (peerRef.current) {
        peerRef.current.destroy()
        peerRef.current = null
      }

      const peer = new GoEasyManager()
      await peer.initialize(playerName)
      peerRef.current = peer
      peer.setIsHost(true)
      setupPeerHandlers(peer)

      // 创建 GoEasy 频道作为房间
      const id = await peer.createRoom()
      setRoomId(id)
      setOnlineRole('host')
      setOnlinePlayers([{
        id: peer.getClientId(),
        name: playerName,
        isHost: true,
      }])
      setScreen('lobby')
    } catch (err: any) {
      setConnectionError(`创建房间失败: ${err.message || JSON.stringify(err)}`)
    } finally {
      setConnecting(false)
    }
  }

  // ===== 加入房间 =====
  const joinRoom = async () => {
    if (!playerName.trim()) {
      setConnectionError('请输入你的名字')
      return
    }
    if (!joinRoomId.trim()) {
      setConnectionError('请输入房间号')
      return
    }

    setConnecting(true)
    setConnectionError('')

    try {
      // 先销毁旧的连接
      if (peerRef.current) {
        peerRef.current.destroy()
        peerRef.current = null
      }

      const peer = new GoEasyManager()
      await peer.initialize(playerName)
      peerRef.current = peer
      peer.setIsHost(false)
      setupPeerHandlers(peer)

      roomValidatedRef.current = false
      await peer.connectToRoom(joinRoomId.trim())
      setRoomId(joinRoomId.trim())
      setOnlineRole('guest')
      setOnlinePlayers([{
        id: peer.getClientId(),
        name: playerName,
        isHost: false,
      }])
      setScreen('lobby')

      // 检测房间是否真实存在（等待房主回复 room-info）
      const joinedPeer = peer // 捕获当前实例，防止超时回调误操作新实例
      setTimeout(() => {
        // 只有当前 peer 实例没变、且仍在 lobby、且未收到 room-info 时才判定失败
        if (!roomValidatedRef.current && screenRef.current === 'lobby' && peerRef.current === joinedPeer) {
          setConnectionError('房间不存在或房主已离线')
          joinedPeer.destroy()
          peerRef.current = null
          setScreen('setup')
          setOnlineRole(null)
          setOnlinePlayers([])
        }
      }, 10000)
    } catch (err: any) {
      setConnectionError(`加入房间失败: ${err.message || '未知错误'}`)
    } finally {
      setConnecting(false)
    }
  }

  // ===== 房主开始在线游戏 =====
  const startOnlineGame = () => {
    const peer = peerRef.current
    if (!peer || !peer.getIsHost()) return
    if (gameStarting) return // 防止重复点击
    if (onlinePlayers.length < 2) {
      setConnectionError('至少需要2名玩家才能开始游戏')
      return
    }
    setGameStarting(true)

    const players: Player[] = onlinePlayers.map((p, i) => ({
      id: i,
      name: p.name,
      avatar: ['🧑', '🧑‍💻', '🧑‍🎨', '🧑‍🚀', '🎭', '🧠', '🔥', '🛡️'][i % 8],
      money: initialMoney,
      position: 0,
      properties: [],
      inJail: false,
      jailTurns: 0,
      bankrupt: false,
      isAI: false,
      color: ['#ef4444', '#3b82f6', '#10b981', '#f59e0b'][i % 4],
      cards: [],
      freePassActive: false,
    }))

    const newGame: GameState = {
      players,
      currentPlayer: 0,
      round: 1,
      maxRounds,
      dice: [1, 1],
      phase: 'roll',
      log: ['🎲 在线游戏开始！'],
      gameOver: false,
      winner: null,
      difficulty,
      roadblocks: [],
      priceHikes: [],
      lastCardRound: 0,
    }

    setGame(newGame)
    setMessages(newGame.log)
    setScreen('game')
    setBuyPrompt(null)
    setDiceResult(null)

    peer.startHeartbeat()
    broadcastState(newGame, newGame.log)
  }

  // ===== 本地/AI模式：开始游戏 =====
  const startLocalGame = () => {
    const newGame = createGame(mode as 'ai' | 'local', playerCount, initialMoney, difficulty, maxRounds)
    setGame(newGame)
    setMessages(newGame.log)
    setScreen('game')
  }

  const startGame = () => {
    if (mode === 'online') {
      startOnlineGame()
    } else {
      startLocalGame()
    }
  }

  const currentPlayer = game?.players[game.currentPlayer]
  const isCurrentPlayerHuman = mode === 'online' ? true : (currentPlayer && !currentPlayer.isAI)

  // ===== 掷骰子（房主核心逻辑，房主自己掷和代替 Guest 掷都调用此函数） =====
  const executeHostRoll = useCallback(() => {
    const gs = gameRef.current
    if (!gs || gs.phase !== 'roll') return
    const hostCurrentPlayer = gs.players[gs.currentPlayer]
    if (!hostCurrentPlayer || hostCurrentPlayer.bankrupt) return
    // 防止动画期间重复执行（网络延迟可能导致重复 action）
    if (animatingRef.current) return

    animatingRef.current = true
    setRolling(true)
    setBuyPrompt(null)

    const dice = forcedDiceRef.current || rollDice()
    forcedDiceRef.current = null  // 使用后清除
    playDiceRoll()

    const oldPos = hostCurrentPlayer.position
    const steps = dice[0] + dice[1]
    const playerIndex = gs.currentPlayer

    // 计算结果并立即广播
    const precomputedState: GameState = JSON.parse(JSON.stringify(gs))
    const turnMessages = executeTurn(precomputedState, dice)
    const precomputedMsgs = [...messagesRef.current, ...turnMessages]

    // 立即更新 ref 为预计算状态，让动画完成时 stateModified 能正确判断
    // （如果动画期间有外部事件如 Guest 购买/断线修改了 gameRef，stateModified 才为 true）
    gameRef.current = precomputedState
    messagesRef.current = precomputedMsgs

    const peer = peerRef.current
    if (peer) {
      peer.broadcast({
        type: 'dice-rolled',
        payload: {
          dice: [dice[0], dice[1]],
          playerIndex,
          fromTile: oldPos,
          game: slimGame(precomputedState),
          messages: trimMessages(precomputedMsgs),
        },
      })
    }

    rendererRef.current?.playDiceAnimation(dice, () => {
      playDiceLand()
      setDiceResult(dice[0] + dice[1])

      rendererRef.current?.playMoveAnimation(
        hostCurrentPlayer.id, oldPos, steps, hostCurrentPlayer.color, hostCurrentPlayer.avatar,
        () => {
          for (const msg of turnMessages) {
            if (msg.includes('购买')) playBuySound()
            else if (msg.includes('支付') || msg.includes('缴纳')) playPaySound()
            else if (msg.includes('破产')) playBankruptSound()
          }

          // 检查状态是否已被其他事件修改（Guest 购买/断连等）
          // gameRef 在预计算后已指向 precomputedState，若被外部覆盖则引用不同
          const stateModified = gameRef.current !== precomputedState

          if (!stateModified) {
            setMessages(precomputedMsgs)
            setGame(precomputedState)
          } else {
            // 外部已修改状态，使用最新的 gameRef
            setGame(gameRef.current!)
            setMessages(messagesRef.current)
          }
          animatingRef.current = false

          // 非购买场景：广播 game-state 确保 Guest 状态同步
          // （dice-rolled 只在动画前发送，Guest 动画回调中可能因 ref 覆盖丢失状态）
          if (!stateModified && precomputedState.phase !== 'action') {
            broadcastState(precomputedState, precomputedMsgs)
          }

          // 只有状态未被外部修改时才设置购买提示/超时
          if (!stateModified && precomputedState.phase === 'action') {
            const updatedPlayer = precomputedState.players[precomputedState.currentPlayer]
            if (updatedPlayer && updatedPlayer.name === myNameRef.current) {
              setBuyPrompt({ tile: BOARD[updatedPlayer.position] })
            } else if (updatedPlayer && !updatedPlayer.bankrupt) {
              if (buyTimeoutRef.current) clearTimeout(buyTimeoutRef.current)
              // 保存超时设置时的玩家索引与阶段，防止其他消息修改后误跳
              const expectedPlayer = precomputedState.currentPlayer
              buyTimeoutRef.current = setTimeout(() => {
                const latestGs = gameRef.current
                if (
                  latestGs &&
                  latestGs.currentPlayer === expectedPlayer &&
                  latestGs.phase === 'action'
                ) {
                  const skipState: GameState = JSON.parse(JSON.stringify(latestGs))
                  const skipPlayer = skipState.players[skipState.currentPlayer]
                  const skipTile = BOARD[skipPlayer.position]
                  const skipMsgs = [...messagesRef.current, `❌ ${skipPlayer.name} 放弃购买 ${skipTile.name}`]
                  const finalMsgs = finalizeTurn(skipState)
                  skipMsgs.push(...finalMsgs)
                  setMessages(skipMsgs)
                  setGame(skipState)
                  gameRef.current = skipState
                  broadcastState(skipState, skipMsgs)
                  if (skipState.gameOver) setScreen('end')
                }
                buyTimeoutRef.current = null
              }, 20000)
            }
          }

          if (precomputedState.gameOver) setScreen('end')
          setRolling(false)
        },
        () => playStepSound()
      )
    })
  }, [broadcastState])

  const executeHostRollRef = useRef(executeHostRoll)
  useEffect(() => { executeHostRollRef.current = executeHostRoll }, [executeHostRoll])

  // ===== 掷骰子（UI 入口） =====
  const handleRoll = useCallback(() => {
    if (!game || rolling || paused || !currentPlayer || currentPlayer.bankrupt) return
    if (game.phase !== 'roll') return
    if (mode !== 'online' && currentPlayer.isAI) return

    // Online mode: only allow rolling on my turn
    if (mode === 'online' && !isMyTurn) return

    // Online guest: send action to host
    if (mode === 'online' && onlineRole === 'guest') {
      setRolling(true)
      setBuyPrompt(null)
      const peer = peerRef.current
      if (peer) {
        peer.sendToPeer(roomId, {
          type: 'player-action',
          payload: { type: 'roll', playerName },
          from: peer.getClientId(),
          timestamp: Date.now(),
        })
      }
      // 超时8秒后自动重置（兜底，防止卡死）
      if (guestRollTimeoutRef.current) clearTimeout(guestRollTimeoutRef.current)
      guestRollTimeoutRef.current = setTimeout(() => {
        if (!animatingRef.current) setRolling(false)
      }, 8000)
      return
    }

    // Online host: use executeHostRoll (reads from gameRef for freshness)
    if (mode === 'online' && onlineRole === 'host') {
      executeHostRollRef.current()
      return
    }

    // Local/AI mode: execute locally
    setRolling(true)
    setBuyPrompt(null)
    const dice = forcedDiceRef.current || rollDice()
    forcedDiceRef.current = null  // 使用后清除
    playDiceRoll()

    const oldPos = currentPlayer.position
    const steps = dice[0] + dice[1]

    rendererRef.current?.playDiceAnimation(dice, () => {
      playDiceLand()
      setDiceResult(dice[0] + dice[1])

      rendererRef.current?.playMoveAnimation(
        currentPlayer.id, oldPos, steps, currentPlayer.color, currentPlayer.avatar,
        () => {
          const newState: GameState = JSON.parse(JSON.stringify(gameRef.current!))
          const turnMessages = executeTurn(newState, dice)
          const newMsgs = [...messagesRef.current, ...turnMessages]

          for (const msg of turnMessages) {
            if (msg.includes('购买')) playBuySound()
            else if (msg.includes('支付') || msg.includes('缴纳')) playPaySound()
            else if (msg.includes('破产')) playBankruptSound()
          }

          // 事件动画触发
          const renderer = rendererRef.current
          const currentAfterTurn = newState.players[newState.currentPlayer]
          if (renderer && currentAfterTurn) {
            const tileIdx = currentAfterTurn.position
            for (const msg of turnMessages) {
              const rentMatch = msg.match(/向\s*(\S+)\s*支付租金\s*¥(\d+)/)
              if (rentMatch) {
                const ownerName = rentMatch[1]
                const amount = parseInt(rentMatch[2])
                const ownerPlayer = newState.players.find(p => p.name === ownerName)
                if (ownerPlayer) renderer.playRentAnimation(tileIdx, ownerPlayer.position, amount)
              }
              if (msg.includes('破产了')) {
                renderer.playBankruptAnimation(tileIdx, currentAfterTurn.color)
              }
              const taxMatch = msg.match(/缴纳.*¥(\d+)/)
              if (taxMatch && !msg.includes('保释金')) {
                renderer.showFloatingText(tileIdx, `-¥${taxMatch[1]}`, '#ef4444')
              }

              // NPC 入场动画
              if (msg.includes('获得') || msg.includes('中彩票') || msg.includes('股票大涨') || msg.includes('年终奖') || msg.includes('红包雨')) {
                renderer.spawnNPC('god_wealth', tileIdx)
              } else if (msg.includes('缴纳个人所得税') || msg.includes('缴纳房产税')) {
                renderer.spawnNPC('god_poverty', tileIdx)
              } else if (msg.includes('被送进监狱')) {
                renderer.spawnNPC('police', 7)
              } else if (msg.includes('生病') || msg.includes('罚款') || msg.includes('手机丢了')) {
                renderer.spawnNPC('dog', tileIdx)
              }
            }
          }

          setMessages(newMsgs)
          setGame(newState)
          gameRef.current = newState

          const updatedPlayer = newState.players[newState.currentPlayer]
          if (newState.phase === 'action') {
            if (!updatedPlayer.isAI) {
              setBuyPrompt({ tile: BOARD[updatedPlayer.position] })
            } else {
              setTimeout(() => processAITurns(newState, turnMessages), 600)
            }
          } else {
            setTimeout(() => processAITurns(newState, turnMessages), 600)
          }

          if (newState.gameOver) setScreen('end')
          setRolling(false)
        },
        () => playStepSound()
      )
    })
  }, [game, rolling, paused, currentPlayer, mode, onlineRole, roomId, playerName, isMyTurn])

  const handleLocalRollRef = useRef(handleRoll)
  useEffect(() => { handleLocalRollRef.current = handleRoll }, [handleRoll])

  // ===== 购买/跳过 =====
  const handleBuy = useCallback((buy: boolean) => {
    // 防双击：如果购买弹窗已关闭，直接忽略（用 ref 避免闭包陷阱）
    if (!buyPromptRef.current) return
    const latestGame = gameRef.current
    if (!latestGame) return
    const buyingPlayer = latestGame.players[latestGame.currentPlayer]
    if (!buyingPlayer) return

    // 清除购买超时
    if (buyTimeoutRef.current) {
      clearTimeout(buyTimeoutRef.current)
      buyTimeoutRef.current = null
    }

    // Online guest: send action to host
    if (mode === 'online' && onlineRole === 'guest') {
      const peer = peerRef.current
      if (peer) {
        peer.sendToPeer(roomId, {
          type: 'player-action',
          payload: { type: 'buy', buy, playerName },
          from: peer.getClientId(),
          timestamp: Date.now(),
        })
      }
      setBuyPrompt(null)
      return
    }

    const newState: GameState = JSON.parse(JSON.stringify(latestGame))
    const player = newState.players[newState.currentPlayer]
    const tile = BOARD[player.position]
    const newMsgs = [...messagesRef.current]

    if (buy) {
      if (buyProperty(player, tile.id)) {
        newMsgs.push(`🏠 ${player.name} 购买了 ${tile.name}`)
        playBuySound()
        // 买地建筑升起动画
        rendererRef.current?.playBuildAnimation(player.position, player.color)
      } else {
        newMsgs.push(`❌ ${player.name} 资金不足，无法购买 ${tile.name}（需要 ¥${tile.price}）`)
      }
    } else {
      newMsgs.push(`❌ ${player.name} 放弃购买 ${tile.name}`)
    }

    const finalMsgs = finalizeTurn(newState)
    for (const msg of finalMsgs) {
      if (msg.includes('破产')) playBankruptSound()
    }
    newMsgs.push(...finalMsgs)

    setBuyPrompt(null)
    setMessages(newMsgs)
    setGame(newState)
    gameRef.current = newState

    if (newState.gameOver) {
      setScreen('end')
    }

    // Online host: broadcast state
    if (mode === 'online' && onlineRole === 'host') {
      broadcastState(newState, newMsgs)
    } else if (!newState.gameOver) {
      setTimeout(() => processAITurns(newState, newMsgs), 400)
    }
  }, [mode, onlineRole, roomId, playerName, broadcastState])

  // ===== 棋盘点击：显示地皮信息 =====
  const handleCanvasClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const renderer = rendererRef.current
    if (!renderer || !game) return

    const tileIdx = renderer.hitTest(e.clientX, e.clientY)
    if (tileIdx < 0) {
      setTileInfo(null)
      return
    }

    // 已选中同一格则关闭
    if (tileInfo?.tileIndex === tileIdx) {
      setTileInfo(null)
      return
    }

    // 获取格子的屏幕坐标，用于弹窗定位
    const center = renderer.getTileScreenCenter(tileIdx)
    if (center) {
      setTileInfo({ tileIndex: tileIdx, x: center.x, y: center.y })
    }
  }, [game, tileInfo])

  // ===== 道具卡使用 =====
  const handleUseCard = useCallback((card: GameCard, target?: { playerIdx?: number; tileId?: number; diceTotal?: number }) => {
    const latestGame = gameRef.current
    if (!latestGame || latestGame.phase !== 'roll') return
    // 在线模式下只能在自己的回合使用
    if (mode === 'online') {
      const myIdx = latestGame.players.findIndex(p => p.name === playerName)
      if (myIdx < 0 || myIdx !== latestGame.currentPlayer) return
    }
    const currentPlayerObj = latestGame.players[latestGame.currentPlayer]
    if (!currentPlayerObj || currentPlayerObj.bankrupt) return

    // Online guest: send card action to host
    if (mode === 'online' && onlineRole === 'guest') {
      const peer = peerRef.current
      if (peer) {
        peer.sendToPeer(roomId, {
          type: 'card-action',
          payload: { cardType: card.type, cardId: card.id, playerName, target },
          from: peer.getClientId(),
          timestamp: Date.now(),
        })
      }
      setSelectedCard(null)
      setShowCardPanel(false)
      return
    }

    const newState: GameState = JSON.parse(JSON.stringify(latestGame))
    const player = newState.players[newState.currentPlayer]
    const newMsgs = [...messagesRef.current]
    let msg = ''
    let autoRoll = false

    switch (card.type) {
      case 'remote_dice':
        if (target?.diceTotal) {
          if (forcedDiceRef.current) return // 防止竞态：已有待处理的强制骰子
          const [d1, d2] = useRemoteDice(target.diceTotal)
          msg = `🎯 ${player.name} 使用遥控骰子，指定点数 ${d1}+${d2}=${d1+d2}`
          const cardIdx = player.cards.findIndex(c => c.id === card.id)
          if (cardIdx >= 0) player.cards.splice(cardIdx, 1)
          // 设置强制骰子，后续掷骰时使用此值
          forcedDiceRef.current = [d1, d2]
          autoRoll = true
        }
        break
      case 'swap':
        if (target?.playerIdx !== undefined) {
          const targetPlayer = newState.players.find(p => p.id === target.playerIdx)
          if (targetPlayer) msg = useSwapCard(newState, player.id, targetPlayer.id)
        }
        break
      case 'roadblock':
        if (target?.tileId !== undefined) {
          msg = useRoadblockCard(newState, player.id, target.tileId)
        }
        break
      case 'free_pass':
        msg = useFreePassCard(newState, player.id)
        break
      case 'price_hike':
        if (target?.tileId !== undefined) {
          msg = usePriceHikeCard(newState, player.id, target.tileId)
        }
        break
    }

    if (msg) {
      newMsgs.push(msg)
      setMessages(newMsgs)
      setGame(newState)
      gameRef.current = newState

      // 卡片释放全屏特效
      const renderer = rendererRef.current
      if (renderer) {
        switch (card.type) {
          case 'remote_dice':
            renderer.playCardEffect('remote_dice')
            break
          case 'swap': {
            const targetP = newState.players.find(p => p.id === target?.playerIdx)
            if (targetP) {
              renderer.playCardEffect('swap', player.position, targetP.position)
            }
            break
          }
          case 'roadblock':
            if (target?.tileId !== undefined) {
              renderer.playCardEffect('roadblock', target.tileId)
            }
            break
          case 'free_pass':
            renderer.playCardEffect('free_pass', player.position)
            break
          case 'price_hike':
            if (target?.tileId !== undefined) {
              renderer.playCardEffect('price_hike', target.tileId)
            }
            break
        }
      }

      if (mode === 'online' && onlineRole === 'host') {
        broadcastState(newState, newMsgs)
      }
    }

    setSelectedCard(null)
    setShowCardPanel(false)

    // 遥控骰子：延迟后自动执行掷骰
    if (autoRoll) {
      const delay = mode === 'online' ? 500 : 300
      aiTimeoutRef.current = setTimeout(() => {
        if (mode === 'online' && onlineRole === 'host') {
          executeHostRollRef.current()
        } else {
          // 本地/AI模式：直接执行掷骰（使用 forcedDiceRef）
          handleLocalRollRef.current()
        }
      }, delay)
    }
  }, [mode, onlineRole, roomId, playerName, broadcastState])

  // ===== AI 回合处理（仅本地/AI模式） =====
  const processAITurnsRef = useRef<(gs: GameState, msgs: string[]) => void>(() => {})
  const processAITurns = useCallback((gs: GameState, msgs: string[]) => {
    if (gs.gameOver) {
      setScreen('end')
      return
    }

    const current = gs.players[gs.currentPlayer]
    if (!current.isAI) return

    setMessages(prev => [...prev, `⏳ ${current.name} 思考中...`])

    aiTimeoutRef.current = setTimeout(() => {
      // 先检查 AI 是否使用遥控骰子，确保动画显示正确的数字
      const { forcedDice } = aiUseCardDecision(gs)
      const dice = forcedDice ?? rollDice()
      playDiceRoll()

      rendererRef.current?.playDiceAnimation(dice, () => {
        playDiceLand()

        const oldPos = current.position
        const steps = dice[0] + dice[1]

        rendererRef.current?.playMoveAnimation(
          current.id, oldPos, steps, current.color, current.avatar,
          () => {
            // 深拷贝状态，避免直接修改 React state
            const gsCopy: GameState = JSON.parse(JSON.stringify(gs))
            const turnMessages = executeTurn(gsCopy, dice)

            for (const msg of turnMessages) {
              if (msg.includes('购买')) playBuySound()
              else if (msg.includes('支付') || msg.includes('缴纳')) playPaySound()
              else if (msg.includes('破产')) playBankruptSound()
            }

            // AI 回合 NPC 入场动画
            const aiRenderer = rendererRef.current
            const aiPlayer = gsCopy.players[gsCopy.currentPlayer]
            if (aiRenderer && aiPlayer) {
              const aiTileIdx = aiPlayer.position
              for (const msg of turnMessages) {
                if (msg.includes('获得') || msg.includes('中彩票') || msg.includes('股票大涨') || msg.includes('年终奖') || msg.includes('红包雨')) {
                  aiRenderer.spawnNPC('god_wealth', aiTileIdx)
                } else if (msg.includes('缴纳个人所得税') || msg.includes('缴纳房产税')) {
                  aiRenderer.spawnNPC('god_poverty', aiTileIdx)
                } else if (msg.includes('被送进监狱')) {
                  aiRenderer.spawnNPC('police', 7)
                } else if (msg.includes('生病') || msg.includes('罚款') || msg.includes('手机丢了')) {
                  aiRenderer.spawnNPC('dog', aiTileIdx)
                }
              }
            }

            const allMsgs = [...msgs, ...turnMessages]
            setMessages(prev => [...prev, ...turnMessages])
            setGame(gsCopy)
            gameRef.current = gsCopy

            if (gsCopy.gameOver) {
              setScreen('end')
            } else {
              aiTimeoutRef.current = setTimeout(() => processAITurnsRef.current(gsCopy, allMsgs), 800)
            }
          },
          () => playStepSound()
        )
      })
    }, 600)
  }, [])
  useEffect(() => { processAITurnsRef.current = processAITurns }, [processAITurns])

  // ===== 重新开始 =====
  const restartGame = () => {
    if (buyTimeoutRef.current) { clearTimeout(buyTimeoutRef.current); buyTimeoutRef.current = null }
    if (aiTimeoutRef.current) { clearTimeout(aiTimeoutRef.current); aiTimeoutRef.current = null }
    if (guestRollTimeoutRef.current) { clearTimeout(guestRollTimeoutRef.current); guestRollTimeoutRef.current = null }
    animatingRef.current = false
    pendingDiceRolledRef.current = []
    forcedDiceRef.current = null
    setGameStarting(false)
    setScreen('setup')
    setGame(null)
    setMessages([])
    setDiceResult(null)
    setBuyPrompt(null)
    setPaused(false)
    setSelectedCard(null)
    setShowCardPanel(false)
  }
  const leaveRoom = () => {
    if (buyTimeoutRef.current) {
      clearTimeout(buyTimeoutRef.current)
      buyTimeoutRef.current = null
    }
    if (aiTimeoutRef.current) { clearTimeout(aiTimeoutRef.current); aiTimeoutRef.current = null }
    if (guestRollTimeoutRef.current) { clearTimeout(guestRollTimeoutRef.current); guestRollTimeoutRef.current = null }
    animatingRef.current = false
    pendingDiceRolledRef.current = []
    forcedDiceRef.current = null
    setGameStarting(false)
    const peerToDestroy = peerRef.current
    if (peerToDestroy) {
      peerToDestroy.broadcast({
        type: 'player-leave',
        payload: { name: myNameRef.current },
      })
      peerRef.current = null
      // 延迟销毁，确保 player-leave 消息发出
      setTimeout(() => peerToDestroy.destroy(), 500)
    }
    setOnlineRole(null)
    setRoomId('')
    setJoinRoomId('')
    setOnlinePlayers([])
    playersRef.current = []
    setConnectionError('')
    setScreen('menu')
    setGame(null)
    setMessages([])
    setBuyPrompt(null)
    setDiceResult(null)
    setRolling(false)
    setIsMyTurn(false)
    setSelectedCard(null)
    setShowCardPanel(false)
  }

  return (
    <div className="flex flex-col md:flex-row bg-[#0f1419] overflow-hidden" style={{ height: '100dvh' }}>
      {/* 控制栏 */}
      {screen === 'game' && (
        <div className="absolute top-3 left-3 z-10 flex gap-2">
          {mode !== 'online' && (
            <button onClick={() => setPaused(!paused)}
              className="w-10 h-10 rounded-full bg-white/10 backdrop-blur-sm border border-white/20 text-white text-lg hover:bg-white/20 transition-colors">
              {paused ? '▶️' : '⏸️'}
            </button>
          )}
          <button onClick={mode === 'online' ? leaveRoom : restartGame}
            className="w-10 h-10 rounded-full bg-white/10 backdrop-blur-sm border border-white/20 text-white text-lg hover:bg-white/20 transition-colors">
            🔄
          </button>
          <button onClick={() => setMutedState(!muted)}
            className="w-10 h-10 rounded-full bg-white/10 backdrop-blur-sm border border-white/20 text-white text-lg hover:bg-white/20 transition-colors">
            {muted ? '🔇' : '🔊'}
          </button>
        </div>
      )}

      {/* 棋盘区域 */}
      <div className="flex-1 relative flex items-center justify-center p-2 touch-none" style={{ minHeight: 'min(50dvh, 400px)' }}>
        <canvas ref={canvasRef} className="touch-none cursor-pointer"
          onClick={handleCanvasClick}
          onTouchEnd={(e) => {
            e.preventDefault() // 阻止浏览器合成 click 事件，避免双击
            if (e.changedTouches.length === 1) {
              const t = e.changedTouches[0]
              const renderer = rendererRef.current
              if (!renderer || !game) return
              const tileIdx = renderer.hitTest(t.clientX, t.clientY)
              if (tileIdx < 0) { setTileInfo(null); return }
              if (tileInfo?.tileIndex === tileIdx) { setTileInfo(null); return }
              const center = renderer.getTileScreenCenter(tileIdx)
              if (center) setTileInfo({ tileIndex: tileIdx, x: center.x, y: center.y })
            }
          }}
        />

        {/* 地皮信息弹窗 */}
        {tileInfo && game && (() => {
          const tile = BOARD[tileInfo.tileIndex]
          if (!tile) return null

          // 查找拥有者
          const owner = game.players.find(p => p.properties.includes(tile.id))

          // 查找涨价状态
          const hike = game.priceHikes?.find(h => h.tileId === tile.id)

          // 查找路障及放置者
          const roadblock = game.roadblocks?.find(r => r.tileId === tile.id)
          const roadblockOwner = roadblock ? game.players.find(p => p.id === roadblock.ownerPlayerId) : null

          // 计算弹窗位置：基于canvas容器
          const boardArea = document.querySelector('.flex-1.relative.flex') as HTMLElement
          const rect = boardArea?.getBoundingClientRect()
          if (!rect) return null

          const relX = tileInfo.x - rect.left
          const relY = tileInfo.y - rect.top
          // 弹窗偏移，避免遮挡格子
          const popX = relX > rect.width / 2 ? relX - 220 : relX + 20
          const popY = Math.max(8, Math.min(relY - 60, rect.height - 240))

          // 类型描述
          const typeDesc: Record<string, string> = {
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

          return (
            <div
              className="absolute z-30 pointer-events-auto bounce-in"
              style={{ left: popX, top: popY, width: 200 }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="bg-[#1a1f2e]/95 backdrop-blur-md border border-white/15 rounded-xl p-3 shadow-2xl shadow-black/50">
                {/* 头部 */}
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-1.5">
                    <span className="text-xl">{tile.emoji}</span>
                    <span className="text-gray-100 font-bold text-sm">{tile.name}</span>
                  </div>
                  <button onClick={() => setTileInfo(null)}
                    className="w-5 h-5 rounded-full bg-white/10 text-gray-400 text-xs flex items-center justify-center hover:bg-white/20 transition-colors">
                    ✕
                  </button>
                </div>

                {/* 类型标签 */}
                <div className="flex items-center gap-1.5 mb-2.5">
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/10 text-gray-400">
                    {typeDesc[tile.type] || tile.type}
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
                    <span className="text-[10px] text-gray-500">暂无拥有者</span>
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
                      <span className="text-gray-500">价格</span>
                      <span className="text-amber-400 font-bold">¥{tile.price}</span>
                    </div>
                    {tile.rent.length > 0 && (
                      <>
                        <div className="flex justify-between">
                          <span className="text-gray-500">基础租金</span>
                          <span className="text-gray-300">¥{tile.rent[0]}</span>
                        </div>
                        {tile.rent[1] && (
                          <div className="flex justify-between">
                            <span className="text-gray-500">同色加成</span>
                            <span className="text-blue-400">¥{tile.rent[1]}</span>
                          </div>
                        )}
                        {tile.rent[2] && (
                          <div className="flex justify-between">
                            <span className="text-gray-500">全套租金</span>
                            <span className="text-purple-400 font-medium">¥{tile.rent[2]}</span>
                          </div>
                        )}
                        {hike && owner && (
                          <div className="flex justify-between">
                            <span className="text-gray-500">涨价后</span>
                            <span className="text-red-400 font-bold">¥{tile.rent[0] * 2}</span>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                )}

                {/* 特殊格子描述 */}
                {tile.type === 'chance' && (
                  <div className="text-[10px] text-gray-500 mt-2">
                    停留时随机触发事件：获得/失去金钱、移动等
                  </div>
                )}
                {tile.type === 'tax' && (
                  <div className="text-[10px] text-gray-500 mt-2 space-y-0.5">
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
                  <div className="text-[10px] text-gray-500 mt-2">
                    踩到此格直接送入监狱，无法经过起点领薪
                  </div>
                )}
                {tile.type === 'start' && (
                  <div className="text-[10px] text-gray-500 mt-2">
                    经过或停留起点时获得 ¥{getStartBonus(game.round)} 工资
                  </div>
                )}
                {tile.type === 'parking' && (
                  <div className="text-[10px] text-gray-500 mt-2">
                    安全区域，不会发生任何事件
                  </div>
                )}
              </div>
            </div>
          )
        })()}

        {/* 主菜单 */}
        {screen === 'menu' && (
          <div className="absolute inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-20 overflow-hidden">
            {/* 飘落粒子背景 */}
            {['🎲','💰','🏠','🃏','⭐','🎯','💎','🏆','🎲','💰','⭐','🃏'].map((emoji, i) => (
              <span key={i} className="menu-particle"
                style={{
                  left: `${8 + (i * 7.5) % 85}%`,
                  animationDuration: `${8 + (i % 5) * 2}s`,
                  animationDelay: `${(i * 0.8) % 6}s`,
                  opacity: 0.5,
                }}
              >{emoji}</span>
            ))}

            {/* 底部城市剪影 */}
            <div className="skyline absolute bottom-0 left-0 right-0 h-20 opacity-20"
              style={{
                background: 'linear-gradient(to top, #f97316 0%, transparent 100%)',
                clipPath: 'polygon(0% 100%, 0% 80%, 3% 60%, 6% 80%, 10% 40%, 13% 60%, 16% 80%, 20% 30%, 23% 50%, 26% 70%, 30% 20%, 33% 50%, 36% 80%, 40% 50%, 43% 30%, 46% 60%, 50% 10%, 53% 40%, 56% 70%, 60% 40%, 63% 20%, 66% 50%, 70% 70%, 73% 30%, 76% 60%, 80% 40%, 83% 70%, 86% 50%, 90% 80%, 93% 60%, 96% 40%, 100% 70%, 100% 100%)',
              }}
            />

            <div className="text-center fade-in relative z-10">
              <h1 className="text-5xl font-black text-transparent bg-clip-text bg-gradient-to-r from-yellow-400 via-orange-400 to-red-400 mb-3 glow-title">
                大富翁
              </h1>
              <p className="text-xl text-orange-300 mb-10 font-medium">中国行 · 在线版</p>
              <button
                onClick={() => setScreen('setup')}
                className="btn-sweep px-10 py-4 bg-gradient-to-r from-orange-500 to-red-500 rounded-full text-white font-bold text-lg hover:from-orange-400 hover:to-red-400 transition-all shadow-lg shadow-orange-500/30 hover:scale-105"
              >
                开始游戏
              </button>
              <p className="text-gray-500 text-sm mt-6">掷骰子 · 买地皮 · 收租金 · 在线对战</p>
            </div>
          </div>
        )}

        {/* 模式选择 */}
        {screen === 'setup' && (
          <div className="absolute inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-20">
            <div className="bg-[#1a2332] rounded-2xl p-8 max-w-md w-full mx-4 fade-in border border-white/10 max-h-[90vh] overflow-y-auto">
              <h2 className="text-2xl font-bold text-white mb-6 text-center">游戏设置</h2>

              {/* 玩家名输入 */}
              <div className="mb-6">
                <label className="text-gray-400 text-sm mb-2 block">你的名字</label>
                <input
                  type="text"
                  value={playerName}
                  onChange={e => setPlayerName(e.target.value.slice(0, 12))}
                  className="w-full bg-white/5 border border-white/10 rounded-lg px-4 py-2.5 text-white focus:outline-none focus:border-orange-500/50 transition-colors"
                  placeholder="输入你的名字"
                />
              </div>

              <div className="mb-6">
                <label className="text-gray-400 text-sm mb-2 block">游戏模式</label>
                <div className="grid grid-cols-3 gap-2">
                  <button onClick={() => { setMode('local'); setPlayerCount(2) }}
                    className={`py-3 rounded-xl font-medium transition-all text-sm ${mode === 'local' ? 'bg-orange-500/20 border-orange-500 text-orange-300 border' : 'bg-white/5 border border-white/10 text-gray-400'}`}>
                    👥 本地
                  </button>
                  <button onClick={() => { setMode('ai'); setPlayerCount(2) }}
                    className={`py-3 rounded-xl font-medium transition-all text-sm ${mode === 'ai' ? 'bg-orange-500/20 border-orange-500 text-orange-300 border' : 'bg-white/5 border border-white/10 text-gray-400'}`}>
                    🤖 AI
                  </button>
                  <button onClick={() => setMode('online')}
                    className={`py-3 rounded-xl font-medium transition-all text-sm ${mode === 'online' ? 'bg-orange-500/20 border-orange-500 text-orange-300 border' : 'bg-white/5 border border-white/10 text-gray-400'}`}>
                    🌐 在线
                  </button>
                </div>
              </div>

              {mode !== 'online' && (
                <>
                  <div className="mb-6">
                    <label className="text-gray-400 text-sm mb-2 block">
                      {mode === 'ai' ? 'AI对手数量' : '玩家人数'}
                    </label>
                    <div className="flex gap-3">
                      {(mode === 'ai' ? [1, 2, 3] : [2, 3, 4]).map(n => (
                        <button key={n} onClick={() => setPlayerCount(n)}
                          className={`flex-1 py-3 rounded-xl font-medium transition-all ${playerCount === n ? 'bg-orange-500/20 border-orange-500 text-orange-300 border' : 'bg-white/5 border border-white/10 text-gray-400'}`}>
                          {n}人
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="mb-6">
                    <label className="text-gray-400 text-sm mb-2 block">初始资金</label>
                    <div className="grid grid-cols-4 gap-2">
                      {[800, 1000, 1500, 2000, 3000, 5000, 8000, 10000].map(n => (
                        <button key={n} onClick={() => setInitialMoney(n)}
                          className={`py-2.5 rounded-xl text-sm font-medium transition-all ${initialMoney === n ? 'bg-orange-500/20 border-orange-500 text-orange-300 border' : 'bg-white/5 border border-white/10 text-gray-400 hover:border-white/20'}`}>
                          {n >= 10000 ? `${n / 10000}万` : `¥${n}`}
                        </button>
                      ))}
                    </div>
                    <div className="mt-2 text-center">
                      <input
                        type="number"
                        value={initialMoney}
                        onChange={e => { const v = parseInt(e.target.value); if (v > 0) setInitialMoney(v) }}
                        className="w-32 bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-center text-orange-300 font-bold text-sm focus:outline-none focus:border-orange-500/50 transition-colors"
                        min={100}
                        step={100}
                      />
                      <span className="text-gray-500 text-xs ml-1">自定义</span>
                    </div>
                  </div>

                  <div className="mb-6">
                    <label className="text-gray-400 text-sm mb-2 block">游戏时长</label>
                    <div className="grid grid-cols-5 gap-2">
                      {[
                        { value: 0, label: '♾️ 无限', desc: '淘汰制' },
                        { value: 20, label: '20回合', desc: '快速' },
                        { value: 30, label: '30回合', desc: '标准' },
                        { value: 50, label: '50回合', desc: '长局' },
                        { value: 100, label: '100回合', desc: '史诗' },
                      ].map(r => (
                        <button key={r.value} onClick={() => setMaxRounds(r.value)}
                          className={`py-2.5 rounded-xl text-center transition-all ${maxRounds === r.value ? 'bg-orange-500/20 border-orange-500 text-orange-300 border' : 'bg-white/5 border border-white/10 text-gray-400 hover:border-white/20'}`}>
                          <div className="text-sm font-medium">{r.label}</div>
                          <div className="text-[10px] mt-0.5 opacity-70">{r.desc}</div>
                        </button>
                      ))}
                    </div>
                    <div className="text-[10px] text-gray-500 mt-2 text-center">
                      {maxRounds === 0 ? '淘汰制：只剩1人存活时结束' : `最多${maxRounds}回合，到期按总资产判定胜负`}
                    </div>
                  </div>

                  <div className="mb-8">
                    <label className="text-gray-400 text-sm mb-2 block">游戏难度</label>
                    <div className="grid grid-cols-3 gap-3">
                      {[
                        { key: 'easy' as const, label: '🌱 简单', desc: 'AI较弱' },
                        { key: 'normal' as const, label: '⚖️ 普通', desc: '平衡' },
                        { key: 'hard' as const, label: '🔥 困难', desc: 'AI强势' },
                      ].map(d => (
                        <button key={d.key} onClick={() => setDifficulty(d.key)}
                          className={`py-3 px-2 rounded-xl text-center transition-all ${difficulty === d.key ? 'bg-orange-500/20 border-orange-500 text-orange-300 border' : 'bg-white/5 border border-white/10 text-gray-400 hover:border-white/20'}`}>
                          <div className="font-medium">{d.label}</div>
                          <div className="text-[10px] mt-1 opacity-70">{d.desc}</div>
                        </button>
                      ))}
                    </div>
                  </div>
                </>
              )}

              {mode === 'online' && (
                <div className="mb-8 space-y-3">
                  <div className="text-sm text-gray-400">
                    在线模式使用 GoEasy 实时通信，房主创建房间后分享房间号给朋友。
                  </div>
                  <div className="text-xs text-amber-400/80 bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2 text-center">
                    在线对战最多支持 4 名玩家
                  </div>
                  <button onClick={createRoom}
                    disabled={connecting || !playerName.trim()}
                    className="w-full py-3.5 rounded-xl font-bold transition-all bg-green-600/20 border border-green-500 text-green-300 hover:bg-green-600/30 disabled:opacity-50">
                    {connecting ? '连接中...' : '🏠 创建房间'}
                  </button>
                  <div className="flex items-center gap-2">
                    <div className="flex-1 h-px bg-white/10" />
                    <span className="text-gray-500 text-xs">或</span>
                    <div className="flex-1 h-px bg-white/10" />
                  </div>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={joinRoomId}
                      onChange={e => setJoinRoomId(e.target.value)}
                      className="flex-1 bg-white/5 border border-white/10 rounded-lg px-3 py-2.5 text-white text-sm font-mono focus:outline-none focus:border-blue-500/50 transition-colors"
                      placeholder="输入房间号"
                    />
                    <button onClick={joinRoom}
                      disabled={connecting || !joinRoomId.trim() || !playerName.trim()}
                      className="px-5 py-2.5 rounded-xl font-bold transition-all bg-blue-600/20 border border-blue-500 text-blue-300 hover:bg-blue-600/30 disabled:opacity-50">
                      加入
                    </button>
                  </div>
                  {connectionError && (
                    <div className="text-center text-red-400 text-sm">{connectionError}</div>
                  )}
                </div>
              )}

              <div className="flex gap-3">
                <button onClick={() => { setScreen('menu'); setConnectionError('') }}
                  className="flex-1 py-3 rounded-xl border border-white/10 text-gray-400 hover:border-white/20 transition-colors">
                  返回
                </button>
                {mode !== 'online' && (
                  <button onClick={startGame}
                    className="flex-[2] py-3 bg-gradient-to-r from-orange-500 to-red-500 rounded-xl text-white font-bold hover:from-orange-400 hover:to-red-400 transition-all">
                    开始！
                  </button>
                )}
              </div>
            </div>
          </div>
        )}

        {/* 在线大厅 */}
        {screen === 'lobby' && (
          <div className="absolute inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-20">
            <div className="bg-[#1a2332] rounded-2xl p-8 max-w-md w-full mx-4 fade-in border border-white/10">
              <h2 className="text-2xl font-bold text-white mb-6 text-center">🏠 等待玩家加入</h2>

              <div className="mb-6">
                <label className="text-gray-400 text-sm mb-2 block">房间号（分享给朋友）</label>
                <div className="bg-white/5 border border-white/10 rounded-lg px-4 py-3 text-center">
                  <div className="text-lg font-mono text-orange-400 font-bold break-all select-all cursor-pointer"
                    onClick={() => {
                      navigator.clipboard.writeText(roomId).catch(() => {})
                      setCopied(true)
                      setTimeout(() => setCopied(false), 1500)
                    }}>
                    {roomId}
                  </div>
                  <button
                    onClick={() => {
                      navigator.clipboard.writeText(roomId).catch(() => {})
                      setCopied(true)
                      setTimeout(() => setCopied(false), 1500)
                    }}
                    className={`mt-2 text-xs transition-all duration-300 ${copied ? 'text-green-400 scale-110' : 'text-blue-400 hover:text-blue-300'}`}
                  >
                    {copied ? '✅ 已复制' : '📋 点击复制'}
                  </button>
                </div>
              </div>

              <div className="mb-6">
                <label className="text-gray-400 text-sm mb-2 block">已加入的玩家 ({onlinePlayers.length}/4)</label>
                <div className="space-y-2">
                  {onlinePlayers.map((p, i) => (
                    <div key={p.id} className="flex items-center gap-3 bg-white/5 rounded-lg px-4 py-2.5">
                      <span className="text-2xl">{['🧑', '🧑‍💻', '🧑‍🎨', '🧑‍🚀'][i % 4]}</span>
                      <span className="text-white font-medium flex-1">{p.name}</span>
                      {p.isHost && <span className="text-xs bg-orange-500/30 text-orange-300 px-2 py-0.5 rounded">房主</span>}
                    </div>
                  ))}
                </div>
                {onlinePlayers.length < 2 && (
                  <div className="text-center text-gray-500 text-sm mt-3 animate-pulse">等待其他玩家加入...</div>
                )}
              </div>

              {onlineRole === 'host' && (
                <div className="mb-6 space-y-4">
                  <div>
                    <label className="text-gray-400 text-sm mb-2 block">初始资金</label>
                    <div className="grid grid-cols-4 gap-2">
                      {[800, 1000, 1500, 2000, 3000, 5000, 8000, 10000].map(n => (
                        <button key={n} onClick={() => setInitialMoney(n)}
                          className={`py-2 rounded-lg text-xs font-medium transition-all ${initialMoney === n ? 'bg-orange-500/20 border-orange-500 text-orange-300 border' : 'bg-white/5 border border-white/10 text-gray-400'}`}>
                          {n >= 10000 ? `${n / 10000}万` : `¥${n}`}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <label className="text-gray-400 text-sm mb-2 block">购买策略</label>
                    <div className="grid grid-cols-3 gap-2">
                      {[
                        { key: 'easy' as const, label: '🌱 宽松', desc: '对手保守' },
                        { key: 'normal' as const, label: '⚖️ 均衡', desc: '正常' },
                        { key: 'hard' as const, label: '🔥 激烈', desc: '对手激进' },
                      ].map(d => (
                        <button key={d.key} onClick={() => setDifficulty(d.key)}
                          className={`py-2 px-2 rounded-lg text-center transition-all ${difficulty === d.key ? 'bg-orange-500/20 border-orange-500 text-orange-300 border' : 'bg-white/5 border border-white/10 text-gray-400'}`}>
                          <div className="text-sm font-medium">{d.label}</div>
                          <div className="text-[10px] mt-0.5 opacity-70">{d.desc}</div>
                        </button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <label className="text-gray-400 text-sm mb-2 block">游戏时长</label>
                    <div className="grid grid-cols-5 gap-1.5">
                      {[
                        { value: 0, label: '♾️ 无限' },
                        { value: 20, label: '20回合' },
                        { value: 30, label: '30回合' },
                        { value: 50, label: '50回合' },
                        { value: 100, label: '100回合' },
                      ].map(r => (
                        <button key={r.value} onClick={() => setMaxRounds(r.value)}
                          className={`py-2 rounded-lg text-center transition-all ${maxRounds === r.value ? 'bg-orange-500/20 border-orange-500 text-orange-300 border' : 'bg-white/5 border border-white/10 text-gray-400'}`}>
                          <div className="text-xs font-medium">{r.label}</div>
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              <div className="flex gap-3">
                <button onClick={leaveRoom}
                  className="flex-1 py-3 rounded-xl border border-white/10 text-gray-400 hover:border-white/20 transition-colors">
                  退出
                </button>
                {onlineRole === 'host' && (
                  <button onClick={startOnlineGame}
                    disabled={onlinePlayers.length < 2 || gameStarting}
                    className="flex-[2] py-3 bg-gradient-to-r from-orange-500 to-red-500 rounded-xl text-white font-bold hover:from-orange-400 hover:to-red-400 transition-all disabled:opacity-50">
                    {gameStarting ? '启动中...' : `开始游戏 (${onlinePlayers.length}人)`}
                  </button>
                )}
                {onlineRole === 'guest' && (
                  <div className="flex-[2] py-3 text-center text-gray-500 animate-pulse">
                    等待房主开始游戏...
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* 游戏结束 */}
        {screen === 'end' && game && (
          <div className="absolute inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-20">
            <div className="bg-[#1a2332] rounded-2xl p-8 max-w-md w-full mx-4 fade-in border border-white/10 text-center">
              <h2 className="text-3xl font-black text-transparent bg-clip-text bg-gradient-to-r from-yellow-400 to-orange-400 mb-2">
                🎉 游戏结束
              </h2>
              <p className="text-white text-xl font-bold mb-6">
                {game.players.find(p => p.id === game.winner)?.name ?? '未知'} 获胜！
              </p>

              <div className="space-y-3 mb-6">
                {[...game.players].sort((a, b) => totalWealth(b) - totalWealth(a)).map((p, i) => {
                  const propVal = p.properties.reduce((sum, id) => sum + BOARD[id].price, 0)
                  return (
                    <div key={p.id} className="rounded-lg p-3"
                      style={{ background: p.color + '15', borderColor: p.color + '33', borderWidth: 1 }}>
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-3">
                          <span className="text-2xl">{i === 0 ? '👑' : ''} {p.avatar}</span>
                          <div>
                            <span className="text-white font-bold">{p.name}</span>
                            {p.bankrupt && <span className="text-xs text-red-400 ml-2">破产</span>}
                          </div>
                        </div>
                        <div className="text-right">
                          <div className="text-amber-400 font-black text-lg">¥{totalWealth(p)}</div>
                          <div className="text-[10px] text-gray-500">总资产</div>
                        </div>
                      </div>
                      <div className="flex gap-3 text-xs">
                        <div className="flex-1 bg-black/20 rounded-md px-2 py-1 text-center">
                          <div className="text-gray-500">现金</div>
                          <div className="font-bold" style={{ color: p.color }}>¥{p.money}</div>
                        </div>
                        <div className="flex-1 bg-black/20 rounded-md px-2 py-1 text-center">
                          <div className="text-gray-500">地皮 ({p.properties.length}块)</div>
                          <div className="font-bold text-amber-400">¥{propVal}</div>
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>

              <button onClick={mode === 'online' ? leaveRoom : restartGame}
                className="px-8 py-3 bg-gradient-to-r from-orange-500 to-red-500 rounded-xl text-white font-bold hover:from-orange-400 hover:to-red-400 transition-all">
                {mode === 'online' ? '返回大厅' : '再来一局'}
              </button>
            </div>
          </div>
        )}

        {/* 暂停遮罩（仅本地/AI模式） */}
        {paused && screen === 'game' && mode !== 'online' && (
          <div className="absolute inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-30">
            <div className="text-center">
              <h2 className="text-4xl font-bold text-white mb-8">⏸️ 游戏暂停</h2>
              <div className="space-y-3">
                <button onClick={() => setPaused(false)}
                  className="w-48 py-3 bg-gradient-to-r from-orange-500 to-red-500 rounded-xl text-white font-bold hover:from-orange-400 hover:to-red-400 transition-all block mx-auto">
                  ▶️ 继续游戏
                </button>
                <button onClick={restartGame}
                  className="w-48 py-3 bg-white/10 border border-white/20 rounded-xl text-white font-medium hover:bg-white/20 transition-all block mx-auto">
                  🔄 重新开始
                </button>
                <button onClick={() => { setScreen('menu'); setPaused(false) }}
                  className="w-48 py-3 bg-white/10 border border-white/20 rounded-xl text-white font-medium hover:bg-white/20 transition-all block mx-auto">
                  🏠 返回主菜单
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ===== 信息面板 ===== */}
      {screen === 'game' && game && (
        <div className="w-full max-h-[45dvh] md:max-h-none md:w-80 bg-[#1a2332] md:border-l border-t md:border-t-0 border-white/8 flex flex-col overflow-y-auto md:overflow-hidden shrink-0">
          {/* 当前玩家 */}
          <div className="p-4 border-b border-white/8 relative overflow-hidden">
            <div className="absolute inset-0 opacity-10" style={{ background: `linear-gradient(135deg, ${currentPlayer?.color}44, transparent)` }} />
            <div className="absolute top-0 left-0 w-full h-1" style={{ background: currentPlayer?.color }} />
            <div className={`relative flex items-center justify-between ${turnAnim === 'out' ? 'turn-slide-out' : turnAnim === 'in' ? 'turn-slide-in' : ''}`}>
              <div className="flex items-center gap-3">
                <div className="w-12 h-12 rounded-full flex items-center justify-center text-2xl shadow-lg"
                  style={{ background: currentPlayer?.color + '33', border: `2px solid ${currentPlayer?.color}` }}>
                  {currentPlayer?.avatar}
                </div>
                <div>
                  <div className="text-gray-100 font-bold text-lg">{currentPlayer?.name}的回合</div>
                  <div className="text-gray-500 text-xs">第{game.round}回合{game.maxRounds > 0 ? ` / 共${game.maxRounds}回合` : ' · 淘汰制'}</div>
                </div>
              </div>
              <div className="text-right">
                <div className="text-xs text-gray-500">现金 <span className="text-sm font-bold" style={{ color: currentPlayer?.color }}>¥{currentPlayer?.money}</span></div>
                <div className="text-xs text-gray-500">资产 <span className="text-sm font-bold text-amber-400">¥{currentPlayer ? totalWealth(currentPlayer) : 0}</span></div>
              </div>
            </div>
          </div>

          {/* 玩家列表 */}
          <div className="p-3 border-b border-white/8 space-y-2 max-h-60 overflow-y-auto">
            {game.players.map(p => {
              const isCurrent = p.id === currentPlayer?.id
              const propValue = p.properties.reduce((sum, id) => sum + BOARD[id].price, 0)
              const displayMoney = Math.max(0, p.money)
              if (p.bankrupt) {
                return (
                  <div key={p.id}
                    className="p-2 rounded-xl flex items-center gap-2 opacity-50"
                    style={{ background: 'rgba(255,255,255,0.03)' }}>
                    <div className="w-7 h-7 rounded-full flex items-center justify-center text-base grayscale"
                      style={{ background: p.color + '22', border: `1px solid ${p.color}66` }}>
                      {p.avatar}
                    </div>
                    <span className="text-sm text-gray-400 font-medium flex-1 truncate">{p.name}</span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-500/20 text-red-400 font-bold whitespace-nowrap">已破产</span>
                  </div>
                )
              }
              return (
                <div key={p.id}
                  className="p-2.5 rounded-xl transition-all relative"
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
                  <div className="flex items-center justify-between mb-1.5">
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
                            <span className="text-xs text-gray-500">
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
                          {game?.priceHikes.some(h => h.ownerPlayerId === p.id) && (
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
                  <div className="flex items-center gap-2 mt-1">
                    <div className="flex-1 h-1.5 rounded-full bg-white/5 overflow-hidden flex">
                      <div className="h-full rounded-l-full transition-all duration-500" style={{ width: `${totalWealth(p) > 0 ? (displayMoney / totalWealth(p)) * 100 : 100}%`, background: p.color }} />
                      <div className="h-full rounded-r-full transition-all duration-500" style={{ width: `${totalWealth(p) > 0 ? (propValue / totalWealth(p)) * 100 : 0}%`, background: '#f59e0b' }} />
                    </div>
                    <span className="text-[10px] text-gray-500 whitespace-nowrap">共¥{totalWealth(p)}</span>
                  </div>
                </div>
              )
            })}
          </div>

          {/* 操作区 */}
          <div className="p-4 border-b border-white/8">
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
                        <button key={n} onClick={() => handleUseCard(selectedCard, { diceTotal: n })}
                          className="py-2 bg-white/10 rounded text-white text-sm font-bold hover:bg-amber-500/40 transition-colors">
                          {n}
                        </button>
                      ))}
                    </div>
                    <button onClick={() => setSelectedCard(null)}
                      className="w-full mt-2 py-2 bg-white/5 rounded text-gray-400 text-sm hover:bg-white/10">
                      取消
                    </button>
                  </div>
                )}

                {selectedCard.type === 'swap' && (
                  <div className="space-y-2">
                    <div className="text-xs text-gray-300 mb-1">选择要交换位置的玩家：</div>
                    {game?.players.filter(p => p.id !== currentPlayer?.id && !p.bankrupt).map(p => (
                      <button key={p.id} onClick={() => handleUseCard(selectedCard, { playerIdx: p.id })}
                        className="w-full py-2.5 bg-white/8 rounded-lg text-left px-3 hover:bg-white/15 transition-colors flex items-center gap-2">
                        <span>{p.avatar}</span>
                        <span className="text-sm text-gray-200">{p.name}</span>
                        <span className="text-xs text-gray-500 ml-auto">¥{Math.max(0, p.money)}</span>
                      </button>
                    ))}
                    <button onClick={() => setSelectedCard(null)}
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
                        <button key={t.id} onClick={() => handleUseCard(selectedCard, { tileId: t.id })}
                          className="w-full py-2 bg-white/8 rounded text-left px-3 hover:bg-white/15 transition-colors flex items-center gap-2 text-sm">
                          <span>{t.emoji}</span>
                          <span className="text-gray-200">{t.name}</span>
                        </button>
                      ))}
                    </div>
                    <button onClick={() => setSelectedCard(null)}
                      className="w-full mt-2 py-2 bg-white/5 rounded text-gray-400 text-sm hover:bg-white/10">
                      取消
                    </button>
                  </div>
                )}

                {selectedCard.type === 'free_pass' && (
                  <div className="flex gap-2">
                    <button onClick={() => handleUseCard(selectedCard)}
                      className="flex-1 py-2.5 bg-blue-600 rounded-lg text-white text-sm font-bold hover:bg-blue-500 transition-colors">
                      立即激活
                    </button>
                    <button onClick={() => setSelectedCard(null)}
                      className="flex-1 py-2.5 bg-white/8 rounded-lg text-gray-400 text-sm hover:bg-white/10">
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
                          <button key={tid} onClick={() => handleUseCard(selectedCard, { tileId: tid })}
                            className="w-full py-2 bg-white/8 rounded text-left px-3 hover:bg-white/15 transition-colors flex items-center gap-2 text-sm">
                            <span>{t.emoji}</span>
                            <span className="text-gray-200">{t.name}</span>
                            <span className="text-xs text-gray-500 ml-auto">租金 ¥{t.rent[0]} → ¥{t.rent[0]*2}</span>
                          </button>
                        )
                      })}
                    </div>
                    {(!currentPlayer?.properties || currentPlayer.properties.length === 0) && (
                      <div className="text-xs text-gray-500 text-center py-2">你没有地皮可以使用涨价卡</div>
                    )}
                    <button onClick={() => setSelectedCard(null)}
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
                  <button onClick={() => handleBuy(true)}
                    className="flex-1 py-2.5 bg-green-600 rounded-lg text-white text-sm font-bold hover:bg-green-500 transition-colors shadow-lg shadow-green-600/30">
                    💰 购买
                  </button>
                  <button onClick={() => handleBuy(false)}
                    className="flex-1 py-2.5 bg-white/8 rounded-lg text-gray-400 text-sm hover:bg-white/15 transition-colors">
                    跳过
                  </button>
                </div>
              </div>
            ) : isCurrentPlayerHuman && !rolling ? (
              <div className="space-y-2">
                <button onClick={handleRoll}
                  disabled={paused || rolling || currentPlayer?.bankrupt || (mode === 'online' && !isMyTurn)}
                  className="w-full py-3.5 bg-gradient-to-r from-orange-500 to-red-500 rounded-xl text-white font-bold hover:from-orange-400 hover:to-red-400 transition-all shadow-lg shadow-orange-500/30 active:scale-95 text-lg disabled:opacity-50 disabled:cursor-not-allowed">
                  {mode === 'online' && !isMyTurn
                    ? `⏳ 等待 ${currentPlayer?.name} 操作...`
                    : '🎲 掷骰子'}
                </button>
                {/* 道具卡按钮 */}
                {currentPlayer && currentPlayer.cards.length > 0 && game?.phase === 'roll' && (mode !== 'online' || isMyTurn) && (
                  <button onClick={() => setShowCardPanel(!showCardPanel)}
                    className="w-full py-2 bg-purple-600/30 border border-purple-500/40 rounded-lg text-purple-300 text-sm font-medium hover:bg-purple-600/50 transition-colors flex items-center justify-center gap-2">
                    🃏 道具卡 ({currentPlayer.cards.length})
                    {showCardPanel ? ' ▲' : ' ▼'}
                  </button>
                )}
                {showCardPanel && currentPlayer && currentPlayer.cards.length > 0 && (
                  <div className="space-y-1.5 bounce-in">
                    {currentPlayer.cards.map((card, i) => (
                      <button key={card.id || i} onClick={() => setSelectedCard(card)}
                        className="w-full py-2 px-3 bg-white/5 border border-white/10 rounded-lg text-left hover:bg-white/10 transition-colors flex items-center gap-2">
                        <span className="text-lg">{card.emoji}</span>
                        <div className="flex-1">
                          <div className="text-sm text-gray-200 font-medium">{card.name}</div>
                          <div className="text-[10px] text-gray-500">{card.description}</div>
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

          {/* 游戏日志 */}
          <div className="flex-1 overflow-hidden flex flex-col">
            <div className="px-4 pt-3 text-xs text-gray-500 font-medium">游戏日志</div>
            <div ref={logRef} className="flex-1 overflow-y-auto p-4 space-y-1.5">
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
          <div className="p-3 border-t border-white/8 max-h-44 overflow-y-auto">
            <div className="text-xs text-gray-500 mb-2">地皮归属</div>
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
              <span className="text-xs text-gray-600">暂无地皮</span>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
