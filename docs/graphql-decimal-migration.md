# GraphQL Decimal Scalar Migration Guide

## Problem & Context

GraphQL's built-in `Float` type is an IEEE 754 64-bit double-precision floating-point number.
In Stellar, prices are stored on-chain and in Postgres as high-precision decimals (`Decimal(36, 18)`).
When long-tail assets (e.g. priced at `0.000000000000001234`) or large quantities in the billions are cast to `Float`, IEEE 754 precision limits silently round or lose significant digits.

## The Solution: `Decimal` Scalar

Lens GraphQL schema introduces a custom `Decimal` scalar:
- Serializes as a precise **string** (e.g. `"0.000000000000001234"`).
- Preserves full 18-decimal precision end-to-end through the entire query pipeline.
- Added alongside existing `Float` fields to preserve backward compatibility for legacy clients.

## Field Additions

| Existing `Float` Field | New `Decimal` Field | Type | Description |
| :--- | :--- | :--- | :--- |
| `price` | `priceDecimal` | `Decimal!` | 18-decimal aggregated price string |
| `sdexPrice` | `sdexPriceDecimal` | `Decimal` | SDEX price string |
| `ammPrice` | `ammPriceDecimal` | `Decimal` | AMM pool price string |
| `volume24h` | `volume24hDecimal` | `Decimal` | 24-hour volume string |
| `vwap24h` | `vwap24hDecimal` | `Decimal` | 24-hour VWAP string |

## Migration Steps for Integrators

### Before:

```graphql
query GetXlmPrice {
  getPrice(assetA: "XLM", assetB: "USDC") {
    price
    vwap24h
  }
}
```

### After (Recommended for Precision):

```graphql
query GetXlmPrice {
  getPrice(assetA: "XLM", assetB: "USDC") {
    priceDecimal
    vwap24hDecimal
  }
}
```

### Client-side handling:
In TypeScript / JavaScript, parse the returned string using `BigInt`, `bignumber.js`, or `@stellar/stellar-sdk`:

```ts
import BigNumber from 'bignumber.js'

const exactPrice = new BigNumber(data.getPrice.priceDecimal)
```
