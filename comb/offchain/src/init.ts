/**
 * init.ts — One-time bootstrap: mint the first price token.
 *
 * Run once after `npm run deploy -- config.yml`:
 *   npm run init -- config.yml
 */
import "dotenv/config";
import fs from "fs";
import yaml from "js-yaml";
import { OdvClientConfig } from "./types";
import { CombOracle } from "./comb-oracle";

async function main() {
  const cfgPath = process.argv[2] ?? "config.yml";
  const cfg = yaml.load(fs.readFileSync(cfgPath, "utf8")) as OdvClientConfig;

  const blockfrostKey = process.env.BLOCKFROST_KEY;
  if (!blockfrostKey) throw new Error("BLOCKFROST_KEY env var required");

  const scriptCbor = cfg.comb_oracle.oracle_script_cbor;
  if (!scriptCbor) throw new Error("oracle_script_cbor missing — run npm run deploy first");

  if (!cfg.wallet.mnemonic) throw new Error("wallet.mnemonic must be set in config");

  const oracle = new CombOracle(cfg, blockfrostKey, scriptCbor);
  console.log(`[init] wallet address: ${oracle.getWalletAddress()}`);

  const txHash = await oracle.init();
  console.log(`[init] done → ${txHash}`);
  console.log(`[init] script address: ${cfg.comb_oracle.script_address}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
