// ── Charli3 pull oracle node HTTP API ────────────────────────────────────────

export interface OdvFeedRequest {
  oracle_nft_policy_id: string;
  tx_validity_interval: { start: number; end: number };
}

export interface SignedNodeMessage {
  /** CBOR hex of OracleNodeMessage (Constr 0 [feed_int, timestamp_int, policy_id_bytes]) */
  message: string;
  signature: string;
  verification_key: string;
}

export interface NodeConfig {
  root_url: string;
  pub_key: string;
}

// ── AggState (decoded from Charli3 onchain UTxO) ─────────────────────────────

export interface AggStateData {
  price: bigint;
  creation_time: number;   // POSIX ms
  expiration_time: number; // POSIX ms
}

// ── Comb Oracle UTxO datum ────────────────────────────────────────────────────

export interface CombDatum {
  used: boolean;   // False = current tip; True = superseded
  price: bigint;
  time: number;    // POSIX ms, multiple of interval
}

export interface PriceNodeUtxo {
  txHash: string;
  outputIndex: number;
  datum: CombDatum;
}

// ── Redeemers ─────────────────────────────────────────────────────────────────

export interface NeoRedeemer {
  granularity: number;
  count: number;
  indices: number[];
  claimed_mean: bigint;
}

// ── Config (YAML) ─────────────────────────────────────────────────────────────

export interface CombOracleConfig {
  oracle_policy_id: string;
  agg_state_token_name: string;
  node_prefix?: string;
  min_interval: number;
  policy_id: string;
  script_address: string;
  oracle_script_cbor?: string;
  neo_script_cbor?: string;
  seed_utxo?: { tx_hash: string; output_index: number };
}

export interface OdvTxSignatureRequest {
  node_messages: Record<string, SignedNodeMessage>;
  tx_body_cbor: string;
}

export interface OdvClientConfig {
  network: {
    network: string;
    blockfrost?: { project_id: string };
  };
  wallet: { mnemonic: string };
  oracle_address: string;
  policy_id: string;
  odv_validity_length: number;
  reference_script: {
    address: string;
    utxo_reference: {
      transaction_id: string;
      output_index: number;
    };
  };
  nodes: NodeConfig[];
  comb_oracle: CombOracleConfig;
}
