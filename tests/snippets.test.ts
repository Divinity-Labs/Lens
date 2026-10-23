import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { renderSnippets } from '../scripts/gen-snippets'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

describe('generated snippets', () => {
  it('render deterministically', () => {
    expect(renderSnippets()).toEqual(renderSnippets())
  })

  it('committed files match the generator', () => {
    for (const [path, content] of Object.entries(renderSnippets())) {
      expect(existsSync(join(ROOT, path)), `missing ${path}`).toBe(true)
      expect(readFileSync(join(ROOT, path), 'utf8'), path).toBe(content)
    }
  })

  it('contain no placeholder hosts or addresses', () => {
    for (const content of Object.values(renderSnippets())) {
      expect(content).not.toMatch(/example\.com|localhost|REPLACE|your-oracle/)
    }
  })
})
