/**
 * neo.ts — On-chain TWAP verification via the neo withdraw validator.
 *
 * Usage:
 *   npm run neo -- config.yml             — verify TWAP using the 5 newest comb price points
 *   npm run neo -- register config.yml    — register the neo staking credential (one-time, 2 ADA deposit)
 */
import "dotenv/config";
import fs from "fs";
import path from "path";
import yaml from "js-yaml";
import {
  BlockfrostProvider,
  MeshWallet,
  MeshTxBuilder,
  UTxO,
  resolveScriptHash,
  applyParamsToScript,
  mConStr0,
} from "@meshsdk/core";

// ── Types ─────────────────────────────────────────────────────────────────────

interface CombDatum {
  used: boolean;
  price: bigint;
  time: number;
}

interface PriceNodeUtxo {
  txHash: string;
  outputIndex: number;
  datum: CombDatum;
}

interface OdvClientConfig {
  network: { network: string };
  wallet: { mnemonic: string };
  oracle_address: string;
  policy_id: string;
  nodes: any[];
  comb_oracle: {
    oracle_policy_id: string;
    agg_state_token_name: string;
    min_interval: number;
    policy_id: string;
    script_address: string;
    oracle_script_cbor?: string;
    neo_script_cbor?: string;
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const { deserializeDatum } = require("@meshsdk/core");

function decodeCombDatum(rawData: string): CombDatum {
  const d = deserializeDatum(rawData) as any;
  const usedConstr = d.fields[0]?.constructor ?? d.fields[0]?.alternative ?? 0;
  return {
    used: usedConstr === 1,
    price: BigInt(d.fields[1]?.int ?? d.fields[1]),
    time: Number(d.fields[2]?.int ?? d.fields[2]),
  };
}

function isCombUnit(unit: string, policyId: string): boolean {
  return unit.startsWith(policyId) && unit.length === policyId.length + 16;
}

async function fetchPriceNodes(
  provider: BlockfrostProvider,
  cfg: OdvClientConfig["comb_oracle"]
): Promise<PriceNodeUtxo[]> {
  const utxos = await provider.fetchAddressUTxOs(cfg.script_address);
  const nodes: PriceNodeUtxo[] = [];
  for (const u of utxos) {
    if (!u.output.plutusData) continue;
    if (!u.output.amount.some((a: any) => isCombUnit(a.unit, cfg.policy_id))) continue;
    try {
      const datum = decodeCombDatum(u.output.plutusData);
      nodes.push({ txHash: u.input.txHash, outputIndex: u.input.outputIndex, datum });
    } catch { continue; }
  }
  return nodes.sort((a, b) => b.datum.time - a.datum.time);
}

// ── Bech32 stake address ──────────────────────────────────────────────────────

const BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

function bech32Polymod(values: number[]): number {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const b = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((b >> i) & 1) chk ^= GEN[i];
  }
  return chk;
}

function hrpExpand(hrp: string): number[] {
  const ret: number[] = [];
  for (const c of hrp) ret.push(c.charCodeAt(0) >> 5);
  ret.push(0);
  for (const c of hrp) ret.push(c.charCodeAt(0) & 31);
  return ret;
}

function bech32Encode(hrp: string, data: number[]): string {
  const values = [...hrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0];
  const p = bech32Polymod(values) ^ 1;
  const checksum = Array.from({ length: 6 }, (_, i) => (p >> (5 * (5 - i))) & 31);
  return hrp + "1" + [...data, ...checksum].map(d => BECH32_CHARSET[d]).join("");
}

function bytesToBase32(bytes: number[]): number[] {
  const out: number[] = [];
  let value = 0, bits = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { bits -= 5; out.push((value >> bits) & 31); }
  }
  if (bits > 0) out.push((value << (5 - bits)) & 31);
  return out;
}

function scriptHashToStakeAddress(scriptHashHex: string, network: 0 | 1 = 0): string {
  const header = network === 0 ? 0xf0 : 0xf1;
  const bytes = [header, ...Buffer.from(scriptHashHex, "hex")];
  const hrp = network === 0 ? "stake_test" : "stake";
  return bech32Encode(hrp, bytesToBase32(bytes));
}

function deriveStakeAddress(scriptCbor: string): string {
  const hash = resolveScriptHash(scriptCbor, "V3");
  return scriptHashToStakeAddress(hash, 0);
}

// ── Blockfrost helpers ────────────────────────────────────────────────────────

async function isRegistered(stakeAddress: string, blockfrostKey: string): Promise<boolean> {
  const resp = await fetch(
    `https://cardano-preprod.blockfrost.io/api/v0/accounts/${stakeAddress}`,
    { headers: { project_id: blockfrostKey } }
  );
  return resp.status === 200;
}

// ── Granularity detection ─────────────────────────────────────────────────────

function detectGranularity(nodes: PriceNodeUtxo[], interval: number, count: number): number {
  const byTime = new Map(nodes.map(n => [n.datum.time, n]));
  const newest = nodes[0].datum.time;
  for (let mult = 1; mult <= 12; mult++) {
    const gran = mult * interval;
    if (Array.from({ length: count }, (_, i) => byTime.has(newest - i * gran)).every(Boolean))
      return gran;
  }
  throw new Error(`Cannot find ${count} evenly spaced points within 12 intervals`);
}

// ── Register ──────────────────────────────────────────────────────────────────

async function register(
  wallet: MeshWallet,
  provider: BlockfrostProvider,
  stakeAddress: string
): Promise<string> {
  const walletUtxos = await wallet.getUtxos();
  const walletAddress = wallet.getChangeAddress();

  const feeInput = walletUtxos.find(u =>
    u.output.amount.some((a: any) => a.unit === "lovelace" && BigInt(a.quantity) >= 5_000_000n)
  );
  if (!feeInput) throw new Error("Need ≥5 ADA to cover 2 ADA registration deposit + fees");

  const txBuilder = new MeshTxBuilder({ fetcher: provider, verbose: true });
  txBuilder.setNetwork("preprod");

  txBuilder
    .txIn(feeInput.input.txHash, feeInput.input.outputIndex,
      feeInput.output.amount, feeInput.output.address)
    .registerStakeCertificate(stakeAddress)
    .changeAddress(walletAddress);

  const unsignedTx = await txBuilder.complete();
  const signedTx   = await wallet.signTx(unsignedTx);
  return wallet.submitTx(signedTx);
}

// ── TWAP verification ─────────────────────────────────────────────────────────

const COUNT = 5;

async function verifyTwap(
  wallet: MeshWallet,
  provider: BlockfrostProvider,
  cfg: OdvClientConfig,
  neoScriptCbor: string,
  stakeAddress: string
): Promise<string> {
  const nodes = await fetchPriceNodes(provider, cfg.comb_oracle);
  if (nodes.length < COUNT)
    throw new Error(`Need at least ${COUNT} price points, found ${nodes.length}`);
  console.log(`[neo] ${nodes.length} comb points on-chain`);

  const interval    = cfg.comb_oracle.min_interval;
  const granularity = detectGranularity(nodes, interval, COUNT);
  console.log(`[neo] granularity: ${granularity / 1000}s`);

  const newestAge = Date.now() - nodes[0].datum.time;
  if (newestAge > 20 * 60_000) {
    throw new Error(`Newest comb price is ${Math.round(newestAge / 60_000)} min old (limit: 20 min)`);
  }

  const newestTime = nodes[0].datum.time;
  const byTime     = new Map(nodes.map(n => [n.datum.time, n]));
  const allUtxos   = await provider.fetchAddressUTxOs(cfg.comb_oracle.script_address);

  const refUtxos: UTxO[] = Array.from({ length: COUNT }, (_, i) => {
    const t    = newestTime - i * granularity;
    const node = byTime.get(t)!;
    const utxo = allUtxos.find((u: any) =>
      u.input.txHash === node.txHash && u.input.outputIndex === node.outputIndex
    );
    if (!utxo) throw new Error(`UTxO for time ${new Date(t).toISOString()} not found`);
    return utxo;
  });

  // Sort ref inputs as Cardano does (by TxOutRef lex order) to compute indices
  const sortedRefs = [...refUtxos].sort((a, b) => {
    const h = a.input.txHash.localeCompare(b.input.txHash);
    return h !== 0 ? h : a.input.outputIndex - b.input.outputIndex;
  });

  const indices = refUtxos.map((u) =>
    sortedRefs.findIndex(r => r.input.txHash === u.input.txHash && r.input.outputIndex === u.input.outputIndex)
  );

  const priceSum = Array.from({ length: COUNT }, (_, i) => {
    const t = newestTime - i * granularity;
    return byTime.get(t)!.datum.price;
  }).reduce((a, b) => a + b, 0n);
  const claimed_mean = priceSum / BigInt(COUNT);

  console.log(`[neo] claimed_mean = ${claimed_mean}`);
  console.log(`[neo] indices      = [${indices.join(", ")}]`);

  const neoRedeemer = mConStr0([granularity, COUNT, indices, Number(claimed_mean)]);

  const walletUtxos   = await wallet.getUtxos();
  const walletAddress = wallet.getChangeAddress();

  const collateral = walletUtxos.find((u: any) =>
    u.output.amount.length === 1 &&
    u.output.amount[0].unit === "lovelace" &&
    BigInt(u.output.amount[0].quantity) >= 3_000_000n
  );
  if (!collateral) throw new Error("No collateral UTxO (need ≥3 ADA, ADA-only)");

  const feeInput = walletUtxos.find((u: any) =>
    u.input.txHash !== collateral.input.txHash &&
    u.output.amount.some((a: any) => a.unit === "lovelace" && BigInt(a.quantity) >= 2_000_000n)
  ) ?? walletUtxos.find((u: any) => u.input.txHash === collateral.input.txHash);
  if (!feeInput) throw new Error("No fee UTxO");

  const latestBlock  = await provider.fetchLatestBlock();
  const currentSlot  = Number((latestBlock as any).slot);
  const windowSlots  = Math.floor(interval / 1000) - 10;

  const txBuilder = new MeshTxBuilder({ fetcher: provider, verbose: true });
  txBuilder.setNetwork("preprod");

  txBuilder.txIn(
    feeInput.input.txHash, feeInput.input.outputIndex,
    feeInput.output.amount, feeInput.output.address
  );

  for (const utxo of sortedRefs) {
    txBuilder.readOnlyTxInReference(utxo.input.txHash, utxo.input.outputIndex);
  }

  txBuilder
    .withdrawalPlutusScriptV3()
    .withdrawal(stakeAddress, "0")
    .withdrawalScript(neoScriptCbor)
    .withdrawalRedeemerValue(neoRedeemer, "Mesh")
    .txInCollateral(collateral.input.txHash, collateral.input.outputIndex)
    .changeAddress(walletAddress)
    .invalidBefore(currentSlot)
    .invalidHereafter(currentSlot + windowSlots);

  const unsignedTx = await txBuilder.complete();
  const signedTx   = await wallet.signTx(unsignedTx);
  return wallet.submitTx(signedTx);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const blockfrostKey = process.env.BLOCKFROST_KEY;
  if (!blockfrostKey) throw new Error("BLOCKFROST_KEY not set in .env");

  const args = process.argv.slice(2);
  const command = args[0] === "register" ? "register" : undefined;
  const cfgPath = args.find(a => a.endsWith(".yml")) ?? "config.yml";

  const cfg = yaml.load(fs.readFileSync(path.resolve(cfgPath), "utf8")) as OdvClientConfig;

  const neoScriptCbor = cfg.comb_oracle.neo_script_cbor;
  if (!neoScriptCbor) throw new Error("neo_script_cbor missing in config — run: npm run deploy first");

  const stakeAddress = deriveStakeAddress(neoScriptCbor);
  console.log(`[neo] stake address: ${stakeAddress}`);

  const provider = new BlockfrostProvider(blockfrostKey);
  const wallet   = new MeshWallet({
    networkId: 0,
    fetcher: provider,
    submitter: provider,
    key: { type: "mnemonic", words: cfg.wallet.mnemonic.split(" ") },
  });

  if (command === "register") {
    const already = await isRegistered(stakeAddress, blockfrostKey);
    if (already) { console.log("[neo] already registered — nothing to do"); return; }
    console.log("[neo] registering staking credential (2 ADA deposit)...");
    const txHash = await register(wallet, provider, stakeAddress);
    console.log(`[neo] registered → ${txHash}`);
    return;
  }

  const registered = await isRegistered(stakeAddress, blockfrostKey);
  if (!registered) {
    console.error(`[neo] not registered.\n      Run: npm run neo -- register config.yml`);
    process.exit(1);
  }

  const txHash = await verifyTwap(wallet, provider, cfg, neoScriptCbor, stakeAddress);
  console.log(`[neo] TWAP verified on-chain → ${txHash}`);
}

main().catch(e => {
  console.error("[neo] error:", e.message ?? e);
  process.exit(1);
});
