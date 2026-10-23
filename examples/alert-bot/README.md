# Price Alert Bot Example

A minimal "if XLM > X notify me" bot for issue #100.

It connects to the Lens WebSocket price stream (`/ws`), watches a single
asset pair, and fires a notification the moment the price crosses your
threshold. Optionally it forwards each alert to an HTTPS URL (Slack,
Discord, your own service) signed with HMAC-SHA256 — the same delivery
path Lens uses for server-side webhooks.

## Files

- `alert-bot.ts` runs the bot.

## Environment

| Variable | Default | Description |
|---|---|---|
| `ALERT_BOT_WS_URL` | `ws://localhost:3002/ws` | Lens WebSocket endpoint |
| `ALERT_BOT_ASSET_A` | `XLM` | Base asset to watch |
| `ALERT_BOT_ASSET_B` | `USDC` | Quote asset |
| `ALERT_BOT_THRESHOLD` | — | Price level to alert on (required, e.g. `0.15`) |
| `ALERT_BOT_DIRECTION` | `above` | `above` or `below` |
| `ALERT_BOT_PAYMENT` | — | Optional base64 `X-PAYMENT` for x402-gated streams |
| `ALERT_BOT_NOTIFY_URL` | — | Optional HTTPS URL to POST alerts to |
| `ALERT_BOT_NOTIFY_SECRET` | `alert-bot` | HMAC secret for the notify URL |

## Run

```bash
npm run alert:bot
```

The bot supports `--help` for usage and `--once` to exit after the first
alert fires (handy for testing).

See the full walkthrough in [docs/cookbook/alert-bot.md](../../docs/cookbook/alert-bot.md).
