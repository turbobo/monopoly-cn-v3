// PeerJS WebRTC 连接管理器
// 用于在线多人模式

// ===== 生产环境信令服务器配置 =====
// 部署到 Render 后，将下面的域名替换为你的 Render 服务地址
const PROD_PEER_HOST = '0.peerjs.com'   // 例如: 'monopoly-peerjs.onrender.com'
const PROD_PEER_PORT = 443
const PROD_PEER_PATH = '/'               // 例如: '/peerjs'
const PROD_PEER_SECURE = true

export interface PeerMessage {
  type: 'game-state' | 'player-action' | 'player-join' | 'player-leave' | 'room-info' | 'chat' | 'error' | 'dice-rolled'
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

export class PeerManager {
  private peer: any = null
  private connections: Map<string, any> = new Map()
  private messageHandlers: MessageHandler[] = []
  private connectionHandlers: ConnectionHandler[] = []
  private disconnectionHandlers: ConnectionHandler[] = []
  private errorHandlers: ((err: any) => void)[] = []
  private isHost: boolean = false
  private roomId: string = ''
  private playerName: string = ''
  private peerId: string = ''
  private initialized: boolean = false

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

  // 初始化 PeerJS 实例
  async initialize(name: string, customId?: string): Promise<string> {
    this.playerName = name
    // 使用自定义 ID 或生成短 ID（房主用短 ID，guest 用随机 ID）
    this.peerId = customId || `monopoly-${this.generateShortId()}`
    
    // 动态导入 PeerJS
    const Peer = (await import('peerjs')).default
    
    // 本地开发时使用本地信令服务器，生产环境使用 PeerJS 云服务器
    const isLocal = typeof window !== 'undefined' && window.location.hostname === 'localhost'
    
    const peerOptions: any = {
      debug: 2,
      config: {
        iceServers: [
          { urls: 'stun:stun.qq.com' },
          { urls: 'stun:stun.miwifi.com' },
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' },
        ]
      }
    }
    
    if (isLocal) {
      // 本地信令服务器 (npm run peer 或 npm run dev:all)
      peerOptions.host = 'localhost'
      peerOptions.port = 9000
      peerOptions.path = '/peerjs'
      peerOptions.secure = false
      console.log('[PeerManager] 使用本地信令服务器 ws://localhost:9000/peerjs')
    } else {
      // 生产环境：使用自行部署的信令服务器（Render）
      peerOptions.host = PROD_PEER_HOST
      peerOptions.port = PROD_PEER_PORT
      peerOptions.path = PROD_PEER_PATH
      peerOptions.secure = PROD_PEER_SECURE
      console.log(`[PeerManager] 使用信令服务器 ${PROD_PEER_HOST}`)
    }
    
    return new Promise((resolve, reject) => {
      this.peer = new Peer(this.peerId, peerOptions)

      this.peer.on('open', (id: string) => {
        this.peerId = id
        this.initialized = true
        console.log('[PeerManager] Peer opened with ID:', id)
        resolve(id)
      })

      this.peer.on('error', (err: any) => {
        console.error('[PeerManager] Peer error:', err.type, err.message || err)
        if (!this.initialized) {
          // 还没 open 过，说明是初始化阶段的错误
          reject(err)
        } else {
          // 已初始化后的错误（如 peer-unavailable），通知上层处理
          this.errorHandlers.forEach(h => h(err))
        }
      })

      this.peer.on('connection', (conn: any) => {
        this.handleIncomingConnection(conn)
      })

      this.peer.on('disconnected', () => {
        console.log('[PeerManager] Peer disconnected, attempting reconnect...')
        if (!this.peer.destroyed) {
          this.peer.reconnect()
        }
      })

      // 初始化超时
      setTimeout(() => {
        if (!this.initialized) {
          this.peer.destroy()
          reject(new Error('连接信令服务器超时，请检查网络或信令服务器是否运行'))
        }
      }, 10000)
    })
  }

  // 处理传入的连接（房主接收）
  private handleIncomingConnection(conn: any) {
    console.log('[PeerManager] Incoming connection from:', conn.peer)
    
    conn.on('open', () => {
      this.connections.set(conn.peer, conn)
      this.connectionHandlers.forEach(h => h(conn.peer))
      // 保存第一个连接的peer作为roomId（host模式）
      if (!this.roomId) this.roomId = conn.peer
    })

    conn.on('data', (data: PeerMessage) => {
      this.messageHandlers.forEach(h => h(data, conn.peer))
    })

    conn.on('close', () => {
      this.connections.delete(conn.peer)
      this.disconnectionHandlers.forEach(h => h(conn.peer))
    })

    conn.on('error', (err: any) => {
      console.error('[PeerManager] Connection error:', err)
    })
  }

  // 连接到房间（玩家加入）
  async connectToRoom(roomId: string): Promise<void> {
    if (!this.peer) throw new Error('Peer not initialized')
    
    // roomId 就是房主的 peerId
    const hostPeerId = roomId
    this.roomId = roomId

    return new Promise((resolve, reject) => {
      let settled = false
      const settle = (fn: () => void) => {
        if (!settled) { settled = true; fn() }
      }

      // 监听 Peer 级别的错误（如 peer-unavailable：目标不存在）
      const peerErrorHandler = (err: any) => {
        if (err.type === 'peer-unavailable') {
          settle(() => reject(new Error('房间不存在或房主已离线，请确认房间号')))
        } else {
          settle(() => reject(new Error(`连接失败: ${err.type || err.message}`)))
        }
      }
      this.errorHandlers.push(peerErrorHandler)

      const conn = this.peer.connect(hostPeerId, { reliable: true })

      if (!conn) {
        settle(() => reject(new Error('无法创建连接，请检查网络')))
        return
      }
      
      conn.on('open', () => {
        // 连接成功，移除临时错误处理
        this.errorHandlers = this.errorHandlers.filter(h => h !== peerErrorHandler)
        this.connections.set(hostPeerId, conn)
        this.connectionHandlers.forEach(h => h(hostPeerId))
        
        // 告诉房主我加入了
        this.sendToPeer(hostPeerId, {
          type: 'player-join',
          payload: { name: this.playerName },
          from: this.peerId,
          timestamp: Date.now(),
        })
        
        settle(() => resolve())
      })

      conn.on('data', (data: PeerMessage) => {
        // 接收房间信息
        if (data.type === 'room-info') {
          this.roomId = data.payload.roomId || roomId
        }
        this.messageHandlers.forEach(h => h(data, hostPeerId))
      })

      conn.on('close', () => {
        this.connections.delete(hostPeerId)
        this.disconnectionHandlers.forEach(h => h(hostPeerId))
      })

      conn.on('error', (err: any) => {
        console.error('[PeerManager] Connect error:', err)
        settle(() => reject(new Error(`连接错误: ${err.message || err.type || '未知'}`)))
      })

      // 超时处理
      setTimeout(() => {
        this.errorHandlers = this.errorHandlers.filter(h => h !== peerErrorHandler)
        settle(() => {
          conn.close()
          reject(new Error('连接超时，请确认房间号正确且房主在线'))
        })
      }, 15000)
    })
  }

  // 发送消息给特定玩家
  sendToPeer(peerId: string, message: PeerMessage) {
    const conn = this.connections.get(peerId)
    if (conn && conn.open) {
      conn.send(message)
    } else {
      console.warn('[PeerManager] Cannot send to peer:', peerId, '- not connected')
    }
  }

  // 广播消息给所有连接的玩家
  broadcast(message: Omit<PeerMessage, 'from' | 'timestamp'>) {
    const fullMessage: PeerMessage = {
      ...message,
      from: this.peerId,
      timestamp: Date.now(),
    }
    
    this.connections.forEach((conn, peerId) => {
      if (conn.open) {
        conn.send(fullMessage)
      }
    })
  }

  // 事件监听（返回取消注册函数）
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

  // 获取连接的玩家数量
  getConnectionCount(): number {
    return this.connections.size
  }

  // 获取所有连接的 peer IDs
  getConnectedPeers(): string[] {
    return Array.from(this.connections.keys())
  }

  // 获取房间ID（用于分享）
  getRoomId(): string {
    return this.roomId || this.peerId
  }

  // 是否是房主
  getIsHost(): boolean {
    return this.isHost
  }

  setIsHost(isHost: boolean) {
    this.isHost = isHost
  }

  // 销毁
  destroy() {
    this.connections.forEach(conn => conn.close())
    this.connections.clear()
    if (this.peer) {
      this.peer.destroy()
    }
    this.messageHandlers = []
    this.connectionHandlers = []
    this.disconnectionHandlers = []
  }
}
