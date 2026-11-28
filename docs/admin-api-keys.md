# Managing API keys

All `/admin/keys` routes require the `ADMIN_TOKEN` configured by the operator.
The token can be sent in `X-Admin-Token` or as a bearer token.

`GET /admin/keys` returns the live keys by default. It returns key identifiers,
labels, scopes, rate and quota settings, creation time, expiry, last-used time
(`lastUsedAt`, null if the key has never authenticated) and revocation state; it
never returns the stored hash or plaintext key.

Pagination uses `limit` and `offset`. The default page size is 50 and the
maximum is 100. Set `revoked=true` to list revoked keys instead; the default
`revoked=false` view hides them.

```http
GET /admin/keys?limit=50&offset=0&revoked=false
X-Admin-Token: <admin-token>
```

The response contains a `keys` array and `pagination` metadata including the
total number of records matching the revoked filter.

## Named admin credentials

`ADMIN_TOKEN` is one secret shared by everyone, so nothing it does can be
attributed to a person and it cannot be revoked for one person. Named admin
credentials fix both. They are accepted in the same places as `ADMIN_TOKEN`
(`X-Admin-Token`, or `Authorization: Bearer`).

```http
POST /admin/credentials
X-Admin-Token: <ADMIN_TOKEN or an existing admin_ credential>
Content-Type: application/json

{ "name": "alice" }
```

The response contains the credential (`admin_` followed by 48 hex characters)
exactly once; only its hash is stored. Names are unique (`409` on a repeat).
`GET /admin/credentials` lists them without secrets, and
`DELETE /admin/credentials/:id` revokes one.

`ADMIN_TOKEN` keeps working and is attributed as `legacy-admin`. It is also the
bootstrap secret you use to create the first named credential, so migrate by
creating one per admin, then unset `ADMIN_TOKEN` once nobody depends on it. A
server with no `ADMIN_TOKEN` still accepts a valid named credential; anything
else gets `503 admin_not_configured`.

## Key lifetime

A new key expires `API_KEY_DEFAULT_LIFETIME_DAYS` days after creation (default
365). Set it to `0` for keys that never expire, or pass `expiresAt` to
`POST /admin/keys` to choose a date for one key. Each key records the admin who
created it in `created_by_admin_id`.
