---
'lens': patch
---

Add WebSocket lifecycle heartbeat, dead connection reaping, socket memory bounding, shutdown close frames, and graceful SIGTERM teardown (Closes #347, #336, #335, #330).

- **#347**: Enhanced `FanOutManager.destroy()` to gracefully close connected WebSocket clients with close code `1001` ('Server shutting down'), provide a configurable in-flight flush window, ensure full idempotency, and guarantee safety against mid-fanout calls.
- **#336**: Implemented periodic heartbeat pings with configurable interval (`WS_HEARTBEAT_INTERVAL_MS`) and max missed pings (`WS_MAX_MISSED_PINGS`). Reaps silent clients while cleaning up both `clients` and `pairClients` subscription maps, and exports `ws_connected_clients` gauge.
- **#335**: Added socket buffer inspection on `client.socket.bufferedAmount`. Coalesces intermediate price updates past soft threshold (`WS_BUFFER_THRESHOLD_BYTES`) and drops stalled clients past hard ceiling (`WS_BUFFER_MAX_BYTES`) with close code `1008` ('Buffer overflow'), exporting `ws_slow_clients_total` and `ws_messages_dropped_total`.
- **#330**: Implemented `GracefulShutdownCoordinator` in `src/shutdown.ts` responding to `SIGTERM` and `SIGINT` with strictly ordered teardown (stop HTTP/WS listeners -> stop ingesters -> close WS clients -> drain BullMQ queues/workers -> close pgPool and Redis) bounded by configurable `SHUTDOWN_GRACE_PERIOD_MS` (default 10s).
