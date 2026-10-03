import { Suspense } from 'react'
import { Posts } from '@/components/posts'

export const metadata = { title: 'Konten' }

/** Posts reads its tab and filters from the URL, which needs a Suspense boundary to prerender. */
export default function Page() {
  return <Suspense><Posts /></Suspense>
}
