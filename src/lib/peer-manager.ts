// PeerJS WebRTC 连接管理器
// 用于在线多人模式，无需后端服务器

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
  private isHost: boolean = false
  private roomId: string = ''
  private playerName: string = ''
  private peerId: string = ''

  constructor() {}

  // 初始化 PeerJS 实例
  async initialize(name: string): Promise<string> {
    this.playerName = name
    this.peerId = `monopoly-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
    
    // 动态导入 PeerJS
    const Peer = (await import('peerjs')).default
    
    return new Promise((resolve, reject) => {
      this.peer = new Peer(this.peerId, {
        debug: 2,
        config: {
          iceServers: [
            { urls: 'stun:stun.qq.com' },
            { urls: 'stun:stun.miwifi.com' },
            { urls: 'stun:stun.l.google.com:19302' },
          ]
        }
      })

      this.peer.on('open', (id: string) => {
        this.peerId = id
        console.log('[PeerManager] Peer opened with ID:', id)
        resolve(id)
      })

      this.peer.on('error', (err: any) => {
        console.error('[PeerManager] Peer error:', err)
        reject(err)
      })

      this.peer.on('connection', (conn: any) => {
        this.handleIncomingConnection(conn)
      })

      this.peer.on('disconnected', () => {
        console.log('[PeerManager] Peer disconnected, attempting reconnect...')
        this.peer.reconnect()
      })
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
      const conn = this.peer.connect(hostPeerId, { reliable: true })
      
      conn.on('open', () => {
        this.connections.set(hostPeerId, conn)
        this.connectionHandlers.forEach(h => h(hostPeerId))
        
        // 告诉房主我加入了
        this.sendToPeer(hostPeerId, {
          type: 'player-join',
          payload: { name: this.playerName },
          from: this.peerId,
          timestamp: Date.now(),
        })
        
        resolve()
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
        reject(err)
      })

      // 超时处理
      setTimeout(() => {
        if (!conn.open) {
          conn.close()
          reject(new Error('连接超时，请确认房间号正确且房主在线'))
        }
      }, 30000)
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
