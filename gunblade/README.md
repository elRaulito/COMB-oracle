# Gunblade — Charli3 Pull Oracle SDK

TypeScript/MeshJS SDK for interacting with the Charli3 pull oracle network on Cardano.

## What it does

1. Fetches signed price messages from all oracle nodes (`/odv/feed`)
2. Applies IQR + median divergency consensus (matching Charli3's Python aggregation)
3. Builds the on-chain aggregation transaction that updates the `AggState` UTxO
4. Collects multi-party node co-signatures (`/odv/sign`) and submits

## Setup

```bash
npm install
cp .env.example .env   # set your Blockfrost key
```

Create a `config.yml` based on the COMB oracle config format (see [`comb/offchain/config.example.yml`](../comb/offchain/config.example.yml)).

## Usage

```bash
# Trigger one aggregation cycle immediately
npm run agg

# Show wallet addresses and balances
npm run addresses
```

## Files

| File | Purpose |
|------|---------|
| `src/oracle-updater.ts` | Main aggregation logic — fetches feeds, builds and submits the agg tx |
| `src/charli3-client.ts` | HTTP client for Charli3 node API (`/odv/feed`, `/odv/sign`) |
| `src/chain-reader.ts` | Blockchain decoder — reads AggState and COMB UTxO datums |
| `src/types.ts` | TypeScript type definitions |
| `src/agg.ts` | Cron entrypoint (every 10 min) |
| `src/addresses.ts` | Utility to print wallet addresses |
