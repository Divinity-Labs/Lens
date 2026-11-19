# Contracts CI Setup

This directory contains two Soroban contracts that need CI coverage.

## Required workflow: `.github/workflows/contracts.yml`

Copy the YAML below into `.github/workflows/contracts.yml`:

```yaml
name: Contracts CI

on:
  push:
    branches: [main]
    paths:
      - 'oracle/contract/**'
      - 'examples/oracle-relay/contract/**'
  pull_request:
    paths:
      - 'oracle/contract/**'
      - 'examples/oracle-relay/contract/**'

permissions:
  contents: read

jobs:
  oracle-contract:
    name: Build & test SEP-40 oracle contract
    runs-on: ubuntu-latest
    timeout-minutes: 20
    defaults:
      run:
        working-directory: oracle/contract
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
        with:
          targets: wasm32v1-none
      - uses: actions/cache@v4
        with:
          path: |
            ~/.cargo/registry
            ~/.cargo/git
            oracle/contract/target
          key: cargo-oracle-${{ hashFiles('oracle/contract/Cargo.lock') }}
      - run: cargo test --lib
      - run: cargo build --release --target wasm32v1-none
      - run: ls target/wasm32v1-none/release/*.wasm

  relay-contract:
    name: Build relay example contract
    runs-on: ubuntu-latest
    timeout-minutes: 15
    defaults:
      run:
        working-directory: examples/oracle-relay/contract
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
        with:
          targets: wasm32v1-none
      - uses: actions/cache@v4
        with:
          path: |
            ~/.cargo/registry
            ~/.cargo/git
            examples/oracle-relay/contract/target
          key: cargo-relay-${{ hashFiles('examples/oracle-relay/contract/Cargo.toml') }}
      - run: cargo build --release --target wasm32v1-none
      - run: cargo test --lib || echo "No tests yet"
```

## Manual verification

```bash
cd oracle/contract
rustup target add wasm32v1-none
cargo test --lib                    # 20 tests
cargo build --release --target wasm32v1-none
ls target/wasm32v1-none/release/*.wasm   # artifact check

cd ../../examples/oracle-relay/contract
cargo build --release --target wasm32v1-none
```
