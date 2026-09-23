import './globals.css'
import { Inter } from 'next/font/google'

const inter = Inter({ subsets: ['latin'] })
export const metadata = { title: 'SocialPilot', description: 'Multi-account social publishing' }
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="id"><body className={inter.className}>{children}</body></html>
} 