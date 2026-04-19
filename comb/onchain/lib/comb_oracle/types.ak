// ── Oracle datum types (Charli3 pull oracle) ─────────────────────────────────

pub type PriceMap = Pairs<Int, Int>

pub type PriceData {
  SharedData
  ExtendedData
  GenericData { price_map: PriceMap }
}

pub type OracleDatum {
  AggState(PriceData)
  OracleSettings(Data)
  RewardAccount(Data)
}

// ── Comb Oracle UTxO datum ────────────────────────────────────────────────────

/// Datum at every Comb Oracle UTxO.
///
/// used  = False on the current tip; True once superseded by a newer Update
/// price = oracle price recorded at creation (from AggState reference input)
/// time  = floor(tx_lower / interval) * interval  (POSIX ms, multiple of interval)
///
/// Token name under the comb policy = bytearray.from_int_big_endian(time, 8)
pub type CombDatum {
  used: Bool,
  price: Int,
  time: Int,
}

// ── Redeemers ─────────────────────────────────────────────────────────────────

pub type MintRedeemer {
  Init
  Update
  Burn
}

/// Redeemer for the neo withdraw validator (on-chain TWAP verifier).
///
/// granularity  – time step between sampled reference inputs (multiple of interval)
///                e.g. interval=600_000 → granularity=600_000 (10-min), 3_600_000 (1-h)
/// count        – number of price points (length of indices)
/// indices      – positions of the selected comb UTxOs in tx.reference_inputs
///                (Cardano sorts reference inputs by outref, so specify temporal order here)
///                ordered newest → oldest
/// claimed_mean – the TWAP value being asserted (sum(prices) / count)
pub type NeoRedeemer {
  granularity: Int,
  count: Int,
  indices: List<Int>,
  claimed_mean: Int,
}
