# Contributing to Lens

Lens is a unified Stellar price oracle aggregating SDEX and AMM prices, gated behind x402 micropayments. Contributions welcome — docs, tests, new endpoints, ingestion improvements.

## Ways to contribute

- **Good first issues** — [`good first issue`](https://github.com/Divinity-Labs/Lens/labels/good%20first%20issue)
- **Bug reports** — use the [bug report template](.github/ISSUE_TEMPLATE/bug_report.md)
- **Feature requests** — use the [feature request template](.github/ISSUE_TEMPLATE/feature_request.md)
- **Tests** — see [`area:tests`](https://github.com/Divinity-Labs/Lens/labels/area%3Atests)

## Repository layout

```
lens/
├── src/
│   ├── index.ts            # Fastify entry point
│   ├── config.ts           # Per-network config (STELLAR_NETWORK + overrides)
│   ├── db.ts               # Postgres pool / Prisma client
│   ├── api/                # REST + GraphQL route implementations
│   ├── routes/             # Additional REST route modules
│   ├── ingest/             # Venue/oracle adapters + ingester loops (SDEX, Horizon AMM, Soroswap, Aquarius, Reflector)
│   ├── publish/            # SEP-40 publisher: encoding, publication policy, on-chain feed
│   ├── aggregator/         # VWAP + best-route calculation
│   ├── pricing/            # TWAP, depth and aggregate helpers
│   ├── middleware/         # Network selector, x402, auth, metrics
│   └── x402/               # x402 facilitator client + metering
├── oracle/
│   └── contract/           # Soroban SEP-40 price feed contract (Rust, `cargo test --lib`)
├── clients/
│   ├── typescript/         # Typed openapi-fetch client (generated schema.d.ts)
│   └── python/             # Minimal Python SDK
├── prisma/
│   └── schema.prisma       # Network-discriminated data models
├── tests/                  # Integration, load and property suites (~32 test files)
└── docs/                   # Architecture, ops and design docs
```

## Development setup

### Prerequisites
- **Node.js 22** (CI workflows and Dockerfile pin this version)
- **PostgreSQL** (local or Supabase)
- **Redis** (optional — for BullMQ workers)
- A Stellar testnet account for x402 payments (if testing paid endpoints)

### Clone and install

```bash
git clone https://github.com/Divinity-Labs/Lens.git
cd Lens
npm ci                     # reproducible install from package-lock.json (what CI uses)
cp .env.example .env       # fill in DATABASE_URL, REDIS_URL, WATCHED_PAIRS
npm run db:migrate         # apply committed migrations (prisma migrate dev) — do NOT `db push`
npm run dev
```

API runs on `http://localhost:3002`.

### Environment variables
- `DATABASE_URL` — Postgres connection string (Supabase or local)
- `REDIS_URL` — optional, enables aggregate refresh worker
- `WATCHED_PAIRS` — comma-separated `CODE:ISSUER/CODE:ISSUER` (e.g. `XLM:native/USDC:GBBD...`)
- `STELLAR_NETWORK` — this instance's default network, `testnet` or `mainnet` (default: `testnet`)
- `ENABLED_NETWORKS` — optional, comma-separated networks to ingest (`testnet,mainnet`); falls back to `STELLAR_NETWORK`

Per-network overrides use a `_TESTNET` / `_MAINNET` suffix (e.g. `HORIZON_URL_MAINNET`, `WATCHED_PAIRS_TESTNET`); see `.env.example` for the full list.

## Generated files (CI checks byte-for-byte equality)

Five outputs are machine-generated. If you change their source, regenerate before committing:

| File | Command | Source |
|------|---------|--------|
| `openapi.json` / `openapi.yaml` | `npm run openapi:gen` | Route metadata in `src/` |
| `README.md` (auto sections) | `npm run readme:gen` | Spec + templates |
| `schema.graphql` | `npm run graphql:schema:gen` | Type defs in `src/api/graphql` |
| `clients/typescript/src/schema.d.ts` | `npm run client:gen` | `openapi.yaml` |
| Prisma baseline migration | `npx prisma migrate dev` | `prisma/schema.prisma` |

CI diffs these against HEAD; a mismatch fails the build. Run `--check` variants (`readme:check`, `client:typecheck`) locally to catch drift early.

### Windows line endings

If a "identical file changed" diff appears in CI but your local edit looks correct, you likely have CRLF conversion enabled. Set `core.autocrlf=input` (or rely on `.gitattributes`) and re-checkout:

```bash
git config core.autocrlf input
git checkout -- <file>
```

## Commit conventions

- `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`
- Keep PRs focused

## Before opening a PR

```bash
npx prisma generate
npx tsc --noEmit
npm run build
npm test --if-present
```

Also verify generated files are current (see table above).

## Testing

Run the full suite:

```bash
npm test
```

The suite covers integration, unit, load and property-based tests across ~32 test files. CI uses `pool: forks` isolation — each file gets its own process to avoid env leakage.

### Dropped-tests guard

CI runs a `check-dropped-tests.mjs` script that compares test-file counts between base and head. Removing a test file without adding the `tests-removed-intentionally` label will fail the workflow. If you intentionally delete a suite, add that label to your PR.
