---
'lens': patch
---

Typecheck the tests, scripts and examples too, not just `src/`.

`npm run typecheck` now runs both `tsconfig.json` and a new
`tsconfig.check.json` (which extends it, sets `noEmit`, and includes `src`,
`tests`, `scripts` and `examples` except `examples/portfolio-nav`, which has
its own dependencies), and the CI build job runs it. `npm run build` still
emits only `src/`.

The newly covered files had drifted: the Soroswap token-list tests still
asserted the pre-#329 array return instead of `FetchResult`, the README
generator listed two endpoint entries twice, and a dozen test files used
vitest globals without importing them. Those are fixed; the two `@types`
packages the scripts needed (`ws`, `js-yaml`) are now dev dependencies.
