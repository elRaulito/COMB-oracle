/**
 * CombOracle: builds and submits Init, Update, and Burn transactions using MeshJS.
 */
import {
  BlockfrostProvider,
  MeshWallet,
  MeshTxBuilder,
  UTxO,
  mConStr0,
  mConStr1,
  mConStr2,
} from "@meshsdk/core";
import { CombDatum, OdvClientConfig } from "./types";
import {
  buildCombUnit,
  computeTwap,
  decodeCombDatum,
  decodeAggState,
  fetchPriceNodes,
  fetchTipUtxo,
} from "./chain-reader";

// ── Datum / redeemer encoders ─────────────────────────────────────────────────

const encodeCombDatum = (d: CombDatum) =>
  mConStr0([
    d.used ? mConStr1([]) : mConStr0([]),  // Bool: True=Constr1, False=Constr0
    Number(d.price),
    d.time,
  ]);

const initRedeemer   = mConStr0([]);  // MintRedeemer::Init
const updateRedeemer = mConStr1([]);  // MintRedeemer::Update
const burnRedeemer   = mConStr2([]);  // MintRedeemer::Burn

// ── Main class ────────────────────────────────────────────────────────────────

export class CombOracle {
  private provider: BlockfrostProvider;
  private wallet: MeshWallet;
  private cfg: OdvClientConfig;
  private scriptCbor: string;

  constructor(cfg: OdvClientConfig, blockfrostKey: string, scriptCbor: string) {
    this.cfg = cfg;
    this.scriptCbor = scriptCbor;
    this.provider = new BlockfrostProvider(blockfrostKey);
    this.wallet = new MeshWallet({
      networkId: cfg.network.network === "mainnet" ? 1 : 0,
      fetcher: this.provider,
      submitter: this.provider,
      key: { type: "mnemonic", words: cfg.wallet.mnemonic.split(" ") },
    });
  }

  private get combCfg() { return this.cfg.comb_oracle; }
  private get interval() { return this.combCfg.min_interval; }

  getWalletAddress(): string { return this.wallet.getChangeAddress(); }

  private async selectCollateral(): Promise<UTxO> {
    const utxos = await this.wallet.getUtxos();
    const col = utxos.find((u) => {
      const amounts = u.output.amount;
      return (
        amounts.length === 1 &&
        amounts[0].unit === "lovelace" &&
        BigInt(amounts[0].quantity) >= 3_000_000n
      );
    });
    if (!col) throw new Error("No suitable collateral UTxO (need ≥3 ADA, ADA-only)");
    return col;
  }

  private async fetchAggUtxo(): Promise<UTxO> {
    const unit = this.cfg.policy_id + this.combCfg.agg_state_token_name;
    const utxos = await this.provider.fetchAddressUTxOs(this.cfg.oracle_address);
    const candidates = utxos.filter(
      (u) => u.output.amount.some((a) => a.unit === unit) && !!u.output.plutusData
    );
    if (candidates.length === 0) throw new Error("AggState UTxO not found");
    candidates.sort((a, b) => {
      try {
        return decodeAggState(b.output.plutusData!).creation_time
             - decodeAggState(a.output.plutusData!).creation_time;
      } catch { return 0; }
    });
    return candidates[0];
  }

  // ── Init ──────────────────────────────────────────────────────────────────

  async init(): Promise<string> {
    const aggUtxo = await this.fetchAggUtxo();
    if (!aggUtxo.output.plutusData) throw new Error("AggState UTxO has no datum");

    const agg = decodeAggState(aggUtxo.output.plutusData);

    const seedCfg = this.combCfg.seed_utxo;
    if (!seedCfg) throw new Error("seed_utxo not set in config — run npm run deploy first");

    const walletUtxos = await this.wallet.getUtxos();
    const seedUtxo = walletUtxos.find(
      (u) => u.input.txHash === seedCfg.tx_hash && u.input.outputIndex === seedCfg.output_index
    );
    if (!seedUtxo) throw new Error(`Seed UTxO ${seedCfg.tx_hash}#${seedCfg.output_index} not found in wallet`);

    const walletAddress = this.wallet.getChangeAddress();
    const collateral = await this.selectCollateral();

    const latestBlock = await this.provider.fetchLatestBlock();
    const currentSlot = Number((latestBlock as any).slot);
    const hereafter = currentSlot + Math.ceil((2 * this.interval) / 1000);
    // On preprod: Shelley genesis slot = 86400, genesis POSIX = 1655769600000
    const contractCurrentTime = (currentSlot - 86400) * 1000 + 1655769600000;
    const time = Math.floor(contractCurrentTime / this.interval) * this.interval;
    const tokenName = time.toString(16).padStart(16, "0");
    const tokenUnit = buildCombUnit(this.combCfg.policy_id, time);

    const datum: CombDatum = { used: false, price: agg.price, time };

    console.log(`[comb] init: price=${agg.price} time=${time} (${new Date(time).toISOString()})`);
    console.log(`[comb] consuming seed: ${seedCfg.tx_hash.slice(0, 8)}#${seedCfg.output_index}`);

    const txBuilder = new MeshTxBuilder({ fetcher: this.provider, verbose: true });
    txBuilder.setNetwork("preprod");

    const unsignedTx = await txBuilder
      .mintPlutusScriptV3()
      .mint("1", this.combCfg.policy_id, tokenName)
      .mintingScript(this.scriptCbor)
      .mintRedeemerValue(initRedeemer, "Mesh")
      .txIn(seedUtxo.input.txHash, seedUtxo.input.outputIndex)
      .readOnlyTxInReference(aggUtxo.input.txHash, aggUtxo.input.outputIndex)
      .txOut(this.combCfg.script_address, [
        { unit: "lovelace", quantity: "2000000" },
        { unit: tokenUnit, quantity: "1" },
      ])
      .txOutInlineDatumValue(encodeCombDatum(datum), "Mesh")
      .txInCollateral(collateral.input.txHash, collateral.input.outputIndex)
      .changeAddress(walletAddress)
      .invalidBefore(currentSlot)
      .invalidHereafter(hereafter)
      .complete();

    const signedTx = await this.wallet.signTx(unsignedTx);
    const txHash = await this.wallet.submitTx(signedTx);
    console.log(`[comb] init → ${txHash}`);
    return txHash;
  }

  // ── Update ────────────────────────────────────────────────────────────────

  async update(): Promise<string | null> {
    const aggUtxo = await this.fetchAggUtxo();
    if (!aggUtxo.output.plutusData) throw new Error("AggState UTxO has no datum");

    const agg = decodeAggState(aggUtxo.output.plutusData);

    const tip = await fetchTipUtxo(this.provider, this.combCfg);
    if (!tip) throw new Error("No tip UTxO found — run init first");

    const oldTime = tip.datum.time;
    const now = Date.now();
    const minsOld = Math.round((now - oldTime) / 60000);
    console.log(`[comb] on-chain tip: oldTime=${oldTime} (${minsOld} min ago) price=${agg.price}`);

    if (now < oldTime + this.interval) {
      console.log(`[comb] skip — on-chain tip is only ${minsOld} min old, need ${this.interval / 60000} min`);
      return null;
    }

    return this.buildAndSubmitUpdate(tip, agg, aggUtxo, oldTime);
  }

  private async buildAndSubmitUpdate(
    tip: Awaited<ReturnType<typeof fetchTipUtxo>> & {},
    agg: ReturnType<typeof decodeAggState>,
    aggUtxo: UTxO,
    oldTime: number,
  ): Promise<string> {
    const allScriptUtxos = await this.provider.fetchAddressUTxOs(this.combCfg.script_address);
    const tipUtxo = allScriptUtxos.find(
      (u) => u.input.txHash === tip.txHash && u.input.outputIndex === tip.outputIndex
    );
    if (!tipUtxo) throw new Error("Tip UTxO not found at script address");

    const latestBlock = await this.provider.fetchLatestBlock();
    const currentSlot = Number((latestBlock as any).slot);
    const hereafter = currentSlot + Math.ceil((2 * this.interval) / 1000);
    // Derive newTime from the current tx time bucket (matches on-chain logic)
    const contractCurrentTime = (currentSlot - 86400) * 1000 + 1655769600000;
    const newTime = Math.floor(contractCurrentTime / this.interval) * this.interval;

    console.log(`[comb] newTime=${newTime} (${new Date(newTime).toISOString()})`);

    const newTokenName = newTime.toString(16).padStart(16, "0");
    const oldTokenUnit = buildCombUnit(this.combCfg.policy_id, oldTime);
    const newTokenUnit = buildCombUnit(this.combCfg.policy_id, newTime);

    const walletAddress = this.wallet.getChangeAddress();
    const walletUtxos = await this.wallet.getUtxos();
    const collateral = await this.selectCollateral();
    const feeInput = walletUtxos.find((u) =>
      u.output.amount.some((a) => a.unit === "lovelace" && BigInt(a.quantity) >= 5_000_000n)
    ) ?? walletUtxos[0];
    if (!feeInput) throw new Error("No wallet UTxO available for fees");

    const updatedTipDatum: CombDatum = { used: true, price: tip.datum.price, time: oldTime };
    const newNodeDatum: CombDatum = { used: false, price: agg.price, time: newTime };

    const txBuilder = new MeshTxBuilder({ fetcher: this.provider, verbose: true });
    txBuilder.setNetwork("preprod");

    const unsignedTx = await txBuilder
      .txIn(feeInput.input.txHash, feeInput.input.outputIndex,
        feeInput.output.amount, feeInput.output.address)
      .spendingPlutusScriptV3()
      .txIn(tipUtxo.input.txHash, tipUtxo.input.outputIndex)
      .txInInlineDatumPresent()
      .txInRedeemerValue(mConStr0([]), "Mesh")
      .txInScript(this.scriptCbor)
      .readOnlyTxInReference(aggUtxo.input.txHash, aggUtxo.input.outputIndex)
      .mintPlutusScriptV3()
      .mint("1", this.combCfg.policy_id, newTokenName)
      .mintingScript(this.scriptCbor)
      .mintRedeemerValue(updateRedeemer, "Mesh")
      .txOut(this.combCfg.script_address, [
        { unit: "lovelace", quantity: "2000000" },
        { unit: oldTokenUnit, quantity: "1" },
      ])
      .txOutInlineDatumValue(encodeCombDatum(updatedTipDatum), "Mesh")
      .txOut(this.combCfg.script_address, [
        { unit: "lovelace", quantity: "2000000" },
        { unit: newTokenUnit, quantity: "1" },
      ])
      .txOutInlineDatumValue(encodeCombDatum(newNodeDatum), "Mesh")
      .txInCollateral(collateral.input.txHash, collateral.input.outputIndex)
      .changeAddress(walletAddress)
      .invalidBefore(currentSlot)
      .invalidHereafter(hereafter)
      .complete();

    const signedTx = await this.wallet.signTx(unsignedTx);
    const txHash = await this.wallet.submitTx(signedTx);
    console.log(`[comb] updated → ${txHash}`);
    return txHash;
  }

  // ── Burn ──────────────────────────────────────────────────────────────────

  async burn(utxoTxHash: string, outputIndex: number): Promise<string> {
    const allScriptUtxos = await this.provider.fetchAddressUTxOs(this.combCfg.script_address);
    const targetUtxo = allScriptUtxos.find(
      (u) => u.input.txHash === utxoTxHash && u.input.outputIndex === outputIndex
    );
    if (!targetUtxo) throw new Error(`UTxO ${utxoTxHash}#${outputIndex} not found at script address`);
    if (!targetUtxo.output.plutusData) throw new Error("Target UTxO has no datum");

    const datum = decodeCombDatum(targetUtxo.output.plutusData);
    if (!datum.used) throw new Error("Cannot burn current tip (used=false) — update first");

    const tokenName = datum.time.toString(16).padStart(16, "0");
    const walletAddress = this.wallet.getChangeAddress();
    const walletUtxos = await this.wallet.getUtxos();
    const collateral = await this.selectCollateral();
    const feeInput = walletUtxos.find((u) =>
      u.output.amount.some((a) => a.unit === "lovelace" && BigInt(a.quantity) >= 3_000_000n)
    ) ?? walletUtxos[0];
    if (!feeInput) throw new Error("No wallet UTxO for fees");

    const latestBlock = await this.provider.fetchLatestBlock();
    const currentSlot = Number((latestBlock as any).slot);

    const txBuilder = new MeshTxBuilder({ fetcher: this.provider, verbose: true });
    txBuilder.setNetwork("preprod");

    const unsignedTx = await txBuilder
      .txIn(feeInput.input.txHash, feeInput.input.outputIndex,
        feeInput.output.amount, feeInput.output.address)
      .spendingPlutusScriptV3()
      .txIn(targetUtxo.input.txHash, targetUtxo.input.outputIndex)
      .txInInlineDatumPresent()
      .txInRedeemerValue(mConStr0([]), "Mesh")
      .txInScript(this.scriptCbor)
      .mintPlutusScriptV3()
      .mint("-1", this.combCfg.policy_id, tokenName)
      .mintingScript(this.scriptCbor)
      .mintRedeemerValue(burnRedeemer, "Mesh")
      .txInCollateral(collateral.input.txHash, collateral.input.outputIndex)
      .changeAddress(walletAddress)
      .invalidBefore(currentSlot)
      .invalidHereafter(currentSlot + 300)
      .complete();

    const signedTx = await this.wallet.signTx(unsignedTx);
    const burnTxHash = await this.wallet.submitTx(signedTx);
    console.log(`[comb] burned → ${burnTxHash}`);
    return burnTxHash;
  }

  // ── Read chain ──────────────────────────────────────────────────────────────

  async readChain() {
    const nodes = await fetchPriceNodes(this.provider, this.combCfg);
    if (nodes.length === 0) {
      console.log("[comb] chain is empty");
      return nodes;
    }

    const tipCount = nodes.filter((n) => !n.datum.used).length;
    console.log(`[comb] chain length: ${nodes.length} (tip count: ${tipCount})`);
    console.log(`[comb] newest: ${new Date(nodes[0].datum.time).toISOString()} price=${nodes[0].datum.price}`);
    console.log(`[comb] oldest: ${new Date(nodes[nodes.length - 1].datum.time).toISOString()}`);

    const lastHour = nodes.filter((n) => n.datum.time >= Date.now() - 3_600_000);
    if (lastHour.length > 0)
      console.log(`[comb] TWAP 1h (${lastHour.length} pts): ${computeTwap(lastHour)}`);

    return nodes;
  }
}
