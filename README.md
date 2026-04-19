# COMB Oracle

**Oracle Tooling Track** · Live demo: [raul.it/comb](https://raul.it/comb)

COMB Oracle is a suite of open-source tools for building **Time-Weighted Average Price (TWAP)** feeds on Cardano, powered by [Charli3](https://charli3.io) pull oracle data. Every 10 minutes a new price point is anchored on-chain in a UTxO; any contract that needs a TWAP can consume those UTxOs as reference inputs — no trusted intermediary, fully verifiable on-chain.

![comb oracle](https://github.com/elRaulito/COMB-oracle/blob/main/dashboard/comb_oracle.png)

---

## Architecture overview

```
Charli3 Nodes ──► [Gunblade] ──► AggState UTxO (pull oracle)
                                        │
                               [COMB offchain] ──► Price chain UTxOs
                                                        │
                                             [Neo.ak] reads them as
                                             reference inputs, verifies
                                             TWAP on-chain
```

---

## Tools

### 1. Gunblade — Charli3 Pull Oracle SDK

> Folder: [`gunblade/`](./gunblade)

A TypeScript/MeshJS SDK for interacting with the **Charli3 pull oracle** network.

- Contacts oracle nodes via HTTP (`/odv/feed`) to collect signed price messages
- Aggregates responses using median + IQR consensus (matching Charli3's Python logic)
- Builds and submits the on-chain **aggregation transaction** that updates the `AggState` UTxO
- Collects multi-party node co-signatures via `/odv/sign`

```
npm install
cp .env.example .env    # set BLOCKFROST_KEY
npm run agg             # trigger one aggregation cycle
```

---

### 2. COMB — Price Accumulator Smart Contract

> Folder: [`comb/`](./comb)

A **Cardano smart contract** (Aiken / Plutus V3) that accumulates price readings from the Charli3 AggState into a chain of UTxOs. Each UTxO stores one price snapshot.

- **Token name** = 8-byte big-endian POSIX timestamp → guaranteed unique, sortable
- **Datum** = `{ used: Bool, price: Int, time: Int }`
- Three lifecycle operations: **Init** (bootstrap with seed UTxO), **Update** (append new price), **Burn** (reclaim ADA from superseded UTxOs)
- Price snapshots can be consumed as **reference inputs** for daily, weekly, or monthly TWAP calculations

```
# 1. Build onchain
cd comb/onchain && aiken build

# 2. Deploy (apply parameters, write policy ID + script address to config)
cd comb/offchain && npm install
npm run deploy -- config.example.yml

# 3. Bootstrap
npm run init -- config.example.yml

# 4. Run publisher (publishes every 10 min)
npm run comb
```

---

### 3. Neo.ak — On-Chain TWAP Verifier

> Folder: [`neo/`](./neo)

An example **Aiken withdrawal validator** that verifies a claimed TWAP entirely on-chain, using COMB price UTxOs as reference inputs. No off-chain trust required.

- Accepts a `NeoRedeemer` specifying which price points to sample and the claimed mean
- Verifies timestamps form an arithmetic sequence (evenly spaced, configurable granularity)
- Verifies `claimed_mean == floor(sum(prices) / count)`
- Works for any time horizon: 1-hour, 6-hour, daily, weekly

```
# Register staking credential (one-time, 2 ADA deposit)
cd neo && npm install
npm run neo -- register

# Submit a TWAP verification transaction
npm run neo
```

---

## Live Dashboard

Explore the on-chain price history at **[raul.it/comb](https://raul.it/comb)** — a fully client-side dashboard that decodes COMB UTxOs directly from Blockfrost, displays a live price chart, and lets you compute TWAP over any time range.

The dashboard code is in [`dashboard/index.html`](./dashboard/index.html).

---

## Quick start (full stack)

```bash
# 1. Clone
git clone https://github.com/elRaulito/COMB-oracle.git
cd COMB-oracle

# 2. Build Aiken validators
cd comb/onchain && aiken build && cd ../..

# 3. Install offchain deps
cd comb/offchain && npm install && cd ../..
cd gunblade && npm install && cd ..
cd neo && npm install && cd ..

# 4. Configure
cp comb/offchain/config.example.yml comb/offchain/config.yml
# Edit config.yml: set wallet mnemonic, Charli3 oracle address/policy/nodes

# 5. Set Blockfrost key
echo "BLOCKFROST_KEY=preprod..." > comb/offchain/.env

# 6. Deploy + init COMB
cd comb/offchain
npm run deploy -- config.yml
npm run init   -- config.yml

# 7. Start publishing
npm run comb   # runs every 10 min via cron
```

---

## License

MIT
