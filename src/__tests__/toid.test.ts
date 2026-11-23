import { ledgerFromPagingToken, resolvePageLedgers, firstPagingTokenOfLedger } from '../ingest/toid'

describe('ledgerFromPagingToken', () => {
  it('derives the ledger from real Horizon trade ids', () => {
    // Captured from GET https://horizon.stellar.org/trades?limit=1&order=desc
    // (2026-09-30) and GET .../liquidity_pools/{id}/trades. Neither response
    // carries a `ledger` field, so this prefix is the only source.
    expect(ledgerFromPagingToken('277893235979689985-0')).toBe(64702061)
    expect(ledgerFromPagingToken('277710193062797313-0')).toBe(64659443)
    expect(ledgerFromPagingToken('277889847250190337-0')).toBe(64701272)
  })

  it('takes only the TOID prefix and ignores the order suffix', () => {
    const toid = (512345n << 32n).toString()
    expect(ledgerFromPagingToken(`${toid}-0`)).toBe(512345)
    expect(ledgerFromPagingToken(`${toid}-97`)).toBe(512345)
  })

  it('returns null instead of throwing or yielding NaN for unparseable tokens', () => {
    // 'p-1' would throw SyntaxError inside BigInt() without the digit guard —
    // and PricePoint.ledger is a required Int, so NaN is not an option either.
    for (const token of ['p-1', 't-1', '', '123', 'abc-0', '-1', '  12-0', null, undefined]) {
      expect(ledgerFromPagingToken(token as any)).toBeNull()
    }
  })

  it('rejects a TOID whose high bits are zero', () => {
    expect(ledgerFromPagingToken('0-0')).toBeNull()
    expect(ledgerFromPagingToken('4294967295-0')).toBeNull()
  })
})

describe('resolvePageLedgers', () => {
  it('returns one ledger per record when every token parses', () => {
    const ledgers = resolvePageLedgers(
      ['277893235979689985-0', '277710193062797313-0'],
      null,
    )
    expect(ledgers).toEqual([64702061, 64659443])
  })

  it('borrows the first parseable ledger for a malformed leading token', () => {
    const ledgers = resolvePageLedgers(['not-a-toid', '277893235979689985-0'], null)
    expect(ledgers).toEqual([64702061, 64702061])
  })

  it('falls back to the previously stored ledger when nothing parses', () => {
    expect(resolvePageLedgers(['p-1', 't-1'], 512345)).toEqual([512345, 512345])
  })

  it('returns null when no ledger can be established at all', () => {
    // The caller must skip the batch rather than write a fabricated ledger.
    expect(resolvePageLedgers(['p-1'], null)).toBeNull()
    expect(resolvePageLedgers([], null)).toBeNull()
  })
})

describe('firstPagingTokenOfLedger', () => {
  it('is the inverse of ledgerFromPagingToken', () => {
    for (const ledger of [1, 512345, 64702061]) {
      expect(ledgerFromPagingToken(firstPagingTokenOfLedger(ledger))).toBe(ledger)
    }
  })

  it('sorts below every real trade token in its own ledger', () => {
    // Horizon puts the transaction and operation index in the TOID's low bits,
    // so a paging cursor at `ledger << 32` excludes nothing from that ledger —
    // which is what lets a backfill start mid-history without losing an edge.
    for (const token of [
      '277893235979689985-0',
      '277889847250190337-0',
      `${(512345n << 32n) + 1n}-0`,
    ]) {
      const ledger = ledgerFromPagingToken(token)
      const floor = firstPagingTokenOfLedger(ledger as number)
      expect(BigInt(token.split('-')[0])).toBeGreaterThan(BigInt(floor.split('-')[0]))
      expect(ledgerFromPagingToken(floor)).toBe(ledger)
    }
  })

  it('refuses a sequence it cannot encode', () => {
    expect(() => firstPagingTokenOfLedger(-1)).toThrow(RangeError)
    expect(() => firstPagingTokenOfLedger(1.5)).toThrow(RangeError)
    expect(() => firstPagingTokenOfLedger(Number.MAX_SAFE_INTEGER + 1)).toThrow(RangeError)
  })
})
