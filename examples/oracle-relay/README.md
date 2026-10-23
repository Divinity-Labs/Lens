# Oracle Relay Example

This example shows the smallest useful shape for issue #65:

- a Soroban contract that stores the latest price as a string
- a Node relay that reads Lens REST prices on an interval and writes the latest value on chain

## Files

- `contract/src/lib.rs` contains the contract logic
- `contract/Cargo.toml` defines the Soroban contract package
- `relay.ts` runs the polling relay

## Environment

Set these variables before running the relay:

- `ORACLE_RELAY_API_URL`
- `ORACLE_RELAY_CONTRACT_ID`
- `ORACLE_RELAY_SOURCE_SECRET`
- `ORACLE_RELAY_ASSET_A`
- `ORACLE_RELAY_ASSET_B`
- `ORACLE_RELAY_INTERVAL_MS`

## Run

```bash
npm run oracle:relay
```

The relay supports `--help` for usage and `--once` for a single update cycle.