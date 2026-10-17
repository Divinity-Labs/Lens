#!/usr/bin/env tsx
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { getCanonicalSchemaSDL } from '../src/api/schema'

const rootDir = resolve(__dirname, '..')
const targetFile = resolve(rootDir, 'schema.graphql')

const isCheck = process.argv.includes('--check')

const generatedSDL = getCanonicalSchemaSDL()

if (isCheck) {
  if (!existsSync(targetFile)) {
    console.error(`❌ Error: schema.graphql not found at ${targetFile}`)
    console.error(`Run 'npm run schema:export' to generate it.`)
    process.exit(1)
  }

  const existingSDL = readFileSync(targetFile, 'utf8').replace(/\r\n/g, '\n')
  const normalizedGenerated = generatedSDL.replace(/\r\n/g, '\n')

  if (existingSDL.trim() !== normalizedGenerated.trim()) {
    console.error(`❌ Error: schema.graphql is out of sync with src/api/schema.ts`)
    console.error(`Run 'npm run schema:export' to regenerate the GraphQL SDL artifact.`)
    process.exit(1)
  }

  console.log(`✅ schema.graphql is in sync with src/api/schema.ts`)
  process.exit(0)
} else {
  writeFileSync(targetFile, generatedSDL, 'utf8')
  console.log(`✅ Exported GraphQL schema SDL to ${targetFile}`)
}
