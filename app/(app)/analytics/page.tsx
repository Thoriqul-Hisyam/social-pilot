import { Suspense } from 'react'
import { Analytics } from '@/components/analytics'

export const metadata = { title: 'Analitik' }

/** Analytics reads its period and channel from the URL, which needs a Suspense boundary to prerender. */
export default function Page() {
  return <Suspense><Analytics /></Suspense>
}
