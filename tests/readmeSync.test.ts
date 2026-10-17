import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  renderEndpointsMarkdown,
  renderVenuesMarkdown,
  renderOpenApiJson,
  VENUES_REGISTRY,
} from '../scripts/generate-openapi'

describe('README and OpenAPI Sync Guard (#275, #229)', () => {
  const readmePath = fileURLToPath(new URL('../README.md', import.meta.url))
  const openApiJsonPath = fileURLToPath(new URL('../openapi.json', import.meta.url))

  it('committed openapi.json matches generated openapi.json byte-for-byte', () => {
    const committedJson = readFileSync(openApiJsonPath, 'utf8')
    const generatedJson = renderOpenApiJson()
    expect(committedJson).toBe(generatedJson)
  })

  it('committed README endpoints table matches openapi.yaml', () => {
    const readmeContent = readFileSync(readmePath, 'utf8')
    const match = readmeContent.match(/<!-- ENDPOINTS:START -->([\s\S]*?)<!-- ENDPOINTS:END -->/)
    expect(match).not.toBeNull()
    const committedTable = match![1].trim()
    const generatedTable = renderEndpointsMarkdown().trim()
    expect(committedTable).toBe(generatedTable)
  })

  it('committed README venue list matches canonical venue registry', () => {
    const readmeContent = readFileSync(readmePath, 'utf8')
    const match = readmeContent.match(/<!-- VENUES:START -->([\s\S]*?)<!-- VENUES:END -->/)
    expect(match).not.toBeNull()
    const committedVenues = match![1].trim()
    const generatedVenues = renderVenuesMarkdown().trim()
    expect(committedVenues).toBe(generatedVenues)
    expect(VENUES_REGISTRY.length).toBeGreaterThanOrEqual(5)
  })
})
