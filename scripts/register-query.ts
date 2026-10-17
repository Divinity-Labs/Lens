#!/usr/bin/env tsx
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse, validate, buildSchema } from 'graphql'
import { schema } from '../src/api/schema'
import { hashQuery, registerPersistedQuery } from '../src/api/persistedQueries'

const rootDir = resolve(__dirname, '..')
const manifestDir = resolve(rootDir, 'queries')
const manifestFile = resolve(manifestDir, 'manifest.json')

function loadManifest(): Record<string, { name?: string; hash: string; query: string }> {
  if (existsSync(manifestFile)) {
    try {
      return JSON.parse(readFileSync(manifestFile, 'utf8'))
    } catch {
      return {}
    }
  }
  return {}
}

function saveManifest(data: Record<string, { name?: string; hash: string; query: string }>) {
  if (!existsSync(manifestDir)) {
    mkdirSync(manifestDir, { recursive: true })
  }
  writeFileSync(manifestFile, JSON.stringify(data, null, 2) + '\n', 'utf8')
}

export function registerQueryFromFileOrString(input: string, name?: string): { hash: string; query: string } {
  let queryText = input
  if (existsSync(input)) {
    queryText = readFileSync(input, 'utf8')
  }

  // Validate the query against the schema
  const compiledSchema = buildSchema(schema)
  const document = parse(queryText)
  const errors = validate(compiledSchema, document)
  if (errors.length > 0) {
    const messages = errors.map(e => e.message).join('; ')
    throw new Error(`Invalid GraphQL query: ${messages}`)
  }

  const hash = registerPersistedQuery(queryText)
  const manifest = loadManifest()
  manifest[hash] = {
    name: name || undefined,
    hash,
    query: queryText.trim(),
  }
  saveManifest(manifest)
  return { hash, query: queryText.trim() }
}

if (require.main === module || process.argv[1]?.endsWith('register-query.ts')) {
  const args = process.argv.slice(2)
  if (args.length === 0) {
    console.log('Usage: npx tsx scripts/register-query.ts <query-file-or-string> [operationName]')
    process.exit(0)
  }

  try {
    const input = args[0]
    const opName = args[1]
    const result = registerQueryFromFileOrString(input, opName)
    console.log(`✅ Successfully registered persisted query:`)
    console.log(`   Hash: ${result.hash}`)
    if (opName) console.log(`   Name: ${opName}`)
    console.log(`   Manifest updated at: ${manifestFile}`)
  } catch (err: any) {
    console.error(`❌ Failed to register query: ${err.message}`)
    process.exit(1)
  }
}
