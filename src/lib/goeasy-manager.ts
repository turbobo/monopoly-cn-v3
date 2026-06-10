// GoEasy WebSocket 联机管理器
// 使用 GoEasy PubSub 替代 PeerJS WebRTC
// 房间 = GoEasy Channel（频道）
// 消息 = GoEasy publish/subscribe（JSON 编码的游戏数据）
//
// 免费额度：500 日活用户，10万条消息/月
// 注册：https://www.goeasy.io

import { GOEASY_APPKEY } from './goeasy-config'
// @ts-ignore - GoEasy SDK 没有完整的类型定义
import GoEasySDK from 'goeasy'

// ===== 消息类型（与 PeerJS 版完全兼容） =====
export interface PeerMessage {
  type: 'game-state' | 'player-action' | 'player-join' | 'player-leave' | 'room-info' | 'chat' | 'error' | 'dice-rolled' | 'ping' | 'pong'
  payload: any
  from: string
  timestamp: number
}

export interface RoomInfo {
  roomId: string
  hostId: string
  players: { id: string; name: string; isHost: boolean }[]
}

type MessageHandler = (message: PeerMessage, peerId: string) => void
type ConnectionHandler = (peerId: string) => void

// GoEasy SDK 类型（简化版）
type GoEasySDK = {
  init: (opts: { host?: string; appkey: string; modules?: string[] }) => void
  connect: (opts: {
    id: string
    data?: Record<string, any>
    onSuccess?: () => void
    onFailed?: (err: any) => void
  }) => void
  disconnect: (opts?: {
    onSuccess?: () => void
    onFailed?: (err: any) => void
  }) => void
  getConnectionStatus: () => string
  pubsub: {
    subscribe: (opts: {
      channel: string
      onMessage: (msg: { content: string }) => void
      onSuccess?: () => void
      onFailed?: (err: any) => void
    }) => void
    publish: (opts: {
      channel: string
      message: string
      onSuccess?: () => void
      onFailed?: (err: any) => void
    }) => void
    unsubscribe: (opts: {
      channel: string
      onSuccess?: () => void
      onFailed?: (err: any) => void
    }) => void
  }
}

export class GoEasyManager {
  private goeasy: GoEasySDK | null = null
  private channel: string = ''
  private messageHandlers: MessageHandler[] = []
  private connectionHandlers: ConnectionHandler[] = []
  private disconnectionHandlers: ConnectionHandler[] = []
  private isHost: boolean = false
  private roomId: string = ''
  private playerName: string = ''
  private clientId: string = ''
  private initialized: boolean = false
  private connected: boolean = false
  private destroyed: boolean = false
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null
  private peerLastSeen: Map<string, number> = new Map()
  private heartbeatCheckInterval: ReturnType<typeof setInterval> | null = null
  private static sdkInitialized: boolean = false

  constructor() {}

  // 生成短房间号（6位字母数字）
  private generateShortId(): string {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
    let result = ''
    for (let i = 0; i < 6; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length))
    }
    return result
  }

  // 初始化 GoEasy 连接
  async initialize(name: string, _customId?: string): Promise<string> {
    this.playerName = name
    this.clientId = `${name}-${this.generateShortId()}`

    // 使用静态导入的 GoEasy SDK
    this.goeasy = GoEasySDK as unknown as GoEasySDK
    console.log('[GoEasyManager] SDK loaded:', typeof this.goeasy, 'init:', typeof this.goeasy?.init, 'connect:', typeof this.goeasy?.connect)

    // 初始化 GoEasy（单例，只初始化一次）
    try {
      if (!GoEasyManager.sdkInitialized) {
        this.goeasy.init({
          host: 'hangzhou.goeasy.io',
          appkey: GOEASY_APPKEY,
          modules: ['pubsub'],
        })
        GoEasyManager.sdkInitialized = true
        console.log('[GoEasyManager] init() first call')
      } else {
        console.log('[GoEasyManager] SDK already initialized, skipping init()')
      }
    } catch (e: any) {
      console.error('[GoEasyManager] init() error:', e?.message || e, typeof e)
      throw new Error(`GoEasy 初始化失败: ${e?.message || String(e)}`)
    }

    // 建立 WebSocket 连接
    return new Promise((resolve, reject) => {
      this.goeasy!.connect({
        id: this.clientId,
        data: { name: this.playerName },
        onSuccess: () => {
          this.connected = true
          this.initialized = true
          console.log('[GoEasyManager] Connected as:', this.clientId)
          resolve(this.clientId)
        },
        onFailed: (err: any) => {
          console.error('[GoEasyManager] Connect failed:', JSON.stringify(err), err)
          reject(new Error(`连接 GoEasy 服务器失败: ${JSON.stringify(err)}`))
        },
      })

      // 超时
      setTimeout(() => {
        if (!this.connected) {
          reject(new Error('连接 GoEasy 服务器超时'))
        }
      }, 15000)
    })
  }

  // 创建房间 → 创建并订阅 GoEasy Channel
  async createRoom(): Promise<string> {
    if (!this.goeasy || !this.connected) throw new Error('Not connected')

    this.isHost = true
    this.roomId = this.generateShortId()
    this.channel = `monopoly-${this.roomId}`

    return new Promise((resolve, reject) => {
      this.goeasy!.pubsub.subscribe({
        channel: this.channel,
        onMessage: (msg: { content: string }) => {
          this.handleIncomingMessage(msg.content)
        },
        onSuccess: () => {
          console.log('[GoEasyManager] Room created, channel:', this.channel)
          resolve(this.roomId)
        },
        onFailed: (err: any) => {
          console.error('[GoEasyManager] Subscribe failed:', JSON.stringify(err), err)
          reject(new Error(`创建房间失败: ${JSON.stringify(err)}`))
        },
      })
    })
  }

  // 加入房间 → 订阅已有 GoEasy Channel
  async connectToRoom(roomId: string): Promise<void> {
    if (!this.goeasy || !this.connected) throw new Error('Not connected')

    this.isHost = false
    this.roomId = roomId
    this.channel = `monopoly-${roomId}`

    return new Promise((resolve, reject) => {
      let settled = false
      this.goeasy!.pubsub.subscribe({
        channel: this.channel,
        onMessage: (msg: { content: string }) => {
          this.handleIncomingMessage(msg.content)
        },
        onSuccess: () => {
          if (settled) return
          settled = true
          console.log('[GoEasyManager] Joined room:', roomId)
          this.publishMessage({
            type: 'player-join',
            payload: { name: this.playerName },
            from: this.clientId,
            timestamp: Date.now(),
          })
          this.connectionHandlers.forEach(h => h(roomId))
          resolve()
        },
        onFailed: (err: any) => {
          if (settled) return
          settled = true
          reject(new Error(`加入房间失败: ${JSON.stringify(err)}`))
        },
      })

      setTimeout(() => {
        if (!settled) {
          settled = true
          reject(new Error('加入房间超时'))
        }
      }, 15000)
    })
  }

  // 处理收到的消息
  private handleIncomingMessage(content: string) {
    if (this.destroyed) return

    try {
      const data = JSON.parse(content) as PeerMessage

      // 忽略自己发的消息
      if (data.from === this.clientId) return

      this.peerLastSeen.set(data.from, Date.now())

      if (data.type === 'ping') {
        this.publishMessage({
          type: 'pong',
          payload: null,
          from: this.clientId,
          timestamp: Date.now(),
        })
        return
      }
      if (data.type === 'pong') {
        return
      }

      // player-join 时触发 connection handler（房主端）
      if (data.type === 'player-join' && this.isHost) {
        this.connectionHandlers.forEach(h => h(data.from))
      }

      // 转发给消息处理器
      this.messageHandlers.forEach(h => h(data, data.from))
    } catch (e) {
      console.warn('[GoEasyManager] Failed to parse message:', e)
    }
  }

  // 发布消息到频道
  private publishMessage(message: PeerMessage) {
    if (!this.goeasy || !this.channel) return
    this.goeasy.pubsub.publish({
      channel: this.channel,
      message: JSON.stringify(message),
      onFailed: (err: any) => {
        console.error('[GoEasyManager] Publish failed:', err)
      },
    })
  }

  // 发送消息给特定玩家（GoEasy 中 = publish 到频道，对方过滤）
  sendToPeer(_peerId: string, message: PeerMessage) {
    this.publishMessage({
      ...message,
      from: message.from || this.clientId,
      timestamp: message.timestamp || Date.now(),
    })
  }

  // 广播消息给所有玩家
  broadcast(message: Omit<PeerMessage, 'from' | 'timestamp'>) {
    this.publishMessage({
      ...message,
      from: this.clientId,
      timestamp: Date.now(),
    })
  }

  // 事件监听
  onMessage(handler: MessageHandler): () => void {
    this.messageHandlers.push(handler)
    return () => { this.messageHandlers = this.messageHandlers.filter(h => h !== handler) }
  }

  onConnection(handler: ConnectionHandler): () => void {
    this.connectionHandlers.push(handler)
    return () => { this.connectionHandlers = this.connectionHandlers.filter(h => h !== handler) }
  }

  onDisconnection(handler: ConnectionHandler): () => void {
    this.disconnectionHandlers.push(handler)
    return () => { this.disconnectionHandlers = this.disconnectionHandlers.filter(h => h !== handler) }
  }

  getConnectionCount(): number {
    return 0 // GoEasy pub/sub 无内置成员计数
  }

  getConnectedPeers(): string[] {
    return []
  }

  getRoomId(): string {
    return this.roomId
  }

  getClientId(): string {
    return this.clientId
  }

  getIsHost(): boolean {
    return this.isHost
  }

  setIsHost(isHost: boolean) {
    this.isHost = isHost
  }

  trackPeer(peerId: string) {
    this.peerLastSeen.set(peerId, Date.now())
  }

  untrackPeer(peerId: string) {
    this.peerLastSeen.delete(peerId)
  }

  startHeartbeat() {
    this.stopHeartbeat()

    this.heartbeatInterval = setInterval(() => {
      if (this.destroyed) { this.stopHeartbeat(); return }
      this.publishMessage({
        type: 'ping',
        payload: null,
        from: this.clientId,
        timestamp: Date.now(),
      })
    }, 15000)

    this.heartbeatCheckInterval = setInterval(() => {
      if (this.destroyed) { this.stopHeartbeat(); return }
      const now = Date.now()
      this.peerLastSeen.forEach((lastSeen, peerId) => {
        if (now - lastSeen > 45000) {
          console.log('[GoEasyManager] Heartbeat timeout for peer:', peerId)
          this.peerLastSeen.delete(peerId)
          this.disconnectionHandlers.forEach(h => h(peerId))
        }
      })
    }, 20000)
  }

  private stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval)
      this.heartbeatInterval = null
    }
    if (this.heartbeatCheckInterval) {
      clearInterval(this.heartbeatCheckInterval)
      this.heartbeatCheckInterval = null
    }
  }

  // 清理
  destroy() {
    this.destroyed = true
    this.stopHeartbeat()

    if (this.goeasy && this.channel) {
      try {
        this.goeasy.pubsub.unsubscribe({
          channel: this.channel,
          onFailed: () => {},
        })
      } catch {}
      this.channel = ''
    }

    if (this.goeasy && this.connected) {
      try {
        this.goeasy.disconnect({
          onFailed: () => {},
        })
      } catch {}
      this.connected = false
    }

    this.goeasy = null
    this.messageHandlers = []
    this.connectionHandlers = []
    this.disconnectionHandlers = []
    this.initialized = false
    console.log('[GoEasyManager] Destroyed')
  }
}
