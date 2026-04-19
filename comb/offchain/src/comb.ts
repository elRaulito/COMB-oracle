/**
 * comb.ts — Standalone comb publisher process.
 *
 * Fires at :05, :15, :25, :35, :45, :55 — 5 min after the agg cron.
 * On error retries once after 30 s.
 *
 * Usage:
 *   npm run comb -- config.yml
 */
import "dotenv/config";
import fs from "fs";
import yaml from "js-yaml";
import cron from "node-cron";
import { OdvClientConfig } from "./types";
import { CombOracle } from "./comb-oracle";

let combRunning = false;

async function attemptComb(oracle: CombOracle, isRetry = false): Promise<void> {
  const now = new Date().toISOString();
  try {
    const txHash = await oracle.update();
    if (txHash) {
      await oracle.readChain();
      console.log(`[comb] ${now} — published → ${txHash}`);
    } else {
      console.log(`[comb] ${now}${isRetry ? " (retry)" : ""} — nothing to publish (tip still fresh)`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : JSON.stringify(err);
    if (!isRetry) {
      console.warn(`[comb] ${now} — FAILED: ${msg}`);
      console.log("[comb] retrying in 30 s...");
      await new Promise((r) => setTimeout(r, 30_000));
      await attemptComb(oracle, true);
    } else {
      console.error(`[comb] ${now} — retry ALSO FAILED: ${msg}`);
    }
  }
}

async function runComb(oracle: CombOracle): Promise<void> {
  if (combRunning) { console.log("[comb] still running, skipping tick"); return; }
  combRunning = true;
  try { await attemptComb(oracle); }
  finally { combRunning = false; }
}

async function main(): Promise<void> {
  const blockfrostKey = process.env.BLOCKFROST_KEY;
  if (!blockfrostKey) throw new Error("BLOCKFROST_KEY not set in .env");

  const cfgPath = process.argv[2] ?? "config.yml";
  const cfg = yaml.load(fs.readFileSync(cfgPath, "utf8")) as OdvClientConfig;

  const scriptCbor = cfg.comb_oracle.oracle_script_cbor;
  if (!scriptCbor) throw new Error("oracle_script_cbor missing — run npm run deploy first");

  const mnemonic = (cfg as any).comb_wallet?.mnemonic ?? cfg.wallet.mnemonic;
  if (!mnemonic) throw new Error("wallet.mnemonic must be set in config");

  const combCfg: OdvClientConfig = { ...cfg, wallet: { mnemonic } };
  const oracle = new CombOracle(combCfg, blockfrostKey, scriptCbor);

  console.log("[comb] Comb publisher started");
  console.log(`[comb] policy_id     : ${cfg.comb_oracle.policy_id}`);
  console.log(`[comb] script_address: ${cfg.comb_oracle.script_address}`);
  console.log(`[comb] interval      : ${cfg.comb_oracle.min_interval} ms`);
  console.log(`[comb] schedule      : :05/:15/:25/:35/:45/:55`);

  await runComb(oracle);

  cron.schedule("5,15,25,35,45,55 * * * *", () => runComb(oracle));
  console.log("[comb] cron active");
}

process.on("uncaughtException", (err) => console.error("[comb] uncaughtException:", err));
process.on("unhandledRejection", (reason) => console.error("[comb] unhandledRejection:", reason));

main().catch((err) => { console.error("[comb] fatal:", err); process.exit(1); });
