// GoEasy 配置
// 1. 访问 https://www.goeasy.io 注册账号（手机号）
// 2. 创建应用 → 获取 App Key
// 3. 填入下方 GOEASY_APPKEY
//
// 安全说明：前端静态导出的架构决定了 App Key 必然随 bundle 公开（任何纯前端
// PubSub 方案均如此，与硬编码或环境变量无关——NEXT_PUBLIC_* 同样会内联进产物）。
// 缓解措施：
// 1. GoEasy 官网后台开启「App 安全设置」的消息内容加密（可选）
// 2. 频道名由随机 roomId 派生，外人无法猜测频道号，无法针对性监听
// 3. 业务层自带幂等去重与 Host-Authority 权威校验，恶意消息无法破坏对局状态

export const GOEASY_APPKEY = 'BC-849dcab428524333a394bbc19744e72b'
