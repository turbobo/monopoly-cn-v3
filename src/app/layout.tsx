import type { Metadata, Viewport } from 'next'
import { Noto_Sans_SC } from 'next/font/google'
import './globals.css'

const notoSansSC = Noto_Sans_SC({
  subsets: ['latin'],
  weight: ['300', '400', '500', '700', '900'],
  display: 'swap',
  variable: '--font-noto',
})

export const metadata: Metadata = {
  title: '大富翁中国行 - 经典桌游精简版',
  description: '掷骰子、买地皮、收租金，和AI或好友来一场中国城市大富翁之旅',
  icons: { icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect fill="%231a2332" width="1" height="1"/></svg>' },
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: 'cover',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" className={notoSansSC.variable}>
      <body className={notoSansSC.className}>{children}</body>
    </html>
  )
}
