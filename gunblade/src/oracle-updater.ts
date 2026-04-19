/**
 * oracle-updater.ts — triggers the Charli3 pull oracle aggregation transaction.
 *
 * Flow:
 *  1. Fetch oracle UTxOs (Settings C3CS, Account C3RA, AggState C3AS)
 *  2. Decode Settings datum → node VKHs, fee info, timing params
 *  3. Call /odv/feed on all nodes, compute median + reward distribution
 *  4. Build aggregation tx (spend Account + AggState, reference Settings + script)
 *  5. Call /odv/sign for node co-signatures
 *  6. Assemble witnesses and submit
 */
import axios from "axios";
import * as blakejs from "blakejs";
import * as fs from "fs";
import * as path from "path";
import {
  BlockfrostProvider,
  EmbeddedWallet,
  MeshTxBuilder,
  MeshWallet,
  UTxO,
  deserializeDatum,
} from "@meshsdk/core";
import { cst } from "@meshsdk/core";
import { NodeConfig, OdvClientConfig, OdvFeedRequest, SignedNodeMessage } from "./types";

// ── Trigger cache ─────────────────────────────────────────────────────────────

const TRIGGER_CACHE_PATH = path.join(process.cwd(), ".agg-trigger-cache.json");

function saveTriggerCache(txHash: string): void {
  fs.writeFileSync(TRIGGER_CACHE_PATH, JSON.stringify({ txHash, submittedAt: Date.now() }));
}

// ── Crypto helpers ────────────────────────────────────────────────────────────

function vkCborToBytes(vkCborHex: string): Buffer {
  return Buffer.from(vkCborHex.startsWith("5820") ? vkCborHex.slice(4) : vkCborHex, "hex");
}

export function vkToVkh(vkCborHex: string): string {
  return Buffer.from(blakejs.blake2b(vkCborToBytes(vkCborHex), undefined, 28)).toString("hex");
}

// ── Numeric helpers ───────────────────────────────────────────────────────────

const toInt = (v: any): number => Number(v?.int ?? v);

function medianOf(sortedVals: number[]): number {
  const n = sortedVals.length;
  if (n === 0) throw new Error("Empty feed list");
  const mid = Math.floor(n / 2);
  return n % 2 === 1 ? sortedVals[mid] : Math.round((sortedVals[mid - 1] + sortedVals[mid]) / 2);
}

function quantile(sorted: number[], q: number): number {
  const n = sorted.length;
  const idx = q * (n - 1);
  const j = Math.floor(idx);
  const g = idx - j;
  return j + 1 >= n ? sorted[j] : (1 - g) * sorted[j] + g * sorted[j + 1];
}

function consensusVkhs(
  feedMap: Record<string, number>,
  iqrFenceMultiplier: number,
  medianDivergencyFactor: number
): string[] {
  const entries = Object.entries(feedMap).sort((a, b) => a[1] - b[1]);
  const vals = entries.map(([, v]) => v);
  const n = vals.length;
  if (n === 0) throw new Error("Empty node feeds");
  if (n === 1) return [entries[0][0]];

  const midpoint = quantile(vals, 0.5);
  let lower: number;
  let upper: number;

  const IQR_MIN = 4;
  if (n >= IQR_MIN) {
    const q25 = quantile(vals, 0.25);
    const q75 = quantile(vals, 0.75);
    const iqr = q75 - q25;
    const mult = iqrFenceMultiplier / 100;
    lower = Math.round(q25 - mult * iqr);
    upper = Math.round(q75 + mult * iqr);
  } else {
    lower = upper = 0;
  }

  if (n < IQR_MIN || lower === upper) {
    const fence = midpoint * (medianDivergencyFactor / 1000);
    lower = Math.round(midpoint - fence);
    upper = Math.round(midpoint + fence);
  }

  return entries.filter(([, v]) => v >= lower && v <= upper).map(([vkh]) => vkh);
}

// ── Datum decoders ────────────────────────────────────────────────────────────

export interface OracleSettings {
  nodeVkhs: string[];
  requiredSignatures: number;
  nodeFee: number;
  platformFee: number;
  aggregationLivenessPeriod: number;
  timeUncertaintyAggregation: number;
  iqrFenceMultiplier: number;
  medianDivergencyFactor: number;
}

export function decodeSettingsDatum(rawData: string): OracleSettings {
  const d = deserializeDatum(rawData) as any;
  const variantId = d.constructor ?? d.alternative;
  const sd = variantId === 1 ? d.fields[0] : d;

  const nodesField = sd.fields[0];
  const rawVkhs: any[] = nodesField?.list ?? [];
  const nodeVkhs: string[] = rawVkhs.map((v: any) => v?.bytes ?? v);

  const feeConfig = sd.fields[2];
  const rp = feeConfig.fields[1];

  return {
    nodeVkhs,
    requiredSignatures: toInt(sd.fields[1]),
    nodeFee: toInt(rp.fields[0]),
    platformFee: toInt(rp.fields[1]),
    aggregationLivenessPeriod: toInt(sd.fields[3]),
    timeUncertaintyAggregation: toInt(sd.fields[4]),
    iqrFenceMultiplier: toInt(sd.fields[6]),
    medianDivergencyFactor: toInt(sd.fields[7]),
  };
}

function decodeAccountDatum(rawData: string): Record<string, number> {
  const d = deserializeDatum(rawData) as any;
  const rad = d.fields[0];
  const rawMap: any[] = rad.fields[0]?.map ?? [];
  const result: Record<string, number> = {};
  for (const e of rawMap) {
    result[e.k?.bytes ?? e.k] = toInt(e.v);
  }
  return result;
}

// ── Main entry point ──────────────────────────────────────────────────────────

export async function updateAggState(cfg: OdvClientConfig, blockfrostKey: string): Promise<void> {
  const provider = new BlockfrostProvider(blockfrostKey);
  const networkId = cfg.network.network === "mainnet" ? 1 : 0;
  const wallet = new MeshWallet({
    networkId,
    fetcher: provider,
    submitter: provider,
    key: { type: "mnemonic", words: cfg.wallet.mnemonic.split(" ") },
  });

  const policyId = cfg.policy_id;
  const oracleAddress = cfg.oracle_address;
  const refScriptTxHash = cfg.reference_script.utxo_reference.transaction_id;
  const refScriptIndex = cfg.reference_script.utxo_reference.output_index;

  console.log("[oracle-updater] fetching oracle UTxOs at", oracleAddress);
  const utxos: UTxO[] = await provider.fetchAddressUTxOs(oracleAddress);

  const C3CS = policyId + Buffer.from("C3CS").toString("hex");
  const C3RA = policyId + Buffer.from("C3RA").toString("hex");
  const C3AS = policyId + Buffer.from("C3AS").toString("hex");

  const settingsUtxo = utxos.find((u) => u.output.amount.some((a) => a.unit === C3CS));
  if (!settingsUtxo?.output.plutusData) throw new Error("Settings UTxO (C3CS) not found");

  const accountUtxo = utxos.find((u) => u.output.amount.some((a) => a.unit === C3RA));
  if (!accountUtxo?.output.plutusData) throw new Error("Account UTxO (C3RA) not found");

  const aggStateUtxo = utxos.find(
    (u) => u.output.amount.some((a) => a.unit === C3AS) && !!u.output.plutusData
  );
  if (!aggStateUtxo) throw new Error("AggState UTxO (C3AS) not found");

  const settings = decodeSettingsDatum(settingsUtxo.output.plutusData);
  console.log("[oracle-updater] nodes:", settings.nodeVkhs.length,
    "nodeFee:", settings.nodeFee, "platformFee:", settings.platformFee);

  const inDistribution = decodeAccountDatum(accountUtxo.output.plutusData);

  const timeUncert = settings.timeUncertaintyAggregation;

  const latestBlock = await provider.fetchLatestBlock();
  const currentSlot = Number((latestBlock as any).slot);
  const halfUncert = Math.floor(timeUncert / 2);
  const halfSlotUncert = Math.ceil(halfUncert / 1000);
  // On preprod: Shelley genesis slot = 86400, genesis POSIX = 1655769600000
  const contractCurrentTime = (currentSlot - 86400) * 1000 + 1655769600000;
  console.log("[oracle-updater] currentSlot:", currentSlot, "contractCurrentTime:", contractCurrentTime);

  const feedRequest: OdvFeedRequest = {
    oracle_nft_policy_id: policyId,
    tx_validity_interval: {
      start: contractCurrentTime - halfUncert,
      end: contractCurrentTime + halfUncert,
    },
  };

  console.log("[oracle-updater] calling /odv/feed on", cfg.nodes.length, "nodes...");
  const feedResponses: Array<{ node: NodeConfig; msg: SignedNodeMessage }> = [];
  for (const node of cfg.nodes) {
    try {
      const { data } = await axios.post<SignedNodeMessage>(
        `${node.root_url}/odv/feed`, feedRequest, { timeout: 15_000 }
      );
      feedResponses.push({ node, msg: data });
      const decodedMsg = deserializeDatum(data.message) as any;
      const feedValue = toInt(decodedMsg.fields?.[0]);
      console.log("[oracle-updater]", node.root_url, "→ feed:", feedValue);
    } catch (err) {
      console.warn("[oracle-updater]", node.root_url, "feed error:", (err as Error).message);
    }
  }

  if (feedResponses.length < settings.requiredSignatures) {
    throw new Error(`Only ${feedResponses.length} feeds (need ${settings.requiredSignatures})`);
  }

  const vkhToFeed: Record<string, number> = {};
  for (const { msg } of feedResponses) {
    const vkh = vkToVkh(msg.verification_key);
    const dm = deserializeDatum(msg.message) as any;
    vkhToFeed[vkh] = toInt(dm.fields?.[0]);
  }

  const valuesSorted = Object.values(vkhToFeed).sort((a, b) => a - b);
  const medianValue = medianOf(valuesSorted);
  console.log("[oracle-updater] median:", medianValue);

  const sortedFeeds = Object.entries(vkhToFeed).sort(([vkhA], [vkhB]) =>
    vkhA < vkhB ? -1 : vkhA > vkhB ? 1 : 0
  );

  const rewardedSet = new Set(
    consensusVkhs(vkhToFeed, settings.iqrFenceMultiplier, settings.medianDivergencyFactor)
  );
  const minFee = settings.platformFee + settings.nodeFee * feedResponses.length;

  const outDistribution = settings.nodeVkhs
    .map((vkh) => ({
      vkh,
      reward: (inDistribution[vkh] ?? 0) + (rewardedSet.has(vkh) ? settings.nodeFee : 0),
    }))
    .filter(({ reward }) => reward > 0)
    .sort((a, b) => a.vkh.localeCompare(b.vkh));

  const odvAggRedeemer = {
    alternative: 0,
    fields: [new Map(sortedFeeds.map(([vkh, feed]) => [vkh, feed] as [string, number]))],
  };

  const odvMsgRedeemer = { alternative: 1, fields: [] };

  const aggStateDatum = {
    alternative: 0,
    fields: [{
      alternative: 2,
      fields: [new Map<number, number>([
        [0, medianValue],
        [1, contractCurrentTime],
        [2, contractCurrentTime + settings.aggregationLivenessPeriod],
      ])],
    }],
  };

  const accountDatum = {
    alternative: 2,
    fields: [{
      alternative: 0,
      fields: [
        new Map(outDistribution.map(({ vkh, reward }) => [vkh, reward] as [string, number])),
        contractCurrentTime,
      ],
    }],
  };

  const accountLovelace = BigInt(
    accountUtxo.output.amount.find((a) => a.unit === "lovelace")!.quantity
  ) + BigInt(minFee);
  const accountAmounts = [
    { unit: "lovelace", quantity: accountLovelace.toString() },
    ...accountUtxo.output.amount.filter((a) => a.unit !== "lovelace"),
  ];

  const requiredSigners = sortedFeeds.map(([vkh]) => vkh).sort();

  const walletUtxos = await wallet.getUtxos();
  const collateral = walletUtxos.find((u) =>
    u.output.amount.length === 1 &&
    u.output.amount[0].unit === "lovelace" &&
    BigInt(u.output.amount[0].quantity) >= 3_000_000n
  );
  const walletAddress = wallet.getChangeAddress();

  if (!collateral) throw new Error("No collateral UTxO (need ≥3 ADA, ADA-only)");

  const feeInput = walletUtxos.find((u) =>
    u.input.txHash !== collateral.input.txHash &&
    u.output.amount.some((a) => a.unit === "lovelace" && BigInt(a.quantity) >= 5_000_000n)
  ) ?? walletUtxos.find((u) => u.input.txHash == collateral.input.txHash);
  if (!feeInput) throw new Error("No wallet UTxO available for fee input");

  console.log("[oracle-updater] building tx...");
  const txBuilder = new MeshTxBuilder({ fetcher: provider, evaluator: provider, verbose: true });
  txBuilder.setNetwork("preprod");

  txBuilder.txIn(feeInput.input.txHash, feeInput.input.outputIndex,
    feeInput.output.amount, feeInput.output.address);

  txBuilder
    .spendingPlutusScriptV3()
    .txIn(accountUtxo.input.txHash, accountUtxo.input.outputIndex)
    .txInInlineDatumPresent()
    .txInRedeemerValue(odvAggRedeemer, "Mesh")
    .spendingTxInReference(refScriptTxHash, refScriptIndex);

  txBuilder
    .spendingPlutusScriptV3()
    .txIn(aggStateUtxo.input.txHash, aggStateUtxo.input.outputIndex)
    .txInInlineDatumPresent()
    .txInRedeemerValue(odvMsgRedeemer, "Mesh")
    .spendingTxInReference(refScriptTxHash, refScriptIndex);

  txBuilder
    .readOnlyTxInReference(settingsUtxo.input.txHash, settingsUtxo.input.outputIndex)
    .txOut(oracleAddress, accountAmounts)
    .txOutInlineDatumValue(accountDatum, "Mesh")
    .txOut(oracleAddress, aggStateUtxo.output.amount)
    .txOutInlineDatumValue(aggStateDatum, "Mesh")
    .txInCollateral(collateral.input.txHash, collateral.input.outputIndex)
    .changeAddress(walletAddress)
    .invalidBefore(currentSlot - halfSlotUncert)
    .invalidHereafter(currentSlot + halfSlotUncert);

  for (const vkh of requiredSigners) {
    txBuilder.requiredSignerHash(vkh);
  }

  const unsignedTx = await txBuilder.complete();

  const txBodyCbor = cst.deserializeTx(unsignedTx).body().toCbor() as string;

  const nodeMessages: Record<string, SignedNodeMessage> = {};
  for (const { node, msg } of feedResponses) {
    nodeMessages[node.pub_key] = msg;
  }

  console.log("[oracle-updater] calling /odv/sign on", feedResponses.length, "nodes...");
  const nodeWitnesses: Array<{ vkCborHex: string; sigHex: string }> = [];
  for (const { node, msg } of feedResponses) {
    try {
      const { data } = await axios.post<{ signature: string }>(
        `${node.root_url}/odv/sign`,
        { node_messages: nodeMessages, tx_body_cbor: txBodyCbor },
        { timeout: 20_000 }
      );
      nodeWitnesses.push({ vkCborHex: msg.verification_key, sigHex: data.signature });
      console.log("[oracle-updater] signature from", node.root_url);
    } catch (err) {
      console.warn("[oracle-updater] sign error", node.root_url, ":", (err as Error).message);
    }
  }

  if (nodeWitnesses.length < settings.requiredSignatures) {
    throw new Error(`Insufficient signatures: ${nodeWitnesses.length}/${settings.requiredSignatures}`);
  }

  let signedTx = await wallet.signTx(unsignedTx, true);

  for (const { vkCborHex, sigHex } of nodeWitnesses) {
    const vkHex = vkCborHex.startsWith("5820") ? vkCborHex.slice(4) : vkCborHex;
    const witness = new cst.VkeyWitness(vkHex as any, sigHex as any);
    signedTx = EmbeddedWallet.addWitnessSets(signedTx, [witness]);
  }

  const txHash = await wallet.submitTx(signedTx);
  console.log("[oracle-updater] submitted:", txHash);
  saveTriggerCache(txHash);
}
