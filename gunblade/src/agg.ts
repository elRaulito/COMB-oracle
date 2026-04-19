/**
 * agg.ts — Standalone aggregator process.
 *
 * Fires at every 10-minute mark: :00, :10, :20, :30, :40, :50.
 *
 * Usage:
 *   CONFIG=path/to/config.yml npm run agg
 */
import "dotenv/config";
import fs from "fs";
import path from "path";
import yaml from "js-yaml";
import cron from "node-cron";
import { OdvClientConfig } from "./types";
import { updateAggState } from "./oracle-updater";

const CONFIG_PATH = process.env.CONFIG
  ? path.resolve(process.env.CONFIG)
  : path.resolve(__dirname, "../../comb/offchain/config.yml");

async function runAggUpdate(cfg: OdvClientConfig, blockfrostKey: string): Promise<void> {
  const now = new Date().toISOString();
  console.log(`[agg] ${now} — running aggregation`);
  try {
    await updateAggState(cfg, blockfrostKey);
    console.log(`[agg] ${now} — done`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : JSON.stringify(err);
    console.error(`[agg] ${now} — FAILED: ${msg}`);
  }
}

async function main(): Promise<void> {
  const blockfrostKey = process.env.BLOCKFROST_KEY;
  if (!blockfrostKey) throw new Error("BLOCKFROST_KEY not set in .env");

  const cfg = yaml.load(fs.readFileSync(CONFIG_PATH, "utf8")) as OdvClientConfig;
  if (!cfg.wallet.mnemonic) throw new Error("wallet.mnemonic must be set in config");

  console.log("[agg] Aggregator started");
  console.log(`[agg] oracle address : ${cfg.oracle_address}`);
  console.log(`[agg] schedule       : every 10 min at :00/:10/:20/:30/:40/:50`);

  await runAggUpdate(cfg, blockfrostKey);

  cron.schedule("*/10 * * * *", () => runAggUpdate(cfg, blockfrostKey));
  console.log("[agg] cron active");
}

process.on("uncaughtException", (err) => console.error("[agg] uncaughtException:", err));
process.on("unhandledRejection", (reason) => console.error("[agg] unhandledRejection:", reason));

main().catch((err) => { console.error("[agg] fatal:", err); process.exit(1); });
