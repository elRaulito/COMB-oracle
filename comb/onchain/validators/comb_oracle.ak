use aiken/collection/list
use aiken/collection/pairs
use aiken/interval.{Finite}
use aiken/primitive/bytearray
use cardano/address.{Script}
use cardano/assets.{PolicyId, Value, flatten, quantity_of}
use cardano/transaction.{Input, InlineDatum, OutputReference, Transaction, find_input}
use comb_oracle/types.{
  AggState, Burn, CombDatum, GenericData, Init, MintRedeemer, OracleDatum, Update,
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/// Decode AggState fields from a reference input's inline datum.
fn read_agg_state(
  reference_inputs: List<Input>,
  oracle_policy_id: ByteArray,
  agg_state_token_name: ByteArray,
) -> (Int, Int, Int) {
  expect Some(agg_ref) =
    list.find(
      reference_inputs,
      fn(ri) {
        quantity_of(ri.output.value, oracle_policy_id, agg_state_token_name) == 1
      },
    )
  expect InlineDatum(agg_raw) = agg_ref.output.datum
  expect oracle_datum: OracleDatum = agg_raw
  expect AggState(price_data) = oracle_datum
  expect GenericData { price_map } = price_data
  expect Some(oracle_price) = pairs.get_first(price_map, 0)
  expect Some(creation_time) = pairs.get_first(price_map, 1)
  expect Some(expiration_time) = pairs.get_first(price_map, 2)
  (oracle_price, creation_time, expiration_time)
}

/// Mint exactly `qty` of token `tn` under `policy`, nothing else.
fn validate_single_mint(
  minted: Value,
  policy: PolicyId,
  tn: ByteArray,
  qty: Int,
) -> Bool {
  let policy_entries =
    flatten(minted)
      |> list.filter(fn(entry) {
           let (p, _, _) = entry
           p == policy
         })
  policy_entries == [(policy, tn, qty)]
}

/// Token name for a comb UTxO = 8-byte big-endian POSIX time.
fn time_to_token_name(t: Int) -> ByteArray {
  bytearray.from_int_big_endian(t, 8)
}

// ── Validator ─────────────────────────────────────────────────────────────────

/// Comb Oracle — price accumulator backed by Charli3 pull oracle.
///
/// Each UTxO holds one price reading. Token name = 8-byte big-endian `time`.
/// `time` = floor(tx_lower / interval) * interval  (current tx time bucket).
///
/// Lifecycle:
///   Init   – bootstrap: consume seed UTxO, create first price UTxO.
///   Update – advance: spend current tip (used=False → used=True), mint new tip.
///   Burn   – cleanup: burn token from a superseded (used=True) UTxO to reclaim ADA.
///
/// Parameters:
///   oracle_policy_id     – Charli3 oracle minting policy
///   agg_state_token_name – asset name of the AggState token
///   interval             – minimum ms between price points (e.g. 600_000 = 10 min)
///   seed_utxo            – one-shot UTxO that must be consumed in Init (set at deploy time)
validator comb_oracle(
  oracle_policy_id: ByteArray,
  agg_state_token_name: ByteArray,
  interval: Int,
  seed_utxo: OutputReference,
) {
  // ── Mint ──────────────────────────────────────────────────────────────────
  mint(redeemer: MintRedeemer, policy_id: PolicyId, self: Transaction) {
    when redeemer is {
      // ── Init: one-shot bootstrap ─────────────────────────────────────────
      Init -> {
        // 1. Consume the seed UTxO baked into the validator parameters
        let consumes_seed =
          list.any(self.inputs, fn(i) { i.output_reference == seed_utxo })

        // 2. Read AggState reference input
        let (oracle_price, creation_time, _expiration_time) =
          read_agg_state(self.reference_inputs, oracle_policy_id, agg_state_token_name)

        // 3. AggState must be recent (created within last 2 intervals); validity window ≤ 2×interval
        expect Finite(tx_lower) = self.validity_range.lower_bound.bound_type
        expect Finite(tx_valid_to) = self.validity_range.upper_bound.bound_type
        expect creation_time + 2 * interval >= tx_lower
        expect tx_valid_to - tx_lower <= 2 * interval

        // 4. time = floor(tx_lower / interval) * interval (current bucket from tx validity)
        let time = tx_lower / interval * interval

        // 5. Mint exactly 1 token; name = 8-byte big-endian time
        let token_name = time_to_token_name(time)
        let correct_mint = validate_single_mint(self.mint, policy_id, token_name, 1)

        // 6. Output UTxO at any address carrying the token with correct datum
        let expected_datum = CombDatum { used: False, price: oracle_price, time }
        let output_valid =
          list.any(
            self.outputs,
            fn(o) {
              if quantity_of(o.value, policy_id, token_name) == 1 {
                expect InlineDatum(raw) = o.datum
                expect d: CombDatum = raw
                d == expected_datum
              } else {
                False
              }
            },
          )

        consumes_seed && correct_mint && output_valid
      }

      // ── Update: advance the price chain ──────────────────────────────────
      Update -> {
        // 1. Read AggState reference input
        let (oracle_price, creation_time, _expiration_time) =
          read_agg_state(self.reference_inputs, oracle_policy_id, agg_state_token_name)

        // 2. AggState must be recent (created within last 2 intervals); validity window ≤ 2×interval
        expect Finite(tx_lower) = self.validity_range.lower_bound.bound_type
        expect Finite(tx_valid_to) = self.validity_range.upper_bound.bound_type
        expect creation_time + 2 * interval >= tx_lower
        expect tx_valid_to - tx_lower <= 2 * interval

        // 3. Exactly one comb UTxO consumed per tx
        let comb_inputs =
          list.filter(
            self.inputs,
            fn(i) {
              list.any(
                flatten(i.output.value),
                fn(entry) {
                  let (p, _, _) = entry
                  p == policy_id
                },
              )
            },
          )
        expect list.length(comb_inputs) == 1

        // 4. The consumed UTxO must be the current tip (used = False)
        expect Some(old_input) = list.head(comb_inputs)
        expect InlineDatum(old_raw) = old_input.output.datum
        expect old_datum: CombDatum = old_raw
        expect !old_datum.used

        // 5. New time = floor(tx_lower / interval) * interval (current tx time bucket)
        let new_time = tx_lower / interval * interval

        // 6. Must be strictly newer than previous
        expect new_time > old_datum.time

        // 7. Token names
        let old_token_name = time_to_token_name(old_datum.time)
        let new_token_name = time_to_token_name(new_time)

        // 8. Mint exactly 1 new token
        let correct_mint = validate_single_mint(self.mint, policy_id, new_token_name, 1)

        // 9. Recreate old UTxO with used=True at same address
        let script_addr = old_input.output.address
        let expected_old_out =
          CombDatum { used: True, price: old_datum.price, time: old_datum.time }
        let old_output_valid =
          list.any(
            self.outputs,
            fn(o) {
              if
              o.address == script_addr && quantity_of(o.value, policy_id, old_token_name) == 1{
                expect InlineDatum(raw) = o.datum
                expect d: CombDatum = raw
                d == expected_old_out
              } else {
                False
              }
            },
          )

        // 10. New UTxO at same address with new token and datum
        let expected_new_datum =
          CombDatum { used: False, price: oracle_price, time: new_time }
        let new_output_valid =
          list.any(
            self.outputs,
            fn(o) {
              if
              o.address == script_addr && quantity_of(o.value, policy_id, new_token_name) == 1{
                expect InlineDatum(raw) = o.datum
                expect d: CombDatum = raw
                d == expected_new_datum
              } else {
                False
              }
            },
          )

        correct_mint && old_output_valid && new_output_valid
      }

      // ── Burn: reclaim ADA from a superseded UTxO ──────────────────────────
      Burn -> {
        // 1. Exactly one comb token burned under this policy
        let burn_entries =
          flatten(self.mint)
            |> list.filter(
                 fn(entry) {
                   let (p, _, qty) = entry
                   p == policy_id && qty == -1
                 },
               )
        expect [(_, burned_tn, _)] = burn_entries

        // 2. Exactly one comb UTxO consumed
        let comb_inputs =
          list.filter(
            self.inputs,
            fn(i) { quantity_of(i.output.value, policy_id, burned_tn) == 1 },
          )
        expect list.length(comb_inputs) == 1

        // 3. The consumed UTxO must be superseded (used = True)
        expect Some(old_input) = list.head(comb_inputs)
        expect InlineDatum(raw) = old_input.output.datum
        expect d: CombDatum = raw
        expect d.used

        True
      }
    }
  }

  // ── Spend ─────────────────────────────────────────────────────────────────
  // Allow spend only when this policy is active (minting or burning).
  // The mint validator enforces all business logic.
  spend(
    _datum_opt: Option<CombDatum>,
    _redeemer: Data,
    input: OutputReference,
    self: Transaction,
  ) {
    expect Some(own_input) = find_input(self.inputs, input)
    expect Script(own_policy) = own_input.output.address.payment_credential
    list.any(flatten(self.mint), fn(entry) {
      let (p, _, _) = entry
      p == own_policy
    })
  }

  else(_) {
    fail
  }
}
