/**
 * Chain reader: fetches Comb Oracle UTxOs from the blockchain and decodes their datums.
 */
import { BlockfrostProvider, UTxO, deserializeDatum } from "@meshsdk/core";
import { AggStateData, CombDatum, CombOracleConfig, NeoRedeemer, PriceNodeUtxo } from "./types";

// ── Datum decoders ────────────────────────────────────────────────────────────

/** Decode the Charli3 AggState datum from raw plutusData hex. */
export function decodeAggState(rawData: string): AggStateData {
  const d = deserializeDatum(rawData) as any;
  const priceMapRaw = d.fields[0].fields[0];

  const findKey = (k: number): bigint => {
    if (priceMapRaw?.map) {
      const entry = priceMapRaw.map.find((e: any) => Number(e.k?.int ?? e.k) === k);
      return BigInt(entry?.v?.int ?? entry?.v ?? 0);
    }
    if (Array.isArray(priceMapRaw)) {
      const entry = (priceMapRaw as any[]).find((e) => Number(e[0]) === k);
      return BigInt(entry?.[1] ?? 0);
    }
    return 0n;
  };

  const price = findKey(0);
  const creation_time = Number(findKey(1));
  const expiration_time = Number(findKey(2));

  if (price === 0n || creation_time === 0) {
    throw new Error("AggState price map is empty — oracle not yet populated");
  }

  return { price, creation_time, expiration_time };
}

/**
 * Decode a CombDatum from raw plutusData hex.
 *
 * Onchain: CombDatum = Constr 0 [Bool, Int, Int]
 *   Bool: False = Constr 0 [], True = Constr 1 []
 */
export function decodeCombDatum(rawData: string): CombDatum {
  const d = deserializeDatum(rawData) as any;
  const usedConstr = d.fields[0]?.constructor ?? d.fields[0]?.alternative ?? 0;
  return {
    used: usedConstr === 1,
    price: BigInt(d.fields[1]?.int ?? d.fields[1]),
    time: Number(d.fields[2]?.int ?? d.fields[2]),
  };
}

// ── Token helpers ─────────────────────────────────────────────────────────────

/** Build the comb token unit for a given time (policy_id + 8-byte BE timestamp hex). */
export function buildCombUnit(policyId: string, time: number): string {
  return policyId + time.toString(16).padStart(16, "0");
}

/** True if a unit string is a comb token under the given policy (8-byte name = 16 hex chars). */
export function isCombUnit(unit: string, policyId: string): boolean {
  return unit.startsWith(policyId) && unit.length === policyId.length + 16;
}

// ── Chain traversal ───────────────────────────────────────────────────────────

/**
 * Fetch all Comb Oracle price UTxOs at the script address.
 * Returns them sorted newest-first by datum.time.
 */
export async function fetchPriceNodes(
  provider: BlockfrostProvider,
  cfg: CombOracleConfig
): Promise<PriceNodeUtxo[]> {
  const utxos = await provider.fetchAddressUTxOs(cfg.script_address);
  const nodes: PriceNodeUtxo[] = [];

  for (const u of utxos) {
    if (!u.output.plutusData) continue;
    const hasCombToken = u.output.amount.some((a) => isCombUnit(a.unit, cfg.policy_id));
    if (!hasCombToken) continue;

    try {
      const datum = decodeCombDatum(u.output.plutusData);
      nodes.push({ txHash: u.input.txHash, outputIndex: u.input.outputIndex, datum });
    } catch {
      continue;
    }
  }

  return nodes.sort((a, b) => b.datum.time - a.datum.time);
}

/** Return the current tip UTxO (used=false, newest time). Null if chain is empty. */
export async function fetchTipUtxo(
  provider: BlockfrostProvider,
  cfg: CombOracleConfig
): Promise<PriceNodeUtxo | null> {
  const nodes = await fetchPriceNodes(provider, cfg);
  return nodes.find((n) => !n.datum.used) ?? null;
}

// ── NeoRedeemer builder ───────────────────────────────────────────────────────

/**
 * Build a NeoRedeemer from a sorted set of reference inputs and selected nodes.
 */
export function buildNeoRedeemer(
  allRefInputs: UTxO[],
  nodes: PriceNodeUtxo[],
  granularity: number,
  count: number
): NeoRedeemer {
  const newestTime = nodes[0]?.datum.time;
  if (!newestTime) throw new Error("No price nodes available");

  const selected: PriceNodeUtxo[] = [];
  for (let i = 0; i < count; i++) {
    const targetTime = newestTime - i * granularity;
    const node = nodes.find((n) => n.datum.time === targetTime);
    if (!node) throw new Error(`No node at time ${targetTime} (granularity ${granularity})`);
    selected.push(node);
  }

  const sortedRefs = [...allRefInputs].sort((a, b) => {
    const h = a.input.txHash.localeCompare(b.input.txHash);
    return h !== 0 ? h : a.input.outputIndex - b.input.outputIndex;
  });

  const indices = selected.map((n) => {
    const idx = sortedRefs.findIndex(
      (r) => r.input.txHash === n.txHash && r.input.outputIndex === n.outputIndex
    );
    if (idx === -1) throw new Error(`Node ${n.txHash}#${n.outputIndex} not in reference inputs`);
    return idx;
  });

  const priceSum = selected.reduce((acc, n) => acc + n.datum.price, 0n);
  const claimed_mean = priceSum / BigInt(count);

  return { granularity, count, indices, claimed_mean };
}

/** Compute simple arithmetic mean for display/logging. */
export function computeTwap(nodes: PriceNodeUtxo[]): bigint {
  if (nodes.length === 0) throw new Error("Empty node list");
  const sum = nodes.reduce((acc, n) => acc + n.datum.price, 0n);
  return sum / BigInt(nodes.length);
}
