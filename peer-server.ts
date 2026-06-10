// PeerJS 本地信令服务器
// 用于本地开发测试，替代 PeerJS 云服务器（国内可能无法访问）
// 启动: npx tsx peer-server.ts
import { PeerServer } from 'peer'

const PORT = 9000

const server = PeerServer({
  port: PORT,
  path: '/peerjs',
  allow_discovery: true,
}, () => {
  console.log(`🔌 PeerJS 信令服务器已启动: ws://localhost:${PORT}/peerjs`)
  console.log('   保持此终端运行，在另一个终端启动 npm run dev')
})

server.on('connection', (client: any) => {
  console.log(`✅ 客户端连接: ${client.getId()}`)
})
server.on('disconnect', (client: any) => {
  console.log(`❌ 客户端断开: ${client.getId()}`)
})
