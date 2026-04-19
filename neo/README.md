# Neo.ak — On-Chain TWAP Verifier

An Aiken withdrawal validator that verifies a **Time-Weighted Average Price** entirely on-chain, using COMB Oracle UTxOs as reference inputs. No off-chain trust required.

## How it works

Any transaction that needs a verified TWAP must:

1. Include several COMB price UTxOs as **reference inputs** (read-only, no spend)
2. Attach a **withdrawal of 0 ADA** from the Neo stake address
3. Provide a `NeoRedeemer` describing the selected points and the claimed mean

The validator checks:
- Selected price UTxOs carry valid COMB tokens
- Timestamps form an **arithmetic sequence** (evenly spaced by `granularity`)
- The newest price is **fresh** (within 2× interval of tx lower bound)
- `claimed_mean == floor(sum(prices) / count)` — integer arithmetic, no rounding ambiguity

## Setup

```bash
npm install
cp .env.example .env

# 1. Build the Aiken validator (in ../comb/onchain)
cd ../comb/onchain && aiken build && cd ../../neo

# 2. Register staking credential (one-time, 2 ADA deposit)
npm run neo -- register config.yml

# 3. Submit a TWAP verification tx
npm run neo -- config.yml
```

## Granularity

The `granularity` field controls which price points are sampled:

| Granularity | Points (count=5) | Effective window |
|-------------|-----------------|-----------------|
| 600,000 ms  | every 10 min    | 40 minutes      |
| 3,600,000   | every 1 hour    | 4 hours         |
| 86,400,000  | every 24 hours  | 4 days          |

The validator auto-detects the smallest valid granularity that produces the requested number of evenly-spaced on-chain points.

## On-chain validator

The validator lives at [`../comb/onchain/validators/neo.ak`](../comb/onchain/validators/neo.ak) and is compiled as part of the same Aiken project as the COMB oracle.

## Parameters

The Neo validator is parameterised at deploy time with:
- `comb_policy_id` — minting policy of the COMB Oracle (from `npm run deploy`)
- `interval` — base interval in ms (e.g. `600000` for 10 minutes)
