// 跨组件共享的 UI 类型（由 page.tsx 与各面板组件共同引用）

/** 界面状态：主菜单 / 设置 / 在线大厅 / 游戏进行 / 结算 */
export type Screen = 'menu' | 'setup' | 'lobby' | 'game' | 'end'

/** 游戏模式：AI 对战 / 本地同屏 / 在线对战 */
export type GameMode = 'ai' | 'local' | 'online'

/** 在线模式角色 */
export type OnlineRole = 'host' | 'guest' | null

/** 在线房间内的玩家信息 */
export interface OnlinePlayer {
  id: string
  name: string
  isHost: boolean
}
