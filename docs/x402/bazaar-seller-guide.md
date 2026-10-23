# Declaring a discoverable, priced endpoint

Seller-side helpers for the x402 Bazaar discovery extension. The goal from §3.6
of the RFP: **from docs to a paid, discoverable endpoint in well under an hour.**

## Why per-parameter descriptions are the whole point

The buyer is software. An agent choosing between two price feeds cannot open
your docs — it has only what your listing declares. `GET /price/:assetA/:assetB`
tells it almost nothing. The same endpoint with each parameter's accepted form
spelled out, the response described, and the price stated is *selectable*.

Ranking (#129) can only rank on what is declared, so metadata quality is the
ceiling on search quality no matter how good the retrieval is. That is why
`description` is the **first positional argument** of every parameter
constructor, and why a declaration missing one does not validate. It is not a
warning you can ship past.

## The short version

```ts
import { declareHttpResource, assertDeclaration, param } from './bazaar/declare'

const pathParams = {
  assetA: param.string('Base asset, as "XLM" or "CODE:ISSUER".', { example: 'XLM' }),
  assetB: param.string('Quote asset, same form as assetA. Price is assetA in assetB.'),
}

export const priceListing = assertDeclaration(
  declareHttpResource({
    url: 'https://lens.example/price/:assetA/:assetB',
    method: 'GET',
    network: 'testnet',
    routeTemplate: '/price/:assetA/:assetB',
    description: 'Unified Stellar price for an asset pair, across SDEX and AMM pools.',
    accepts: [{ scheme: 'exact', amount: '100000', asset: 'USDC', payTo: PAY_TO, maxTimeoutSeconds: 60 }],
    pathParams,
    output: { type: 'object', properties: { price: { type: 'string', description: 'Mid price, decimal string.' } } },
  }),
  { pathParams, routeTemplate: '/price/:assetA/:assetB' },
)
```

That is the whole declaration. It produces a complete
`RegisterBazaarResourceInput` — resource block, `accepts`, and the
`extensions.bazaar` declaration with a proper JSON Schema — and throws at module
load if anything is wrong.

## Parameters

| Constructor | Emits |
| --- | --- |
| `param.string(description, opts?)` | `{ type: 'string', description }` |
| `param.number(description, opts?)` | `{ type: 'number', description }` |
| `param.integer(description, opts?)` | `{ type: 'integer', description }` |
| `param.boolean(description, opts?)` | `{ type: 'boolean', description }` |
| `param.enumOf(values, description, opts?)` | `{ type: 'string', enum: values, description }` |

`opts` takes `required` (default `true`), `example` and `default`. An `example`
is worth more to an agent than another sentence of prose — give it a value it
can copy.

Parameters go into `pathParams`, `queryParams` (GET/HEAD/DELETE) or `body`
(POST/PUT/PATCH); the helper picks the right slot from the method and sets
`bodyType` for you. Each set becomes a JSON Schema object with
`additionalProperties: false` and a `required` list built from the flags.

## MCP tools

Same idea, one call:

```ts
declareMcpTool({
  url: 'https://lens.example/mcp',
  network: 'testnet',
  toolName: 'get_price',
  transport: 'streamable-http',
  description: 'Unified Stellar price for an asset pair.',
  accepts,
  input: { assetA: param.string('Base asset, as "XLM" or "CODE:ISSUER".') },
})
```

## Validation happens before anything is sent

`validateDeclaration(listing, spec)` returns
`{ ok: true, listing }` or `{ ok: false, problems }`. Each problem carries the
same `{ field, code, message }` shape the catalog uses for soft drops, so what
you see locally is what the catalog would have told you — except you see it at
development time rather than in an `EXTENSION-RESPONSES` header in production.

It runs the catalog's **own** `validateListing` under the hood, so the two
cannot drift apart, then adds the rules the catalog cannot enforce because by
then the metadata is all it has:

| Code | Meaning |
| --- | --- |
| `missing_param_description` | A parameter has no description |
| `param_description_too_short` | Under 12 characters — name the accepted values, not the field |
| `weak_resource_description` | The resource description is missing or too short to rank on |
| `undeclared_route_param` | `routeTemplate` names a `:param` absent from `pathParams` |
| `missing_accepts` | No payment requirement — not discoverable as a paid endpoint |

`assertDeclaration()` is the same check that throws, listing every problem with
its field path. Call it at module load on your own listings: a malformed listing
then fails the boot, instead of quietly never appearing in the Bazaar.

## Lens's own endpoints

`src/bazaar/lensListings.ts` declares the routes `src/middleware/x402.ts` gates
— `/price/:assetA/:assetB`, `/candles/:assetA/:assetB`, `/pools` and
`/price/twap/:assetA/:assetB` — using exactly these helpers, with the MCP face
of the price feed alongside. They go through `assertDeclaration` at module load.
If declaring metadata for our own price feed were awkward, it would be awkward
for everyone, and this is where we would find that out.
