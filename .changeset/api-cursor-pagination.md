---
'lens': minor
---

Add cursor-and-limit pagination to every list route — `GET /pools`,
`GET /pairs`, `GET /candles/:assetA/:assetB` and `GET /prices/history` — matching
the convention `GET /screener` already used. Each accepts `?cursor=` and
`?limit=` (absent limit → the route default, out-of-range values clamped, a
non-numeric limit is a 400) and now returns `nextCursor` + `hasMore` beside its
own key (`pools`, `pairs`, `candles`, `points`), so an unpaged caller still gets
a sensible first page. `GET /prices/history?format=csv` carries the same
envelope in the `X-Next-Cursor` / `X-Has-More` response headers, keeping the CSV
body the byte-stable `ts,price,volume` contract.

Pagination is keyset-based, not offset-based: the cursor is an opaque base64
`[sortValue, id]` and the predicate is `(sort, id) > (value, id)` (or `<` for
descending), so a row inserted while a client is paging can never shift a page
boundary and cause a duplicate or a skipped row. The shared helpers live in
`src/pagination.ts`; the per-route default/maximum page sizes are 50/200
(`/pools`, `/pairs`), 500/5000 (`/candles`), 1000/10000 (`/prices/history`) and
20/100 (`/screener`), documented in `openapi.yaml` and exercised by a
mid-page-insert regression test.
