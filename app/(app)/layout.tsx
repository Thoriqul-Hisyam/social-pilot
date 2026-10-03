import { Shell } from '@/components/shell'

/** Every signed-in page shares the top bar, the composer and the data they load. */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return <Shell>{children}</Shell>
}
