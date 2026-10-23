# Changelog

## 0.2.0

### Minor Changes

- bbe48e4: Add `/prices/history` endpoint backed by 1-minute price snapshots. A new `price_snapshots` table is appended to every minute by a snapshot ingester, queryable over a `[from, to]` window with optional `5m`/`1h` aggregation. A retention job prunes snapshots older than 30 days.

### Patch Changes

- 5a68745: Adopt changesets for versioning and release notes. Adds `@changesets/cli`, a release GitHub Actions workflow that opens a "Version Packages" PR for pending changesets and tags releases on merge, and contributor docs for the workflow.

All notable changes to Lens are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- CI pipeline (`.github/workflows/ci.yml`) running Prisma generate, typecheck, and build on every PR
- Contributor documentation, issue templates, PR template
- This changelog

## [0.1.0] — 2025 initial deployment

### Added

- Fastify REST API with `GET /price/:assetA/:assetB`, `GET /status`, `GET /pools`
- GraphQL endpoint via Mercurius
- SDEX trade ingestion with checkpoint tracking
- AMM pool snapshot ingestion
- Best-route price calculation across SDEX and AMM
- x402 micropayment gating via `@x402/stellar`
- Prisma schema for price points, pools, and checkpoints
- BullMQ aggregate refresh worker (optional, requires Redis)
- Supabase Postgres support with scoped SSL handling
- Deployed on Render at https://lens-ldtu.onrender.com

### Fixed

- `bestRoute.ts` AMM lookup — was using broken `code:code` join format; now queries via `pool_id`
- Prisma binary target on Render (`debian-openssl-3.0.x`)
- Supabase SSL cert error (scoped to supabase.com hosts)
- BullMQ blocking startup — wrapped in try/catch, ingesters auto-restart

[Unreleased]: https://github.com/Miracle656/Lens/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Miracle656/Lens/releases/tag/v0.1.0
