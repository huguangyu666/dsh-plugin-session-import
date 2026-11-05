import { readdirSync } from 'node:fs'
import { join } from 'node:path'

/** Resolve a lossy project slug against existing directories. */
export function decodeSlugPath(slug) {
  const drive = slug.match(/^([a-z])--/i)
  const root = drive ? `${drive[1]}:\\` : slug.startsWith('-') ? '/' : undefined
  if (!root || (drive && process.platform !== 'win32')) return undefined
  const rest = slug.slice(drive ? 3 : 1)
  const ambiguous = Symbol('ambiguous')
  const visit = (dir, remaining) => {
    if (!remaining) return dir
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return undefined }
    const candidates = new Set()
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
      for (const encoded of new Set([entry.name.replace(/[._]/g, '-'), entry.name.replace(/[^a-zA-Z0-9]/g, '-')])) {
        const matches = process.platform === 'win32'
          ? remaining.toLowerCase().startsWith(encoded.toLowerCase())
          : remaining.startsWith(encoded)
        if (!matches || (remaining.length > encoded.length && remaining[encoded.length] !== '-')) continue
        const next = remaining.slice(encoded.length)
        const found = visit(join(dir, entry.name), next ? next.slice(1) : '')
        if (found === ambiguous) return ambiguous
        if (found) candidates.add(found)
        if (candidates.size > 1) return ambiguous
      }
    }
    return candidates.size === 1 ? [...candidates][0] : undefined
  }
  const resolved = visit(root, rest)
  return resolved === ambiguous ? undefined : resolved
}
