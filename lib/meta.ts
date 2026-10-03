import { MetaApiError, networkError } from './errors'

/** Step name for errors, without ids: "/123/threads_publish" -> "threads_publish". */
const step = (path: string) => path.split('/').filter(Boolean).pop() ?? path

export type GraphCall = (path: string, params: Record<string, string>, method?: 'GET' | 'POST' | 'DELETE') => Promise<any>

/**
 * A caller for one of Meta's Graph APIs. Errors read "<Label> API [step code]: message",
 * carry Meta's code for classification, and fbtrace_id, which Meta support asks for.
 */
export function graphCaller(base: string, label: string): GraphCall {
  return async (path, params, method = 'POST') => {
    const res = await (method === 'POST'
      ? fetch(`${base}${path}`, { method, body: new URLSearchParams(params) })
      : fetch(`${base}${path}?${new URLSearchParams(params)}`, { method })
    ).catch((e: unknown) => { throw networkError(`${label} API [${step(path)}]`, e) })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      const err = data?.error ?? {}
      const code = [err.code, err.error_subcode].filter(v => v != null).join('/')
      const msg = err.error_user_msg ?? err.message ?? `HTTP ${res.status}`
      const trace = err.fbtrace_id ? ` (fbtrace_id ${err.fbtrace_id})` : ''
      throw new MetaApiError(`${label} API [${step(path)}${code ? ` ${code}` : ''}]: ${msg}${trace}`, err.code, err.error_subcode)
    }
    return data
  }
}

/** Reads one metric from an insights answer; a metric left out reads as 0. */
export function insightValue(data: { name: string; values?: { value?: unknown }[]; total_value?: { value?: unknown } }[] | undefined, name: string): number {
  const m = (data ?? []).find(x => x.name === name)
  return Number(m?.values?.[0]?.value ?? m?.total_value?.value ?? 0) || 0
}
