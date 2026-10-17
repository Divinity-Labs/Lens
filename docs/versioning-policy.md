# API Versioning & Deprecation Policy

## Canonical Endpoints: `/v1`

As of Lens v0.2.0+, all HTTP API endpoints are mounted under the `/v1` path prefix:
- `GET /v1/price/:assetA/:assetB`
- `GET /v1/candles/:assetA/:assetB`
- `GET /v1/pairs`
- `GET /v1/screener`
- `GET /v1/venues/registry`
- `GET /v1/snapshot`
- `GET /v1/basket`
- `GET /v1/volumes/:asset`

## Unversioned Alias Compatibility

To guarantee zero breaking changes for existing integrations, all unversioned paths (`/price/...`, `/candles/...`, `/status`, etc.) remain actively served as backward-compatible aliases.

### Warning Headers on Unversioned Routes

Requests to unversioned aliases automatically receive standard HTTP deprecation advisory headers:

```http
Deprecation: true
Sunset: Wed, 31 Dec 2026 23:59:59 GMT
Link: </v1/price/XLM/USDC>; rel="successor-version"
```

## Retirement Timeline

1. **Active Coexistence:** Unversioned aliases and `/v1` endpoints answer identically and will run concurrently until at least **December 31, 2026**.
2. **Advance Notice:** Lens guarantees a minimum of 6 months advance notice before retiring any major API version or alias.
3. **Migration:** Integrators simply prefix existing path requests with `/v1/`. Request and response payloads are 100% identical.
