// PeerJS 本地信令服务器
// 用于本地开发测试，替代 PeerJS 云服务器（国内可能无法访问）
// 启动: npx tsx peer-server.ts
import { PeerServer } from 'peer'

const PORT = 9000

PeerServer({
  port: PORT,
  path: '/',
}, () => {
  console.log(`🔌 PeerJS 信令服务器已启动: ws://localhost:${PORT}`)
  console.log('   保持此终端运行，在另一个终端启动 npm run dev')
})
