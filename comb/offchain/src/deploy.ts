/**
 * deploy.ts — apply parameters to compiled Aiken validators and write back to config.
 *
 * Run once after `aiken build` (in ../onchain):
 *   npm run deploy -- config.yml
 */
import "dotenv/config";
import fs from "fs";
import path from "path";
import yaml from "js-yaml";
import {
  applyParamsToScript,
  resolveScriptHash,
  serializePlutusScript,
  BlockfrostProvider,
  MeshWallet,
  PlutusScript,
} from "@meshsdk/core";
import { OdvClientConfig } from "./types";

interface BlueprintValidator {
  title: string;
  compiledCode: string;
  hash: string;
}

interface Blueprint {
  validators: BlueprintValidator[];
}

function loadBlueprint(blueprintPath: string): Blueprint {
  return JSON.parse(fs.readFileSync(blueprintPath, "utf8"));
}

function getValidator(bp: Blueprint, title: string): BlueprintValidator {
  const v = bp.validators.find((v) => v.title === title);
  if (!v) throw new Error(`Validator "${title}" not found in blueprint`);
  return v;
}

async function main() {
  const cfgPath = process.argv[2] ?? "config.yml";
  const cfgAbsolute = path.resolve(cfgPath);
  const cfg = yaml.load(fs.readFileSync(cfgAbsolute, "utf8")) as OdvClientConfig;

  const blockfrostKey = process.env.BLOCKFROST_KEY;
  if (!blockfrostKey) throw new Error("BLOCKFROST_KEY env var required");

  // plutus.json is in ../onchain/ relative to this offchain folder
  const blueprintPath = path.resolve(__dirname, "../../onchain/plutus.json");
  if (!fs.existsSync(blueprintPath)) {
    throw new Error(
      `plutus.json not found at ${blueprintPath}\nRun: cd comb/onchain && aiken build`
    );
  }

  const bp = loadBlueprint(blueprintPath);
  const cc = cfg.comb_oracle;
  const networkId = cfg.network.network === "mainnet" ? 1 : 0;

  console.log("Blueprint validators found:");
  bp.validators.forEach((v) => console.log("  •", v.title));

  // ── Select seed UTxO ──────────────────────────────────────────────────────────
  let seedTxHash: string;
  let seedOutputIndex: number;

  if (cc.seed_utxo?.tx_hash) {
    seedTxHash = cc.seed_utxo.tx_hash;
    seedOutputIndex = cc.seed_utxo.output_index;
    console.log(`\n── seed UTxO (reusing) ──`);
    console.log(`  ${seedTxHash}#${seedOutputIndex}`);
  } else {
    const provider = new BlockfrostProvider(blockfrostKey);
    const wallet = new MeshWallet({
      networkId,
      fetcher: provider,
      submitter: provider,
      key: { type: "mnemonic", words: cfg.wallet.mnemonic.split(" ") },
    });
    const utxos = await wallet.getUtxos();
    if (utxos.length === 0) throw new Error("Wallet has no UTxOs — fund it first");
    const seed = utxos[0];
    seedTxHash = seed.input.txHash;
    seedOutputIndex = seed.input.outputIndex;
    console.log(`\n── seed UTxO (freshly selected) ──`);
    console.log(`  ${seedTxHash}#${seedOutputIndex}`);
  }

  const seedUtxoParam = { alternative: 0, fields: [seedTxHash, seedOutputIndex] };

  // ── Apply parameters to comb_oracle ──────────────────────────────────────────
  const combOracleRaw = getValidator(bp, "comb_oracle.comb_oracle.mint");

  const combOracleScript = applyParamsToScript(combOracleRaw.compiledCode, [
    cc.oracle_policy_id,
    cc.agg_state_token_name,
    cc.min_interval,
    seedUtxoParam,
  ]);

  const combOraclePlutus: PlutusScript = { code: combOracleScript, version: "V3" };
  const combOraclePolicyId = resolveScriptHash(combOracleScript, "V3");
  const combOracleAddress = serializePlutusScript(combOraclePlutus, undefined, networkId).address;

  console.log("\n── comb_oracle ──");
  console.log(`  → policy_id     : ${combOraclePolicyId}`);
  console.log(`  → script_address: ${combOracleAddress}`);

  // ── Apply parameters to neo ───────────────────────────────────────────────────
  const neoRaw = getValidator(bp, "neo.neo.withdraw");
  const neoScript = applyParamsToScript(neoRaw.compiledCode, [
    combOraclePolicyId,
    cc.min_interval,
  ]);

  console.log("\n── neo (TWAP reader) ──");
  console.log(`  → neo CBOR: ${neoScript.slice(0, 40)}…`);

  // ── Patch config ──────────────────────────────────────────────────────────────
  const updatedCfg = cfg as any;
  updatedCfg.comb_oracle.seed_utxo = { tx_hash: seedTxHash, output_index: seedOutputIndex };
  updatedCfg.comb_oracle.policy_id = combOraclePolicyId;
  updatedCfg.comb_oracle.script_address = combOracleAddress;
  updatedCfg.comb_oracle.oracle_script_cbor = combOracleScript;
  updatedCfg.comb_oracle.neo_script_cbor = neoScript;

  fs.writeFileSync(cfgAbsolute, yaml.dump(updatedCfg, { lineWidth: 120 }));
  console.log(`\n✓ Config updated: ${cfgAbsolute}`);
  console.log(`  Do NOT spend ${seedTxHash}#${seedOutputIndex} before running init`);
  console.log("  Next: npm run init -- config.yml");
}

main().catch((err) => { console.error(err); process.exit(1); });
