import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import fp from 'fastify-plugin'
import crypto from 'crypto'

export interface CachingOptions {}

function determineCacheControl(url: string, method: string): string {
  if (method !== 'GET' && method !== 'HEAD') {
    return 'no-store'
  }

  // Per-caller authenticated / personal data
  if (url.startsWith('/usage') || url.startsWith('/admin') || url.startsWith('/keys')) {
    return 'no-store, private'
  }

  // Immutable or closed historical data
  if (
    url.includes('/candles') ||
    url.includes('/history') ||
    url.includes('window=30d')
  ) {
    return 'public, max-age=86400, immutable'
  }

  // Slowly-changing list routes
  if (
    url.startsWith('/pairs') ||
    url.startsWith('/pools') ||
    url.startsWith('/discovery') ||
    url.startsWith('/pegs') ||
    url.startsWith('/rates')
  ) {
    return 'public, max-age=60'
  }

  // Dynamic live prices / depth / tickers / movers
  return 'public, max-age=5, stale-while-revalidate=10'
}

const cachingPlugin: FastifyPluginAsync<CachingOptions> = async (app: FastifyInstance) => {
  app.addHook('onSend', async (req, reply, payload) => {
    // 1. Set Cache-Control if not already explicitly set
    if (!reply.getHeader('cache-control')) {
      const cacheControl = determineCacheControl(req.url, req.method)
      reply.header('cache-control', cacheControl)
    }

    // 2. Only compute ETag for GET/HEAD with successful 200 response and payload
    if ((req.method === 'GET' || req.method === 'HEAD') && reply.statusCode === 200 && payload !== undefined) {
      // ETag is strong hash of payload content
      const content = typeof payload === 'string' ? payload : (Buffer.isBuffer(payload) ? payload : JSON.stringify(payload))
      const hash = crypto.createHash('sha256').update(content).digest('hex')
      const etag = `"${hash}"`
      reply.header('etag', etag)

      // 3. Conditional request evaluation (If-None-Match)
      const ifNoneMatch = req.headers['if-none-match']
      if (ifNoneMatch) {
        // Handle comma-separated, weak prefix W/, or exact match
        const matches = ifNoneMatch.split(',').map(s => s.trim())
        const isMatched = matches.some(match => {
          if (match === '*') return true
          const normalized = match.replace(/^W\//, '')
          return normalized === etag
        })

        if (isMatched) {
          reply.code(304)
          return ''
        }
      }
    }

    return payload
  })
}

export const registerCaching = fp(cachingPlugin, {
  name: 'caching',
  fastify: '>=4.x',
})
