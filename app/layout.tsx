import './globals.css'
import { Plus_Jakarta_Sans } from 'next/font/google'

const sans = Plus_Jakarta_Sans({ subsets: ['latin'], variable: '--font-sans' })
export const metadata = { title: { default: 'SocialPilot', template: '%s · SocialPilot' }, description: 'Multi-account social publishing' }
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="id" className={sans.variable}><body>{children}</body></html>
}
