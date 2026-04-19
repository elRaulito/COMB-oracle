/**
 * addresses.ts — Print wallet addresses and balances from the config mnemonics.
 *
 * Usage:
 *   CONFIG=path/to/config.yml npm run addresses
 */
import "dotenv/config";
import fs from "fs";
import path from "path";
import yaml from "js-yaml";
import { BlockfrostProvider, MeshWallet } from "@meshsdk/core";
import { OdvClientConfig } from "./types";

const CONFIG_PATH = process.env.CONFIG
  ? path.resolve(process.env.CONFIG)
  : path.resolve(__dirname, "../../comb/offchain/config.yml");

async function main(): Promise<void> {
  const blockfrostKey = process.env.BLOCKFROST_KEY;
  if (!blockfrostKey) throw new Error("BLOCKFROST_KEY not set in .env");

  const cfg = yaml.load(fs.readFileSync(CONFIG_PATH, "utf8")) as OdvClientConfig;
  const provider = new BlockfrostProvider(blockfrostKey);

  const wallets: { label: string; mnemonic: string }[] = [
    { label: "agg  wallet (wallet.mnemonic)", mnemonic: cfg.wallet.mnemonic },
  ];

  if ((cfg as any).comb_wallet?.mnemonic) {
    wallets.push({ label: "comb wallet (comb_wallet.mnemonic)", mnemonic: (cfg as any).comb_wallet.mnemonic });
  }

  console.log("\nWallet addresses:\n");

  for (const { label, mnemonic } of wallets) {
    const wallet = new MeshWallet({
      networkId: 0,
      fetcher: provider,
      submitter: provider,
      key: { type: "mnemonic", words: mnemonic.split(" ") },
    });

    const address = wallet.getChangeAddress();
    const utxos = await wallet.getUtxos();
    const lovelace = utxos.reduce((sum, u) => {
      const ada = u.output.amount.find(a => a.unit === "lovelace");
      return sum + BigInt(ada?.quantity ?? 0);
    }, 0n);
    const ada = Number(lovelace) / 1_000_000;

    console.log(`  ${label}`);
    console.log(`  Address : ${address}`);
    console.log(`  Balance : ${ada.toFixed(2)} ADA\n`);
  }
}

main().catch((err) => { console.error("Error:", err.message ?? err); process.exit(1); });
