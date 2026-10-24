import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import YAML from 'js-yaml'

const sourcePath = fileURLToPath(new URL('../openapi.yaml', import.meta.url))
const destinationPath = fileURLToPath(new URL('../openapi.json', import.meta.url))
const readmePath = fileURLToPath(new URL('../README.md', import.meta.url))

/**
 * Renders the committed `openapi.json` from `openapi.yaml`.
 *
 * Exported (rather than inlined in the CLI) so `tests/openapi.test.ts` can
 * assert that the committed JSON is exactly what the generator produces — the
 * spec is auto-published from openapi.json on every push, so a stale committed
 * file is a broken public contract even though the source YAML looks right.
 *
 * Deterministic by construction: `js-yaml` preserves document key order and
 * `JSON.stringify` is stable for a fixed object, so the same YAML always yields
 * byte-identical output. The test runs it twice to guarantee that.
 */
export function renderOpenApiJson(yamlSource?: string): string {
  const source = yamlSource ?? readFileSync(sourcePath, 'utf8')
  const document = YAML.load(source)
  return JSON.stringify(document, null, 2) + '\n'
}

/**
 * Renders README.md with its generated sections (the REST endpoint table from
 * `openapi.yaml`, plus the venue table) refreshed.
 *
 * The rendering itself lives in `scripts/generate-readme.ts` (`npm run
 * readme:gen`), the single owner of the README's `<!-- ENDPOINTS:START -->`
 * block; this wrapper only lets `openapi:gen` / `openapi:check` cover the
 * README too, so editing the spec and running one command keeps every
 * spec-derived artifact in step. Imported lazily because the venue table pulls
 * in the ingest registry (and with it the Prisma client), which
 * `renderOpenApiJson` callers do not need.
 */
async function renderReadmeFromSpec(readmeSource: string): Promise<string> {
  const { renderReadme } = await import('./generate-readme')
  return renderReadme(readmeSource)
}

/** Normalises CRLF so a Windows checkout does not read as drift. */
function normaliseNewlines(value: string): string {
  return value.replace(/\r\n/g, '\n')
}

/** Regenerates `openapi.json` and the README's generated tables, in place. */
export async function generateOpenApi(): Promise<void> {
  writeFileSync(destinationPath, renderOpenApiJson())
  const readme = readFileSync(readmePath, 'utf8')
  writeFileSync(readmePath, await renderReadmeFromSpec(readme))
}

/**
 * Lists committed artifacts that differ from a fresh generation.
 *
 * Empty means the tree is up to date. Used by `npm run openapi:check` in CI so
 * a hand-edited spec, JSON or README table fails the build instead of drifting.
 */
export async function checkGeneratedArtifacts(): Promise<string[]> {
  const problems: string[] = []

  if (renderOpenApiJson() !== normaliseNewlines(readFileSync(destinationPath, 'utf8'))) {
    problems.push('openapi.json does not match openapi.yaml')
  }

  const readme = normaliseNewlines(readFileSync(readmePath, 'utf8'))
  if ((await renderReadmeFromSpec(readme)) !== readme) {
    problems.push('README generated tables do not match openapi.yaml / the venue registry')
  }

  return problems
}

// Run only when invoked directly (`npm run openapi:gen` / `openapi:check`),
// not when imported by the test.
async function main(): Promise<void> {
  if (process.argv.includes('--check')) {
    const problems = await checkGeneratedArtifacts()
    if (problems.length > 0) {
      console.error(`Generated API artifacts are stale:\n  - ${problems.join('\n  - ')}`)
      console.error('Run `npm run openapi:gen` and commit the result.')
      process.exit(1)
    }
    console.log('openapi.json and the README endpoint table are up to date')
  } else {
    await generateOpenApi()
    console.log('Generated openapi.json and the README endpoint table')
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(error => {
    console.error(error)
    process.exit(1)
  })
}
