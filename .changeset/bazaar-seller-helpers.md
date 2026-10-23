---
'lens': minor
---

Add seller-side Bazaar discovery helpers (`src/bazaar/declare.ts`): `param.*`
constructors that make per-parameter descriptions a required positional
argument, `declareHttpResource` / `declareMcpTool` builders that assemble the
`extensions.bazaar` declaration and its JSON Schema, and
`validateDeclaration` / `assertDeclaration` which run the catalog's own
`validateListing` plus seller-side metadata-quality rules so malformed listings
fail at development time rather than in production. Lens's own gated routes
(`/price`, `/candles`, `/pools`, `/price/twap`, and the MCP price tool) are
declared with them in `src/bazaar/lensListings.ts`.
