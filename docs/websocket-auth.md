# Authenticated price WebSocket

`GET /ws` requires a valid Lens API key and validates it before completing the
WebSocket upgrade. Send the key in `Authorization: Bearer <key>` when the
client supports custom headers. Browser clients can offer the `lens` protocol
and a `lens-key.<key>` protocol; Lens selects `lens`, so the credential is
never returned as the negotiated protocol and is not placed in the URL.

```ts
const socket = new WebSocket('wss://api.example.com/ws', [
  'lens',
  `lens-key.${apiKey}`,
])
```

The default maximum is five concurrent price streams per API key and process.
Set `WS_MAX_CONNECTIONS_PER_KEY` to an integer from 1 to 1000 to change it.
Connections count against the key's slot until the socket closes. The
validated key metadata is attached to the Fastify request, allowing the same
per-key identity and quota context used by HTTP routes to be applied here. Each
opened stream records 50 cents against the key's daily and monthly usage, which
matches the existing `$0.50` stream price. A stream is rejected before upgrade
when that charge would exceed the configured key quota.

The API key is never accepted from a query parameter. The
`Sec-WebSocket-Protocol` header is redacted from request logs because browser
clients use it to carry the credential.
