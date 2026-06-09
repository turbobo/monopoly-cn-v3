// 测试 PeerJS 端到端连接
// 用法: node test-peer.mjs
import pkg from 'peerjs'
const { Peer } = pkg

const HOST_ID = 'test-host-' + Date.now()
const GUEST_ID = 'test-guest-' + Date.now()

const peerOptions = {
  host: 'localhost',
  port: 9000,
  path: '/peerjs',
  secure: false,
  debug: 1,
}

console.log('=== PeerJS 连接测试 ===')
console.log('Host ID:', HOST_ID)
console.log('Guest ID:', GUEST_ID)

// 创建房主
const host = new Peer(HOST_ID, peerOptions)

host.on('open', (id) => {
  console.log('✅ [Host] 已连接信令服务器, ID:', id)
  
  // 监听连接
  host.on('connection', (conn) => {
    console.log('✅ [Host] 收到来自', conn.peer, '的连接')
    conn.on('open', () => {
      console.log('✅ [Host] DataChannel 已打开')
      conn.send({ msg: 'hello from host' })
    })
    conn.on('data', (data) => {
      console.log('✅ [Host] 收到数据:', JSON.stringify(data))
      console.log('\n🎉 测试通过！PeerJS 连接正常工作')
      host.destroy()
      guest.destroy()
      process.exit(0)
    })
    conn.on('error', (err) => console.error('❌ [Host] conn error:', err))
  })
  
  // 延迟创建 guest
  setTimeout(createGuest, 1000)
})

host.on('error', (err) => {
  console.error('❌ [Host] error:', err.type, err.message)
})

let guest
function createGuest() {
  guest = new Peer(GUEST_ID, peerOptions)
  
  guest.on('open', (id) => {
    console.log('✅ [Guest] 已连接信令服务器, ID:', id)
    console.log('[Guest] 正在连接到 Host...')
    
    const conn = guest.connect(HOST_ID, { reliable: true })
    
    conn.on('open', () => {
      console.log('✅ [Guest] DataChannel 已打开')
      conn.send({ msg: 'hello from guest' })
    })
    
    conn.on('data', (data) => {
      console.log('✅ [Guest] 收到数据:', JSON.stringify(data))
    })
    
    conn.on('error', (err) => {
      console.error('❌ [Guest] conn error:', err)
    })
  })
  
  guest.on('error', (err) => {
    console.error('❌ [Guest] error:', err.type, err.message)
  })
}

// 超时
setTimeout(() => {
  console.error('\n❌ 测试超时（15秒）- 连接失败')
  if (host) host.destroy()
  if (guest) guest.destroy()
  process.exit(1)
}, 15000)
