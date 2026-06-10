'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { BoardRenderer } from '@/lib/board-renderer'
import {
  GameState, BOARD, BOARD_SIZE, Player,
  createGame, executeTurn, buyProperty, totalWealth,
  rollDice, finalizeTurn,
} from '@/lib/game-engine'
import { playDiceRoll, playDiceLand, playStepSound, playBuySound, playPaySound, playBankruptSound, setMuted } from '@/lib/sound'
import { GoEasyManager, PeerMessage } from '@/lib/goeasy-manager'

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
  const playersRef = useRef<OnlinePlayer[]>([])
  const screenRef = useRef<Screen>('menu')
  const animatingRef = useRef(false)
  const roomValidatedRef = useRef(false)
  // 游戏状态
  const [screen, setScreen] = useState<Screen>('menu')
  const [mode, setMode] = useState<GameMode>('local')
  const [playerCount, setPlayerCount] = useState(2)
  const [initialMoney, setInitialMoney] = useState(1500)
  const [difficulty, setDifficulty] = useState<'easy' | 'normal' | 'hard'>('normal')
  const [game, setGame] = useState<GameState | null>(null)
  const [messages, setMessages] = useState<string[]>([])
  const [rolling, setRolling] = useState(false)
  const [diceResult, setDiceResult] = useState<number | null>(null)
  const [buyPrompt, setBuyPrompt] = useState<{ tile: typeof BOARD[0] } | null>(null)
  const [paused, setPaused] = useState(false)
  const [copied, setCopied] = useState(false)
  const [muted, setMutedState] = useState(false)

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
    const handleResize = () => {
      clearTimeout(resizeTimer)
      resizeTimer = setTimeout(() => renderer.resize(), 100)
    }
    const handleOrientation = () => setTimeout(() => renderer.resize(), 150)
    window.addEventListener('resize', handleResize)
    window.addEventListener('orientationchange', handleOrientation)

    return () => {
      clearTimeout(resizeTimer)
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
      rendererRef.current.draw(game.players, game.players[game.currentPlayer]?.position)
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
      payload: { game: gs, messages: msgs },
    })
  }, [])

  // ===== 在线模式：执行回合（仅房主） =====
  const executeOnlineTurn = useCallback((dice: [number, number]) => {
    const gs = gameRef.current
    if (!gs) return
    const newState: GameState = JSON.parse(JSON.stringify(gs))
    const currentP = newState.players[newState.currentPlayer]
    const oldPos = currentP.position
    const steps = dice[0] + dice[1]

    const turnMessages = executeTurn(newState, dice)
    const newMsgs = [...messagesRef.current, ...turnMessages]

    const peer = peerRef.current
    if (peer) {
      peer.broadcast({
        type: 'dice-rolled',
        payload: {
          dice: [dice[0], dice[1]],
          playerIndex: gs.currentPlayer,
          fromTile: oldPos,
          game: newState,
          messages: newMsgs,
        },
      })
    }

    playDiceRoll()
    rendererRef.current?.playDiceAnimation(dice, () => {
      playDiceLand()
      setDiceResult(dice[0] + dice[1])

      rendererRef.current?.playMoveAnimation(
        currentP.id, oldPos, steps, currentP.color, currentP.avatar,
        () => {
          for (const msg of turnMessages) {
            if (msg.includes('购买')) playBuySound()
            else if (msg.includes('支付') || msg.includes('缴纳')) playPaySound()
            else if (msg.includes('破产')) playBankruptSound()
          }

          setMessages(newMsgs)
          setGame(newState)
          gameRef.current = newState // 立即同步ref，确保购买超时回调读到最新状态

          if (newState.phase === 'action') {
            const buyer = newState.players[newState.currentPlayer]
            const buyerName = buyer.name
            if (buyerName === myNameRef.current) {
              const tile = BOARD[buyer.position]
              setBuyPrompt({ tile })
            } else {
              if (buyTimeoutRef.current) clearTimeout(buyTimeoutRef.current)
              buyTimeoutRef.current = setTimeout(() => {
                const latestGs = gameRef.current
                if (latestGs && latestGs.phase === 'action') {
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
              }, 10000)
            }
          }

          if (newState.gameOver) {
            setScreen('end')
          }
        },
        () => playStepSound()
      )
    })
  }, [broadcastState])

  // ===== 在线模式：处理消息 =====
  const executeOnlineTurnRef = useRef(executeOnlineTurn)
  useEffect(() => { executeOnlineTurnRef.current = executeOnlineTurn }, [executeOnlineTurn])

  // ===== 注册 LeanCloud 消息处理 =====
  const setupPeerHandlers = useCallback((peer: GoEasyManager) => {
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
            playersRef.current = players
            setOnlinePlayers(players)
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
            const { dice: diceValues, playerIndex, fromTile, game: newGame, messages: newMsgs } = message.payload
            // dice-rolled 到达时，缓存到 ref（动画回调可能需要）
            if (newGame) {
              gameRef.current = newGame
              messagesRef.current = newMsgs || []
            }
            animatingRef.current = true
            setRolling(true)
            playDiceRoll()
            // Guest 端用 2x 速度播放骰子动画，补偿网络延迟
            rendererRef.current?.playDiceAnimation(diceValues, () => {
              playDiceLand()
              setDiceResult(diceValues[0] + diceValues[1])

              // 始终用 gameRef（可能已被 game-state 更新为更新的版本）
              const gs = gameRef.current || newGame
              if (gs) {
                const player = gs.players[playerIndex]
                if (player) {
                  const oldPos = fromTile ?? player.position
                  const steps = diceValues[0] + diceValues[1]
                  // Guest 端用 1.8x 速度播放移动动画
                  rendererRef.current?.playMoveAnimation(
                    player.id, oldPos, steps, player.color, player.avatar,
                    () => {
                      animatingRef.current = false
                      // 用 gameRef 获取最新状态（可能已被 game-state handler 更新）
                      const latestGame = gameRef.current || newGame
                      const latestMsgs = messagesRef.current || newMsgs || []
                      if (latestGame) {
                        setGame(latestGame)
                        setMessages(latestMsgs)
                        setRolling(false)
                        gameRef.current = latestGame
                        if (latestGame.gameOver) setScreen('end')
                        if (latestGame.phase === 'action') {
                          const buyer = latestGame.players[latestGame.currentPlayer]
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
                      }
                    },
                    () => playStepSound(),
                    1.8
                  )
                } else { animatingRef.current = false }
              } else { animatingRef.current = false }
            }, 2)
          }
          break
        }

        case 'game-state': {
          if (!peer.getIsHost()) {
            const { game: newGame, messages: newMsgs } = message.payload

            // 动画进行中：仅缓存到ref，不打断动画（dice-rolled回调会处理状态更新）
            if (animatingRef.current) {
              gameRef.current = newGame
              messagesRef.current = newMsgs
              return
            }

            setGame(newGame)
            setMessages(newMsgs)
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
              const dice = rollDice()
              executeOnlineTurnRef.current(dice)
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
              broadcastState(newState, newMsgs)

              if (newState.gameOver) setScreen('end')
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
            }
          }
          break
        }
      }
    }

    // 处理玩家断线：标记破产 + 跳过回合 + 广播状态
    const handlePlayerDisconnect = (playerName: string, peer: GoEasyManager) => {
      const gs = gameRef.current
      if (!gs || gs.gameOver) return

      const playerIdx = gs.players.findIndex(p => p.name === playerName)
      if (playerIdx === -1) return
      if (gs.players[playerIdx].bankrupt) return // 已破产，无需处理

      const newState: GameState = JSON.parse(JSON.stringify(gs))
      const player = newState.players[playerIdx]
      player.bankrupt = true
      // 变卖所有地皮
      for (const tileId of player.properties) {
        player.money += Math.floor(BOARD[tileId].price * 0.6)
      }
      player.properties = []

      const newMsgs = [...messagesRef.current]
      newMsgs.push(`💀 ${playerName} 断开连接，自动破产退出`)

      // 如果断线的是当前玩家，跳过其回合
      if (newState.currentPlayer === playerIdx) {
        // 推进到下一个玩家
        let next = (newState.currentPlayer + 1) % newState.players.length
        let safety = 0
        while (newState.players[next].bankrupt && safety < newState.players.length) {
          next = (next + 1) % newState.players.length
          safety++
        }
        if (next <= newState.currentPlayer) newState.round++
        newState.currentPlayer = next
        newState.phase = 'roll'
      }

      // 检查游戏是否结束
      const activePlayers = newState.players.filter(p => !p.bankrupt)
      if (activePlayers.length <= 1) {
        newState.gameOver = true
        newState.winner = activePlayers[0]?.id ?? null
        newMsgs.push(`🎉 游戏结束！${activePlayers[0]?.name} 获胜！`)
      }

      // 回合上限检查
      if (newState.round > newState.maxRounds && !newState.gameOver) {
        newState.gameOver = true
        const richest = [...newState.players].filter(p => !p.bankrupt).sort((a, b) => totalWealth(b) - totalWealth(a))
        newState.winner = richest[0]?.id ?? null
        newMsgs.push(`⏰ ${newState.maxRounds}回合结束！${richest[0]?.name} 以总资产最高获胜！`)
      }

      setMessages(newMsgs)
      setGame(newState)
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
        setConnectionError('与房主的连接已断开')
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

      setTimeout(() => {
        if (!roomValidatedRef.current && screenRef.current === 'lobby') {
          setConnectionError('房间不存在或房主已离线')
          peer.destroy()
          peerRef.current = null
          setScreen('setup')
          setOnlineRole(null)
          setOnlinePlayers([])
        }
      }, 8000)
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
    if (onlinePlayers.length < 2) {
      setConnectionError('至少需要2名玩家才能开始游戏')
      return
    }

    const players: Player[] = onlinePlayers.map((p, i) => ({
      id: i,
      name: p.name,
      avatar: ['🧑', '🧑‍💻', '🧑‍🎨', '🧑‍🚀'][i % 4],
      money: initialMoney,
      position: 0,
      properties: [],
      inJail: false,
      jailTurns: 0,
      bankrupt: false,
      isAI: false,
      color: ['#ef4444', '#3b82f6', '#10b981', '#f59e0b'][i % 4],
    }))

    const newGame: GameState = {
      players,
      currentPlayer: 0,
      round: 1,
      maxRounds: 30,
      dice: [1, 1],
      phase: 'roll',
      log: ['🎲 在线游戏开始！'],
      gameOver: false,
      winner: null,
      difficulty,
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
    const newGame = createGame(mode as 'ai' | 'local', playerCount, initialMoney, difficulty)
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

  // ===== 掷骰子 =====
  const handleRoll = useCallback(() => {
    if (!game || rolling || paused || !currentPlayer || currentPlayer.bankrupt) return
    if (game.phase !== 'roll') return
    if (mode !== 'online' && currentPlayer.isAI) return

    // Online mode: only allow rolling on my turn
    if (mode === 'online' && !isMyTurn) return

    setRolling(true)
    setBuyPrompt(null)

    // Online guest: send action to host (don't roll dice or play sound locally)
    if (mode === 'online' && onlineRole === 'guest') {
      const peer = peerRef.current
      if (peer) {
        peer.sendToPeer(roomId, {
          type: 'player-action',
          payload: { type: 'roll', playerName },
          from: peer.getClientId(),
          timestamp: Date.now(),
        })
      }
      // 保持rolling状态，等 dice-rolled 回调中自动重置
      // 超时8秒后自动重置（兜底，防止卡死）
      setTimeout(() => {
        if (!animatingRef.current) setRolling(false)
      }, 8000)
      return
    }

    // Local/AI mode or online host: execute locally
    const dice = rollDice()
    playDiceRoll()

    const oldPos = currentPlayer.position
    const steps = dice[0] + dice[1]

    // Online host: compute results immediately and broadcast with dice event
    let precomputedState: GameState | null = null
    let precomputedMsgs: string[] | null = null
    let precomputedTurnMsgs: string[] | null = null
    if (mode === 'online' && onlineRole === 'host') {
      precomputedState = JSON.parse(JSON.stringify(game))
      precomputedTurnMsgs = executeTurn(precomputedState!, dice)
      precomputedMsgs = [...messagesRef.current, ...precomputedTurnMsgs]
      const peer = peerRef.current
      if (peer) {
        peer.broadcast({
          type: 'dice-rolled',
          payload: {
            dice: [dice[0], dice[1]],
            playerIndex: game.currentPlayer,
            fromTile: currentPlayer.position,
            game: precomputedState,
            messages: precomputedMsgs,
          },
        })
      }
    }

    rendererRef.current?.playDiceAnimation(dice, () => {
      playDiceLand()
      setDiceResult(dice[0] + dice[1])

      rendererRef.current?.playMoveAnimation(
        currentPlayer.id, oldPos, steps, currentPlayer.color, currentPlayer.avatar,
        () => {
          const newState = precomputedState || (() => {
            const s: GameState = JSON.parse(JSON.stringify(game))
            executeTurn(s, dice)
            return s
          })()
          const turnMessages = precomputedTurnMsgs || (() => {
            const s: GameState = JSON.parse(JSON.stringify(game))
            return executeTurn(s, dice)
          })()
          const newMsgs = precomputedMsgs || [...messagesRef.current, ...turnMessages]

          for (const msg of turnMessages) {
            if (msg.includes('购买')) playBuySound()
            else if (msg.includes('支付') || msg.includes('缴纳')) playPaySound()
            else if (msg.includes('破产')) playBankruptSound()
          }

          setMessages(newMsgs)
          setGame(newState)
          gameRef.current = newState

          const updatedPlayer = newState.players[newState.currentPlayer]
          if (newState.phase === 'action') {
            if (mode === 'online') {
              if (updatedPlayer.name === myNameRef.current) {
                const tile = BOARD[updatedPlayer.position]
                setBuyPrompt({ tile })
              } else {
                if (buyTimeoutRef.current) clearTimeout(buyTimeoutRef.current)
                buyTimeoutRef.current = setTimeout(() => {
                  const latestGs = gameRef.current
                  if (latestGs && latestGs.phase === 'action') {
                    const skipState: GameState = JSON.parse(JSON.stringify(latestGs))
                    const skipPlayer = skipState.players[skipState.currentPlayer]
                    const skipTile = BOARD[skipPlayer.position]
                    const skipMsgs = [...messagesRef.current, `❌ ${skipPlayer.name} 放弃购买 ${skipTile.name}`]
                    const finalMsgs = finalizeTurn(skipState)
                    skipMsgs.push(...finalMsgs)
                    setMessages(skipMsgs)
                    setGame(skipState)
                    broadcastState(skipState, skipMsgs)
                    if (skipState.gameOver) setScreen('end')
                  }
                  buyTimeoutRef.current = null
                }, 10000)
              }
            } else if (!updatedPlayer.isAI) {
              const tile = BOARD[updatedPlayer.position]
              setBuyPrompt({ tile })
            } else {
              setTimeout(() => processAITurns(newState, turnMessages), 600)
            }
          } else {
            if (mode !== 'online') {
              setTimeout(() => processAITurns(newState, turnMessages), 600)
            }
          }

          if (newState.gameOver) {
            setScreen('end')
          }
          setRolling(false)
        },
        () => playStepSound()
      )
    })
  }, [game, rolling, paused, currentPlayer, mode, onlineRole, roomId, playerName, isMyTurn, broadcastState])

  // ===== 购买/跳过 =====
  const handleBuy = useCallback((buy: boolean) => {
    if (!game || !currentPlayer) return

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

    const newState: GameState = JSON.parse(JSON.stringify(game))
    const player = newState.players[newState.currentPlayer]
    const tile = BOARD[player.position]
    const newMsgs = [...messagesRef.current]

    if (buy) {
      if (buyProperty(player, tile.id)) {
        newMsgs.push(`🏠 ${player.name} 购买了 ${tile.name}`)
        playBuySound()
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
      setTimeout(() => processAITurns(newState, []), 400)
    }
  }, [game, currentPlayer, mode, onlineRole, roomId, playerName, broadcastState])

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

    setTimeout(() => {
      const dice = rollDice()
      playDiceRoll()

      rendererRef.current?.playDiceAnimation(dice, () => {
        playDiceLand()

        const oldPos = current.position
        const steps = dice[0] + dice[1]

        rendererRef.current?.playMoveAnimation(
          current.id, oldPos, steps, current.color, current.avatar,
          () => {
            const turnMessages = executeTurn(gs, dice)

            for (const msg of turnMessages) {
              if (msg.includes('购买')) playBuySound()
              else if (msg.includes('支付')) playPaySound()
              else if (msg.includes('破产')) playBankruptSound()
            }

            const allMsgs = [...msgs, ...turnMessages]
            setMessages(prev => [...prev, ...turnMessages])
            setGame({ ...gs })

            if (gs.gameOver) {
              setScreen('end')
            } else {
              setTimeout(() => processAITurnsRef.current(gs, allMsgs), 800)
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
    setScreen('setup')
    setGame(null)
    setMessages([])
    setDiceResult(null)
    setBuyPrompt(null)
    setPaused(false)
  }

  // ===== 退出在线房间 =====
  const leaveRoom = () => {
    if (buyTimeoutRef.current) {
      clearTimeout(buyTimeoutRef.current)
      buyTimeoutRef.current = null
    }
    if (peerRef.current) {
      peerRef.current.broadcast({
        type: 'player-leave',
        payload: { name: myNameRef.current },
      })
      peerRef.current.destroy()
      peerRef.current = null
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
        <canvas ref={canvasRef} className="touch-none" />

        {/* 主菜单 */}
        {screen === 'menu' && (
          <div className="absolute inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-20">
            <div className="text-center fade-in">
              <h1 className="text-5xl font-black text-transparent bg-clip-text bg-gradient-to-r from-yellow-400 via-orange-400 to-red-400 mb-3">
                大富翁
              </h1>
              <p className="text-xl text-orange-300 mb-10 font-medium">中国行 · 在线版</p>
              <button
                onClick={() => setScreen('setup')}
                className="px-10 py-4 bg-gradient-to-r from-orange-500 to-red-500 rounded-full text-white font-bold text-lg hover:from-orange-400 hover:to-red-400 transition-all shadow-lg shadow-orange-500/30 hover:scale-105"
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
                      navigator.clipboard.writeText(roomId)
                      setCopied(true)
                      setTimeout(() => setCopied(false), 1500)
                    }}>
                    {roomId}
                  </div>
                  <button
                    onClick={() => {
                      navigator.clipboard.writeText(roomId)
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
                </div>
              )}

              <div className="flex gap-3">
                <button onClick={leaveRoom}
                  className="flex-1 py-3 rounded-xl border border-white/10 text-gray-400 hover:border-white/20 transition-colors">
                  退出
                </button>
                {onlineRole === 'host' && (
                  <button onClick={startOnlineGame}
                    disabled={onlinePlayers.length < 2}
                    className="flex-[2] py-3 bg-gradient-to-r from-orange-500 to-red-500 rounded-xl text-white font-bold hover:from-orange-400 hover:to-red-400 transition-all disabled:opacity-50">
                    开始游戏 ({onlinePlayers.length}人)
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
                {game.players.find(p => p.id === game.winner)?.name} 获胜！
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
            <div className="relative flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-12 h-12 rounded-full flex items-center justify-center text-2xl shadow-lg"
                  style={{ background: currentPlayer?.color + '33', border: `2px solid ${currentPlayer?.color}` }}>
                  {currentPlayer?.avatar}
                </div>
                <div>
                  <div className="text-gray-100 font-bold text-lg">{currentPlayer?.name}的回合</div>
                  <div className="text-gray-500 text-xs">第{game.round}回合 / 共{game.maxRounds}回合</div>
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
              return (
                <div key={p.id}
                  className={`p-2.5 rounded-xl transition-all relative ${p.bankrupt ? 'opacity-30' : ''}`}
                  style={{
                    background: isCurrent ? p.color + '18' : 'rgba(255,255,255,0.03)',
                    borderWidth: isCurrent ? 1 : 0,
                    borderColor: isCurrent ? p.color + '44' : 'transparent',
                    boxShadow: isCurrent ? `0 0 0 2px ${p.color}33, 0 0 12px ${p.color}15` : 'none',
                  }}>
                  {isCurrent && !p.bankrupt && (
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
                        {isCurrent && !p.bankrupt && (
                          <span className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-green-400 border border-white animate-pulse" />
                        )}
                      </div>
                      <div>
                        <div className="text-sm text-gray-200 font-medium flex items-center gap-1.5">
                          {p.name}
                          {isCurrent && !p.bankrupt && (
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
                        <div className="text-xs" style={{ color: p.color }}>{p.properties.length}块地</div>
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="text-sm font-bold" style={{ color: p.color }}>💰 ¥{p.money}</div>
                      <div className="text-xs text-amber-400 font-medium">🏠 ¥{propValue}</div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 mt-1">
                    <div className="flex-1 h-1.5 rounded-full bg-white/5 overflow-hidden flex">
                      <div className="h-full rounded-l-full transition-all duration-500" style={{ width: `${totalWealth(p) > 0 ? (p.money / totalWealth(p)) * 100 : 100}%`, background: p.color }} />
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
            {diceResult && !buyPrompt && (
              <div className="text-center text-sm text-amber-400 font-bold mb-2 bounce-in">
                🎲 {diceResult}
              </div>
            )}
            {buyPrompt ? (
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
                  disabled={paused || (mode === 'online' && !isMyTurn)}
                  className="w-full py-3.5 bg-gradient-to-r from-orange-500 to-red-500 rounded-xl text-white font-bold hover:from-orange-400 hover:to-red-400 transition-all shadow-lg shadow-orange-500/30 active:scale-95 text-lg disabled:opacity-50 disabled:cursor-not-allowed">
                  {mode === 'online' && !isMyTurn
                    ? `⏳ 等待 ${currentPlayer?.name} 操作...`
                    : '🎲 掷骰子'}
                </button>
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
