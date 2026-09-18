import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { GoEasyManager, PeerMessage } from '../goeasy-manager'

// ===== Mock GoEasy SDK =====
const mockGoEasy = vi.hoisted(() => ({
  init: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
  getConnectionStatus: vi.fn(() => 'connected'),
  pubsub: {
    subscribe: vi.fn(),
    publish: vi.fn(),
    unsubscribe: vi.fn(),
  },
}))

vi.mock('goeasy', () => ({ default: mockGoEasy }))

/** 捕获最近一次 subscribe 的 onMessage 回调 */
function getSubscribeOnMessage() {
  const last = mockGoEasy.pubsub.subscribe.mock.calls[mockGoEasy.pubsub.subscribe.mock.calls.length - 1]
  return last?.[0]?.onMessage
}

/** 触发 connect onSuccess */
function triggerConnectSuccess() {
  const opts = mockGoEasy.connect.mock.calls[mockGoEasy.connect.mock.calls.length - 1]?.[0]
  opts?.onSuccess?.()
}

/** 触发 subscribe onSuccess */
function triggerSubscribeSuccess() {
  const opts = mockGoEasy.pubsub.subscribe.mock.calls[mockGoEasy.pubsub.subscribe.mock.calls.length - 1]?.[0]
  opts?.onSuccess?.()
}

describe('GoEasyManager', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    // 重置静态状态，防止测试间污染
    ;(GoEasyManager as any).sdkInitialized = false
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('initialize', () => {
    it('连接成功后返回 clientId 并置 connected', async () => {
      const mgr = new GoEasyManager()
      const promise = mgr.initialize('测试玩家')
      expect(mockGoEasy.init).toHaveBeenCalledWith({
        host: 'hangzhou.goeasy.io',
        appkey: expect.any(String),
        modules: ['pubsub'],
      })
      triggerConnectSuccess()
      const clientId = await promise
      expect(clientId).toMatch(/^测试玩家-[A-Z2-9]{6}$/)
    })

    it('SDK 单例只 init 一次', async () => {
      const mgr1 = new GoEasyManager()
      const p1 = mgr1.initialize('P1')
      triggerConnectSuccess()
      await p1
      mgr1.destroy()

      // destroy 会重置 sdkInitialized → 新实例需重新 init
      const mgr2 = new GoEasyManager()
      const p2 = mgr2.initialize('P2')
      triggerConnectSuccess()
      await p2
      expect(mockGoEasy.init).toHaveBeenCalledTimes(2)
      mgr2.destroy()
    })

    it('连接失败时 reject', async () => {
      const mgr = new GoEasyManager()
      const promise = mgr.initialize('P1')
      const opts = mockGoEasy.connect.mock.calls[0][0]
      opts?.onFailed?.({ code: 'FAIL' })
      await expect(promise).rejects.toThrow('连接 GoEasy 服务器失败')
    })

    it('15 秒超时 reject 并断开连接', async () => {
      const mgr = new GoEasyManager()
      const promise = mgr.initialize('P1')
      vi.advanceTimersByTime(15000)
      await expect(promise).rejects.toThrow('连接 GoEasy 服务器超时')
      expect(mockGoEasy.disconnect).toHaveBeenCalled()
    })
  })

  describe('createRoom', () => {
    it('未连接时抛 Not connected', async () => {
      const mgr = new GoEasyManager()
      await expect(mgr.createRoom()).rejects.toThrow('Not connected')
    })

    it('订阅成功返回房间号，格式 monopoly-{roomId}', async () => {
      const mgr = new GoEasyManager()
      const p = mgr.initialize('P1')
      triggerConnectSuccess()
      await p

      const roomPromise = mgr.createRoom()
      triggerSubscribeSuccess()
      const roomId = await roomPromise
      expect(roomId).toMatch(/^[A-Z2-9]{6}$/)
      expect(mockGoEasy.pubsub.subscribe).toHaveBeenCalledWith(
        expect.objectContaining({ channel: `monopoly-${roomId}` }),
      )
      expect(mgr.getIsHost()).toBe(true)
      mgr.destroy()
    })

    it('订阅超时 reject', async () => {
      const mgr = new GoEasyManager()
      const p = mgr.initialize('P1')
      triggerConnectSuccess()
      await p
      const roomPromise = mgr.createRoom()
      vi.advanceTimersByTime(15000)
      await expect(roomPromise).rejects.toThrow('创建房间超时')
      mgr.destroy()
    })
  })

  describe('connectToRoom', () => {
    it('加入成功后广播 player-join 并触发 connection handler', async () => {
      const mgr = new GoEasyManager()
      const p = mgr.initialize('P2')
      triggerConnectSuccess()
      await p

      const onConn = vi.fn()
      mgr.onConnection(onConn)
      const joinPromise = mgr.connectToRoom('ABC123')
      triggerSubscribeSuccess()
      await joinPromise

      expect(mgr.getIsHost()).toBe(false)
      expect(mockGoEasy.pubsub.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'monopoly-ABC123',
          message: expect.stringContaining('player-join'),
        }),
      )
      expect(onConn).toHaveBeenCalledWith('ABC123')
      mgr.destroy()
    })

    it('订阅失败 reject', async () => {
      const mgr = new GoEasyManager()
      const p = mgr.initialize('P2')
      triggerConnectSuccess()
      await p
      const joinPromise = mgr.connectToRoom('ABC123')
      const opts = mockGoEasy.pubsub.subscribe.mock.calls[mockGoEasy.pubsub.subscribe.mock.calls.length - 1][0]
      opts?.onFailed?.({ code: 'SUB_FAIL' })
      await expect(joinPromise).rejects.toThrow('加入房间失败')
      mgr.destroy()
    })
  })

  describe('消息处理（handleIncomingMessage）', () => {
    async function setupConnected() {
      const mgr = new GoEasyManager()
      const p = mgr.initialize('Host')
      triggerConnectSuccess()
      await p
      const roomPromise = mgr.createRoom()
      triggerSubscribeSuccess()
      await roomPromise
      return mgr
    }

    it('相同 from|timestamp|type 的消息被去重', async () => {
      const mgr = await setupConnected()
      const handler = vi.fn()
      mgr.onMessage(handler)
      const onMsg = getSubscribeOnMessage()
      const content = JSON.stringify({
        type: 'game-state', payload: {}, from: 'peer1', timestamp: 12345,
      } as PeerMessage)
      onMsg?.({ content })
      onMsg?.({ content })
      expect(handler).toHaveBeenCalledTimes(1)
      mgr.destroy()
    })

    it('忽略自己发的消息', async () => {
      const mgr = await setupConnected()
      const handler = vi.fn()
      mgr.onMessage(handler)
      const onMsg = getSubscribeOnMessage()
      onMsg?.({
        content: JSON.stringify({
          type: 'game-state', payload: {}, from: mgr.getClientId(), timestamp: 1,
        } as PeerMessage),
      })
      expect(handler).not.toHaveBeenCalled()
      mgr.destroy()
    })

    it('收到 ping 自动回复 pong', async () => {
      const mgr = await setupConnected()
      const onMsg = getSubscribeOnMessage()
      onMsg?.({
        content: JSON.stringify({
          type: 'ping', payload: null, from: 'peer1', timestamp: 2,
        } as PeerMessage),
      })
      const published = mockGoEasy.pubsub.publish.mock.calls.map(c => c[0].message)
      expect(published.some(m => m.includes('"type":"pong"'))).toBe(true)
      mgr.destroy()
    })

    it('房主收到 player-join 触发 connection handler；客机不触发', async () => {
      const mgr = await setupConnected() // host
      const onConn = vi.fn()
      mgr.onConnection(onConn)
      const onMsg = getSubscribeOnMessage()
      onMsg?.({
        content: JSON.stringify({
          type: 'player-join', payload: { name: 'G1' }, from: 'guest1', timestamp: 3,
        } as PeerMessage),
      })
      expect(onConn).toHaveBeenCalledWith('guest1')

      // 切换为客机视角：不应触发 connection handler
      const onConn2 = vi.fn()
      mgr.setIsHost(false)
      mgr.onConnection(onConn2)
      onMsg?.({
        content: JSON.stringify({
          type: 'player-join', payload: { name: 'G2' }, from: 'guest2', timestamp: 4,
        } as PeerMessage),
      })
      expect(onConn2).not.toHaveBeenCalled()
      mgr.destroy()
    })

    it('非法 JSON 不抛异常', async () => {
      const mgr = await setupConnected()
      const onMsg = getSubscribeOnMessage()
      expect(() => onMsg?.({ content: 'not-json{{{' })).not.toThrow()
      mgr.destroy()
    })

    it('destroy 后忽略所有消息', async () => {
      const mgr = await setupConnected()
      const handler = vi.fn()
      mgr.onMessage(handler)
      const onMsg = getSubscribeOnMessage()
      mgr.destroy()
      onMsg?.({
        content: JSON.stringify({
          type: 'game-state', payload: {}, from: 'peer1', timestamp: 5,
        } as PeerMessage),
      })
      expect(handler).not.toHaveBeenCalled()
    })
  })

  describe('发布与重连', () => {
    it('publish 失败时非心跳消息进入重试队列并触发重连', async () => {
      const mgr = new GoEasyManager()
      const p = mgr.initialize('P1')
      triggerConnectSuccess()
      await p
      const roomPromise = mgr.createRoom()
      triggerSubscribeSuccess()
      await roomPromise

      const statusHandler = vi.fn()
      mgr.onConnectionStatusChange(statusHandler)

      // 让下一次 publish 失败
      mockGoEasy.pubsub.publish.mockImplementationOnce((opts: any) => {
        opts.onFailed?.({ code: 'ERR' })
      })
      mgr.broadcast({ type: 'game-state', payload: { x: 1 } })

      expect(statusHandler).toHaveBeenCalledWith('reconnecting', expect.any(String))
      mgr.destroy()
    })

    it('broadcast 自动填充 from 与 timestamp', async () => {
      const mgr = new GoEasyManager()
      const p = mgr.initialize('P1')
      triggerConnectSuccess()
      await p
      const roomPromise = mgr.createRoom()
      triggerSubscribeSuccess()
      await roomPromise

      mockGoEasy.pubsub.publish.mockClear()
      mgr.broadcast({ type: 'chat', payload: { text: 'hi' } })
      const call = mockGoEasy.pubsub.publish.mock.calls[0][0]
      const content = JSON.parse(call.message)
      expect(content.from).toBe(mgr.getClientId())
      expect(content.timestamp).toBeGreaterThan(0)
      expect(content.type).toBe('chat')
      mgr.destroy()
    })
  })

  describe('在线玩家跟踪', () => {
    it('trackPeer/untrackPeer/getConnectedPeers 基本流程', () => {
      const mgr = new GoEasyManager()
      mgr.trackPeer('peer1')
      mgr.trackPeer('peer2')
      expect(mgr.getConnectionCount()).toBe(2)
      expect(mgr.getConnectedPeers()).toEqual(expect.arrayContaining(['peer1', 'peer2']))
      mgr.untrackPeer('peer1')
      expect(mgr.getConnectionCount()).toBe(1)
    })
  })

  describe('destroy', () => {
    it('清理资源：退订频道、断开连接、清空 handlers、重置 sdk 状态', async () => {
      const mgr = new GoEasyManager()
      const p = mgr.initialize('P1')
      triggerConnectSuccess()
      await p
      const roomPromise = mgr.createRoom()
      triggerSubscribeSuccess()
      await roomPromise

      mgr.onMessage(() => {})
      mgr.onConnection(() => {})
      mgr.destroy()

      expect(mockGoEasy.pubsub.unsubscribe).toHaveBeenCalled()
      expect(mockGoEasy.disconnect).toHaveBeenCalled()
      expect((GoEasyManager as any).sdkInitialized).toBe(false)
    })
  })
})
