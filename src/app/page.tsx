'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { BoardRenderer } from '@/lib/board-renderer'
import {
  GameState, BOARD, Player, GameCard,
  createGame, executeTurn, buyProperty, totalWealth,
  rollDice, finalizeTurn, nextPlayer, useRemoteDice, useSwapCard, useRoadblockCard,
  useFreePassCard, usePriceHikeCard, aiUseCardDecision,
} from '@/lib/game-engine'
import { playDiceRoll, playDiceLand, playStepSound, playBuySound, playPaySound, playBankruptSound, playPlayerJoinSound, playPlayerLeaveSound, setMuted } from '@/lib/sound'
import { GoEasyManager, PeerMessage } from '@/lib/goeasy-manager'
import { slimGame, trimMessages, mergeMessages } from '@/lib/online-utils'
import ControlBar from '@/components/ControlBar'
import TileInfoPopup from '@/components/TileInfoPopup'
import GamePanel from '@/components/GamePanel'
import { Screen, GameMode, OnlineRole, OnlinePlayer } from '@/lib/types'

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
  // 掉线宽限期定时器：key = playerName，value = setTimeout id
  // 玩家断线 → 标记 disconnected → 启动 60s 定时器；重连 → 清除
  const graceTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
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
  const [connectionStatus, setConnectionStatus] = useState<{ status: 'reconnecting' | 'connected' | 'failed' | null; message: string }>({ status: null, message: '' })
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
      // 清理宽限期定时器，避免内存泄漏
      graceTimersRef.current.forEach(t => clearTimeout(t))
      graceTimersRef.current.clear()
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

  // 清理 GoEasy 连接
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
      // 进入/重启游戏时容器尺寸会变化（信息面板出现），需重新计算棋盘尺寸
      rendererRef.current.resize()
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

  // ===== 注册 GoEasy 消息处理 =====
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
            // 宽限期重连检测：如果加入的名字匹配某个掉线中的玩家 → 当作重连处理
            const gs = gameRef.current
            if (gs && !gs.gameOver) {
              const disconnectedPlayer = gs.players.find(
                p => p.name === message.payload.name && p.disconnected
              )
              if (disconnectedPlayer) {
                // 更新 playersRef 中的 peerId 映射
                const updatedPlayers = playersRef.current.map(p =>
                  p.name === disconnectedPlayer.name
                    ? { ...p, id: message.from }
                    : p
                )
                // 如果不在列表中（被过滤），重新加入
                if (!updatedPlayers.some(p => p.name === disconnectedPlayer.name)) {
                  updatedPlayers.push({
                    id: message.from,
                    name: disconnectedPlayer.name,
                    isHost: false,
                  })
                }
                playersRef.current = updatedPlayers
                setOnlinePlayers(updatedPlayers)
                peer.trackPeer(message.from)
                playPlayerJoinSound()
                // 通知掉线玩家已重连
                handlePlayerReconnect(disconnectedPlayer.name, peer)
                // 广播最新的 room-info（含重连玩家）
                peer.broadcast({
                  type: 'room-info',
                  payload: {
                    players: updatedPlayers.map(p => ({ id: p.id, name: p.name, isHost: p.isHost })),
                  }
                })
                break
              }
            }

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
            if (!actor || actor.bankrupt || actor.disconnected) break
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

        case 'host-migrated': {
          // Guest 收到新房主的迁移通知：更新玩家列表 + 标记新房主
          if (!peer.getIsHost()) {
            const { newHostId, newHostName, oldHostName, players } = message.payload
            const migrated: OnlinePlayer[] = players.map((p: { id: string; name: string; isHost: boolean }) => ({
              id: p.id,
              name: p.name,
              isHost: p.isHost,
            }))
            playersRef.current = migrated
            setOnlinePlayers(migrated)

            // 清除错误提示（可能之前显示过"等待新房主晋升..."）
            setConnectionError('')

            const newMsgs = [...messagesRef.current]
            newMsgs.push(`👑 ${oldHostName} 已断线，${newHostName} 晋升为新房主`)
            setMessages(newMsgs)

            // 如果当前是 lobby 阶段，保持状态；如果是 game 阶段，等新房主广播 game-state
            // 新房主会在迁移后立即广播 game-state，这里无需主动请求
          }
          break
        }
      }
    }

    // 最终破产处理（宽限期到期或主动放弃时调用）：标记破产 + 跳过回合 + 广播状态
    const finalizeDisconnect = (disconnectedName: string, peer: GoEasyManager) => {
      const gs = gameRef.current
      if (!gs || gs.gameOver) return

      const playerIdx = gs.players.findIndex(p => p.name === disconnectedName)
      if (playerIdx === -1) return
      if (gs.players[playerIdx].bankrupt) return // 已破产，无需处理

      // 清理宽限期定时器（防止重复触发）
      const existingTimer = graceTimersRef.current.get(disconnectedName)
      if (existingTimer) {
        clearTimeout(existingTimer)
        graceTimersRef.current.delete(disconnectedName)
      }

      // 如果断线玩家正在购买决策中，清除购买超时
      if (buyTimeoutRef.current && gs.currentPlayer === playerIdx) {
        clearTimeout(buyTimeoutRef.current)
        buyTimeoutRef.current = null
      }

      const newState: GameState = JSON.parse(JSON.stringify(gs))
      const player = newState.players[playerIdx]
      player.bankrupt = true
      player.disconnected = false // 清理掉线标记
      // 金钱可能已为负，先归零再变卖
      player.money = Math.max(0, player.money)
      // 变卖所有地皮
      for (const tileId of player.properties) {
        player.money += Math.floor(BOARD[tileId].price * 0.6)
      }
      player.properties = []

      const newMsgs = [...messagesRef.current]
      newMsgs.push(`💀 ${disconnectedName} 宽限期到期，自动破产退出`)

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

    // 处理玩家断线：进入 60s 宽限期（标记 disconnected + 启动定时器），到期才破产
    const handlePlayerDisconnect = (disconnectedName: string, peer: GoEasyManager) => {
      const gs = gameRef.current
      if (!gs || gs.gameOver) return

      const playerIdx = gs.players.findIndex(p => p.name === disconnectedName)
      if (playerIdx === -1) return
      const player = gs.players[playerIdx]
      if (player.bankrupt) return // 已破产，无需处理
      if (player.disconnected) return // 已处于宽限期，避免重复触发

      // 如果断线玩家正在购买决策中，清除购买超时（避免 20s 后自动跳过）
      if (buyTimeoutRef.current && gs.currentPlayer === playerIdx) {
        clearTimeout(buyTimeoutRef.current)
        buyTimeoutRef.current = null
      }

      const newState: GameState = JSON.parse(JSON.stringify(gs))
      newState.players[playerIdx].disconnected = true

      const newMsgs = [...messagesRef.current]
      // 区分当前玩家 vs 非当前玩家：当前玩家的回合会被保留，等其重连后继续
      const isCurrentPlayerDisconnecting = newState.currentPlayer === playerIdx
      newMsgs.push(
        isCurrentPlayerDisconnecting
          ? `⚠️ ${disconnectedName} 断开连接（当前回合），进入 60 秒宽限期，等待重连继续...`
          : `⚠️ ${disconnectedName} 断开连接，进入 60 秒宽限期...`
      )

      // 关键改动：不跳过当前玩家的回合！
      // 保留 currentPlayer == playerIdx，等玩家重连后自动恢复操作
      // 如果 60s 内未重连，finalizeDisconnect 才会推进回合
      // 非当前玩家断线：无需处理回合推进

      setMessages(newMsgs)
      setGame(newState)
      gameRef.current = newState
      broadcastState(newState, newMsgs)

      // 启动 60s 宽限期定时器
      const GRACE_PERIOD_MS = 60_000
      const timer = setTimeout(() => {
        graceTimersRef.current.delete(disconnectedName)
        // 定时器到期时再检查游戏状态（可能已经结束）
        finalizeDisconnect(disconnectedName, peer)
      }, GRACE_PERIOD_MS)
      graceTimersRef.current.set(disconnectedName, timer)
    }

    // 处理掉线玩家重连：清除 disconnected 标记 + 取消定时器 + 恢复回合
    const handlePlayerReconnect = (reconnectedName: string, peer: GoEasyManager) => {
      const gs = gameRef.current
      if (!gs || gs.gameOver) return

      const playerIdx = gs.players.findIndex(p => p.name === reconnectedName)
      if (playerIdx === -1) return
      if (!gs.players[playerIdx].disconnected) return // 不在宽限期

      // 清除定时器
      const timer = graceTimersRef.current.get(reconnectedName)
      if (timer) {
        clearTimeout(timer)
        graceTimersRef.current.delete(reconnectedName)
      }

      const newState: GameState = JSON.parse(JSON.stringify(gs))
      newState.players[playerIdx].disconnected = false

      const newMsgs = [...messagesRef.current]
      // 根据是否是当前回合玩家，给出不同的重连提示
      const isTheirTurn = newState.currentPlayer === playerIdx
      newMsgs.push(
        isTheirTurn
          ? `✅ ${reconnectedName} 已重新连接，回合已恢复，请继续操作`
          : `✅ ${reconnectedName} 已重新连接`
      )

      setMessages(newMsgs)
      setGame(newState)
      gameRef.current = newState
      broadcastState(newState, newMsgs)
    }

    const disconnectionHandler = (peerId: string) => {
      if (peer.getIsHost()) {
        peer.untrackPeer(peerId)
        const leaverInfo = playersRef.current.find(p => p.id === peerId)
        // 关键：保留断线玩家在 playersRef（用于宽限期内的重连识别）
        // 仅在 lobby 阶段（游戏未开始）才从列表移除
        const gameActive = !!gameRef.current && !gameRef.current.gameOver
        const updated = gameActive
          ? playersRef.current // 游戏进行中：保留，等重连
          : playersRef.current.filter(p => p.id !== peerId) // 未开始游戏：移除
        playersRef.current = updated
        setOnlinePlayers(updated)
        playPlayerLeaveSound()
        // 广播只包含"在线"玩家，避免 lobby 显示幽灵玩家
        peer.broadcast({
          type: 'room-info',
          payload: {
            players: updated
              .filter(p => !gameRef.current?.players.find(gp => gp.name === p.name && gp.disconnected))
              .map(p => ({ id: p.id, name: p.name, isHost: p.isHost })),
          }
        })
        // 如果游戏进行中，进入宽限期
        if (leaverInfo && gameActive) {
          handlePlayerDisconnect(leaverInfo.name, peer)
        }
      } else {
        // Guest 端：检查断开的是否为房主
        const disconnectedPeer = playersRef.current.find(p => p.id === peerId)
        if (disconnectedPeer?.isHost) {
          // ===== Host Migration：按 ID 字典序最小的 Guest 自动晋升为新房主 =====
          const myId = peer.getClientId()
          const remaining = playersRef.current.filter(p => p.id !== peerId)
          // 找到除自己外字典序最小的 Guest ID
          const otherIds = remaining.filter(p => !p.isHost).map(p => p.id)
          const iAmFirstGuest = otherIds.every(id => id.localeCompare(myId) >= 0)

          if (iAmFirstGuest && remaining.length > 0) {
            // 我晋升为新房主
            peer.setIsHost(true)
            setOnlineRole('host')
            // 更新 playersRef 中的 isHost 标记
            const migrated = remaining.map(p =>
              p.id === myId ? { ...p, isHost: true } : { ...p, isHost: false }
            )
            playersRef.current = migrated
            setOnlinePlayers(migrated)

            const newMsgs = [...messagesRef.current]
            newMsgs.push(`👑 房主已断线，你已自动晋升为新房主`)
            setMessages(newMsgs)

            // 广播 host-migrated 通知其他 Guest
            peer.broadcast({
              type: 'host-migrated',
              payload: {
                newHostId: myId,
                newHostName: playerName,
                oldHostName: disconnectedPeer.name,
                players: migrated.map(p => ({ id: p.id, name: p.name, isHost: p.isHost })),
              }
            })

            // 同步当前游戏状态（作为新房主权威）
            if (gameRef.current && !gameRef.current.gameOver) {
              broadcastState(gameRef.current, newMsgs)
            }
          } else {
            // 等其他 Guest 的 host-migrated 消息；先显示临时提示
            setConnectionError('房主已断线，等待新房主晋升...')
            // 暂时保留当前状态，10s 内没收到 host-migrated 则回大厅
            setTimeout(() => {
              // 如果仍显示该错误说明没收到迁移消息
              if (screenRef.current === 'lobby' || screenRef.current === 'game') {
                setConnectionError('')
              }
            }, 10000)
          }
        }
      }
    }

    peer.onMessage(messageHandler)
    peer.onDisconnection(disconnectionHandler)
    // 重连状态回调：驱动 UI 浮层显示 "正在重连 N/5" / "连接失败"
    peer.onConnectionStatusChange((status, message) => {
      setConnectionStatus({ status, message })
      // "已重新连接" 提示 1.5s 后自动消失
      if (status === 'connected') {
        setTimeout(() => {
          setConnectionStatus(prev => (prev.status === 'connected' ? { status: null, message: '' } : prev))
        }, 1500)
      }
    })
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
      // 30s 超时：避免网络波动或房主短暂断线导致误判
      const joinedPeer = peer // 捕获当前实例，防止超时回调误操作新实例
      setTimeout(() => {
        // 只有当前 peer 实例没变、且仍在 lobby、且未收到 room-info 时才判定失败
        if (!roomValidatedRef.current && screenRef.current === 'lobby' && peerRef.current === joinedPeer) {
          setConnectionError('房间不存在或房主已离线（等待 30 秒无响应）')
          joinedPeer.destroy()
          peerRef.current = null
          setScreen('setup')
          setOnlineRole(null)
          setOnlinePlayers([])
        }
      }, 30000)
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
    // 允许本地玩家重连后继续操作（disconnected 标记会在重连时被 Host 清除，但以防万一这里也放过本地）
    const isLocalPlayer = currentPlayer?.name === playerName
    if (!game || rolling || paused || !currentPlayer || currentPlayer.bankrupt) return
    if (currentPlayer.disconnected && !isLocalPlayer) return // 仅阻止远端掉线玩家，不阻止本地重连玩家
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
    const isLocalPlayer = currentPlayerObj?.name === playerName
    if (!currentPlayerObj || currentPlayerObj.bankrupt) return
    if (currentPlayerObj.disconnected && !isLocalPlayer) return // 仅阻止远端掉线玩家

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
    // 清理所有宽限期定时器
    graceTimersRef.current.forEach(t => clearTimeout(t))
    graceTimersRef.current.clear()
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
    // 清理所有宽限期定时器
    graceTimersRef.current.forEach(t => clearTimeout(t))
    graceTimersRef.current.clear()
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
    <>
    <div className="flex flex-col md:flex-row bg-[#0f1419] overflow-hidden" style={{ height: '100dvh' }}>
      {/* 控制栏 */}
      {screen === 'game' && (
        <ControlBar
          mode={mode}
          paused={paused}
          muted={muted}
          onPrimaryAction={mode === 'online' ? leaveRoom : restartGame}
          onTogglePause={() => setPaused(!paused)}
          onToggleMute={() => setMutedState(!muted)}
        />
      )}

      {/* 棋盘区域（移动端顶部预留控制栏空间，避免按钮遮挡棋盘） */}
      <div className="flex-1 relative flex items-center justify-center px-1 pt-11 pb-1 md:p-2 touch-none" style={{ minHeight: 'min(52dvh, 430px)' }}>
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
        {tileInfo && game && (
          <TileInfoPopup
            tileIndex={tileInfo.tileIndex}
            x={tileInfo.x}
            y={tileInfo.y}
            game={game}
            onClose={() => setTileInfo(null)}
          />
        )}

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
                className="btn-sweep px-10 py-4 bg-gradient-to-r from-orange-500 to-red-500 rounded-full text-white font-bold text-lg hover:from-orange-400 hover:to-red-400 transition-all shadow-lg shadow-orange-500/30 hover:scale-105 active:scale-95"
              >
                开始游戏
              </button>
              <p className="text-gray-400 text-sm mt-6">掷骰子 · 买地皮 · 收租金 · 在线对战</p>
            </div>
          </div>
        )}

        {/* 模式选择 */}
        {screen === 'setup' && (
          <div className="absolute inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-20">
            <div className="bg-[#1a2332] rounded-2xl p-4 md:p-8 max-w-md w-full mx-4 fade-in border border-white/10 max-h-[90vh] overflow-y-auto">
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
                    <div className="grid grid-cols-3 md:grid-cols-4 gap-2">
                      {[800, 1000, 1500, 2000, 3000, 5000, 8000, 10000].map(n => (
                        <button key={n} onClick={() => setInitialMoney(n)}
                          className={`py-2 md:py-2.5 rounded-xl text-sm font-medium transition-all ${initialMoney === n ? 'bg-orange-500/20 border-orange-500 text-orange-300 border' : 'bg-white/5 border border-white/10 text-gray-400 hover:border-white/20'}`}>
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
                      <span className="text-gray-400 text-xs ml-1">自定义</span>
                    </div>
                  </div>

                  <div className="mb-6">
                    <label className="text-gray-400 text-sm mb-2 block">游戏时长</label>
                    <div className="grid grid-cols-3 md:grid-cols-5 gap-1.5 md:gap-2">
                      {[
                        { value: 0, label: '♾️ 无限', desc: '淘汰制' },
                        { value: 20, label: '20回合', desc: '快速' },
                        { value: 30, label: '30回合', desc: '标准' },
                        { value: 50, label: '50回合', desc: '长局' },
                        { value: 100, label: '100回合', desc: '史诗' },
                      ].map(r => (
                        <button key={r.value} onClick={() => setMaxRounds(r.value)}
                          className={`py-2 md:py-2.5 rounded-xl text-center transition-all ${maxRounds === r.value ? 'bg-orange-500/20 border-orange-500 text-orange-300 border' : 'bg-white/5 border border-white/10 text-gray-400 hover:border-white/20'}`}>
                          <div className="text-sm font-medium">{r.label}</div>
                          <div className="text-[10px] mt-0.5 opacity-70">{r.desc}</div>
                        </button>
                      ))}
                    </div>
                    <div className="text-[10px] text-gray-400 mt-2 text-center">
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
                    className="w-full py-3.5 rounded-xl font-bold transition-all bg-green-600/20 border border-green-500 text-green-300 hover:bg-green-600/30 disabled:opacity-50 active:scale-[0.98]">
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
                      className="px-5 py-2.5 rounded-xl font-bold transition-all bg-blue-600/20 border border-blue-500 text-blue-300 hover:bg-blue-600/30 disabled:opacity-50 active:scale-[0.98]">
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
                    className="flex-[2] py-3 bg-gradient-to-r from-orange-500 to-red-500 rounded-xl text-white font-bold hover:from-orange-400 hover:to-red-400 transition-all active:scale-[0.98]">
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
            <div className="bg-[#1a2332] rounded-2xl p-4 md:p-8 max-w-md w-full mx-4 fade-in border border-white/10 max-h-[90vh] overflow-y-auto">
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
                    <div className="grid grid-cols-3 md:grid-cols-4 gap-2">
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
                    <div className="grid grid-cols-3 md:grid-cols-5 gap-1.5">
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
                    className="flex-[2] py-3 bg-gradient-to-r from-orange-500 to-red-500 rounded-xl text-white font-bold hover:from-orange-400 hover:to-red-400 transition-all disabled:opacity-50 active:scale-[0.98]">
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
            <div className="bg-[#1a2332] rounded-2xl p-4 md:p-8 max-w-md w-full mx-4 fade-in border border-white/10 text-center max-h-[90vh] overflow-y-auto">
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
                    <div key={p.id} className="rounded-xl p-3"
                      style={{ background: p.color + '15', borderColor: p.color + '33', borderWidth: 1 }}>
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-3">
                          <span className="text-2xl">{i === 0 ? '👑' : ''} {p.avatar}</span>
                          <div>
                            <span className="text-white font-bold">{p.name}</span>
                            {p.bankrupt && <span className="text-xs text-red-400 ml-2">破产</span>}
                            {p.disconnected && !p.bankrupt && <span className="text-xs text-yellow-400 ml-2 animate-pulse">掉线中</span>}
                          </div>
                        </div>
                        <div className="text-right">
                          <div className="text-amber-400 font-black text-lg">¥{totalWealth(p)}</div>
                          <div className="text-[10px] text-gray-400">总资产</div>
                        </div>
                      </div>
                      <div className="flex gap-3 text-xs">
                        <div className="flex-1 bg-black/20 rounded-md px-2 py-1 text-center">
                          <div className="text-gray-400">现金</div>
                          <div className="font-bold" style={{ color: p.color }}>¥{p.money}</div>
                        </div>
                        <div className="flex-1 bg-black/20 rounded-md px-2 py-1 text-center">
                          <div className="text-gray-400">地皮 ({p.properties.length}块)</div>
                          <div className="font-bold text-amber-400">¥{propVal}</div>
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>

              <button onClick={mode === 'online' ? leaveRoom : restartGame}
                className="px-8 py-3 bg-gradient-to-r from-orange-500 to-red-500 rounded-xl text-white font-bold hover:from-orange-400 hover:to-red-400 transition-all active:scale-95">
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
                  className="w-48 py-3 bg-gradient-to-r from-orange-500 to-red-500 rounded-xl text-white font-bold hover:from-orange-400 hover:to-red-400 transition-all active:scale-95 block mx-auto">
                  ▶️ 继续游戏
                </button>
                <button onClick={restartGame}
                  className="w-48 py-3 bg-white/10 border border-white/20 rounded-xl text-white font-medium hover:bg-white/20 transition-all active:scale-95 block mx-auto">
                  🔄 重新开始
                </button>
                <button onClick={() => { setScreen('menu'); setPaused(false) }}
                  className="w-48 py-3 bg-white/10 border border-white/20 rounded-xl text-white font-medium hover:bg-white/20 transition-all active:scale-95 block mx-auto">
                  🏠 返回主菜单
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ===== 信息面板 ===== */}
      {screen === 'game' && game && (
        <GamePanel
          game={game}
          messages={messages}
          buyPrompt={buyPrompt}
          selectedCard={selectedCard}
          showCardPanel={showCardPanel}
          diceResult={diceResult}
          rolling={rolling}
          paused={paused}
          isMyTurn={isMyTurn}
          myName={playerName}
          mode={mode}
          turnAnim={turnAnim}
          logRef={logRef}
          onRoll={handleRoll}
          onBuy={handleBuy}
          onUseCard={handleUseCard}
          onSelectCard={setSelectedCard}
          onToggleCardPanel={setShowCardPanel}
        />
      )}
    </div>

    {/* 重连状态浮层 */}
    {connectionStatus.status && (
      <div
        className={`fixed inset-0 z-50 flex items-center justify-center backdrop-blur-sm transition-opacity
          ${connectionStatus.status === 'failed' ? 'bg-black/70' : 'bg-black/50'}`}>
        <div className={`px-6 py-5 rounded-2xl shadow-2xl border max-w-sm mx-4
          ${connectionStatus.status === 'failed'
            ? 'bg-red-950/95 border-red-500/40'
            : connectionStatus.status === 'connected'
            ? 'bg-green-950/95 border-green-500/40'
            : 'bg-gray-900/95 border-blue-500/30'}`}>
          <div className="flex items-center gap-3">
            {connectionStatus.status === 'reconnecting' && (
              <div className="w-5 h-5 rounded-full border-2 border-blue-400 border-t-transparent animate-spin shrink-0"/>
            )}
            {connectionStatus.status === 'connected' && (
              <div className="w-5 h-5 rounded-full bg-green-500 flex items-center justify-center text-white text-xs shrink-0">✓</div>
            )}
            {connectionStatus.status === 'failed' && (
              <div className="w-5 h-5 rounded-full bg-red-500 flex items-center justify-center text-white text-xs shrink-0">!</div>
            )}
            <div className="flex-1 min-w-0">
              <div className={`text-sm font-medium
                ${connectionStatus.status === 'failed' ? 'text-red-300' :
                  connectionStatus.status === 'connected' ? 'text-green-300' : 'text-blue-200'}`}>
                {connectionStatus.message}
              </div>
              {connectionStatus.status === 'reconnecting' && (
                <div className="text-xs text-gray-400 mt-0.5">请检查网络连接，自动重连中...</div>
              )}
              {connectionStatus.status === 'failed' && (
                <button
                  onClick={() => window.location.reload()}
                  className="mt-2 px-3 py-1 text-xs rounded-md bg-red-500/20 text-red-200 border border-red-500/40 hover:bg-red-500/30 transition-colors">
                  刷新页面
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    )}
    </>
  )
}
