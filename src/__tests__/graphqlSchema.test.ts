import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { buildSchema, printSchema } from 'graphql'
import { schema, getCanonicalSchemaSDL } from '../api/schema'

const rootDir = resolve(__dirname, '../..')
const schemaArtifactPath = resolve(rootDir, 'schema.graphql')

describe('GraphQL Schema SDL Artifact & Drift Guard', () => {
  it('committed schema.graphql artifact exists at repository root', () => {
    expect(existsSync(schemaArtifactPath)).toBe(true)
  })

  it('committed schema.graphql matches the in-code schema with zero drift', () => {
    const committedSDL = readFileSync(schemaArtifactPath, 'utf8').replace(/\r\n/g, '\n').trim()
    const canonicalSDL = getCanonicalSchemaSDL().replace(/\r\n/g, '\n').trim()
    expect(committedSDL).toBe(canonicalSDL)
  })

  it('committed schema.graphql is valid SDL parseable by standard tooling', () => {
    const committedSDL = readFileSync(schemaArtifactPath, 'utf8')
    const parsed = buildSchema(committedSDL)
    expect(parsed).toBeDefined()

    const typeMap = parsed.getTypeMap()
    expect(typeMap.AggregatedPrice).toBeDefined()
    expect(typeMap.RouteInfo).toBeDefined()
    expect(typeMap.PriceBucket).toBeDefined()
    expect(typeMap.PriceUpdate).toBeDefined()
    expect(typeMap.Query).toBeDefined()
    expect(typeMap.Subscription).toBeDefined()
  })

  it('query root type contains all 4 queries with documentation', () => {
    const parsed = buildSchema(getCanonicalSchemaSDL())
    const queryType = parsed.getQueryType()
    expect(queryType).toBeDefined()

    const fields = queryType!.getFields()
    expect(fields.getPrice).toBeDefined()
    expect(fields.getBestRoute).toBeDefined()
    expect(fields.getPriceHistory).toBeDefined()
    expect(fields.listPairs).toBeDefined()

    expect(fields.getPrice.description).toContain('Aggregated price for a pair')
  })

  it('subscription root type contains priceUpdated stream', () => {
    const parsed = buildSchema(getCanonicalSchemaSDL())
    const subType = parsed.getSubscriptionType()
    expect(subType).toBeDefined()

    const fields = subType!.getFields()
    expect(fields.priceUpdated).toBeDefined()
    expect(fields.priceUpdated.description).toContain('Streams a PriceUpdate')
  })
})
