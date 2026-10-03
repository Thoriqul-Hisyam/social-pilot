/** Resolves extensionless relative TS imports (and next/* entry points) for node --import.
 *  Next handles this natively; plain node does not. Test-only shim. */
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve as resolvePath } from 'node:path'

export async function resolve(specifier, context, next) {
  if (specifier.startsWith('.') && !/\.[a-z]+$/.test(specifier)) {
    const base = dirname(fileURLToPath(context.parentURL))
    const candidate = resolvePath(base, specifier + '.ts')
    if (existsSync(candidate)) return next(pathToFileURL(candidate).href, context)
  }
  // next ships CommonJS entry points without an exports map: next/server is next/server.js.
  if (/^next\/[a-z-]+$/.test(specifier)) return next(`${specifier}.js`, context)
  return next(specifier, context)
}
