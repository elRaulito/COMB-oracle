use aiken/collection/list
use aiken/interval.{Finite}
use aiken/primitive/bytearray
use cardano/address.{Credential}
use cardano/assets.{flatten}
use cardano/transaction.{InlineDatum, Transaction}
use comb_oracle/types.{CombDatum, NeoRedeemer}

/// Neo — on-chain TWAP verifier for the Comb Oracle price chain.
///
/// Triggered as a withdrawal script. Any transaction that wants to assert
/// a verified TWAP must include a withdrawal from this script's stake address
/// with a NeoRedeemer describing the selected price points.
///
/// Parameters:
///   comb_policy_id – minting policy of the comb_oracle validator
///   interval       – base interval in ms (same as comb_oracle's interval)
validator neo(comb_policy_id: ByteArray, interval: Int) {
  withdraw(redeemer: NeoRedeemer, _account: Credential, self: Transaction) {
    // 1. Basic sanity
    expect redeemer.count > 0
    expect list.length(redeemer.indices) == redeemer.count
    expect redeemer.granularity > 0
    expect redeemer.granularity % interval == 0

    // 2. Tx validity window must be ≤ interval so "now" is well-defined
    expect Finite(tx_lower) = self.validity_range.lower_bound.bound_type
    expect Finite(tx_valid_to) = self.validity_range.upper_bound.bound_type
    expect tx_valid_to - tx_lower <= interval

    // 3. For each index (newest → oldest), fetch the reference input and decode datum
    //    Cardano sorts reference_inputs by TxOutRef, so indices specify temporal order.
    let ref_inputs = self.reference_inputs

    let price_time_pairs =
      list.map(
        redeemer.indices,
        fn(idx) {
          expect Some(ri) = list.at(ref_inputs, idx)
          // Must carry exactly one comb token (8-byte name) under comb_policy_id
          let comb_tokens =
            flatten(ri.output.value)
              |> list.filter(
                  fn(entry) {
                    let (p, tn, qty) = entry
                    p == comb_policy_id && bytearray.length(tn) == 8 && qty == 1
                  },
                )
          expect list.length(comb_tokens) == 1
          // Decode datum
          expect InlineDatum(raw) = ri.output.datum
          expect d: CombDatum = raw
          (d.price, d.time)
        },
      )

    // 4. Freshness: newest price (first in list) must be within 2 intervals of tx_lower
    expect Some((_, newest_time)) = list.head(price_time_pairs)
    expect newest_time >= tx_lower - 2 * interval

    // 5. Timestamps must form an arithmetic sequence spaced by granularity (newest → oldest)
    //    times[i] == newest_time - i * granularity
    let (times_valid, _) =
      list.foldl(
        price_time_pairs,
        (True, 0),
        fn(pt, acc) {
          let (valid, i) = acc
          let (_, t) = pt
          (valid && t == newest_time - i * redeemer.granularity, i + 1)
        },
      )
    expect times_valid

    // 6. Verify claimed_mean = floor(sum(prices) / count)
    let price_sum =
      list.foldl(
        price_time_pairs,
        0,
        fn(pt, acc) {
          let (p, _) = pt
          acc + p
        },
      )
    let computed_mean = price_sum / redeemer.count
    expect computed_mean == redeemer.claimed_mean

    True
  }

  else(_) {
    fail
  }
}
