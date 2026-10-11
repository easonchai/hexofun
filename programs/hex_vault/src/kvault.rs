//! kVault backing for the venue module (venue-switch ticket 06): the pool holds
//! its position as shares of a Kamino Earn vault. `venue.rs` dispatches here
//! when `Pool::venue_kind` is `venue_kind::KVAULT`.
//!
//! Everything kVault-specific goes through the published `kvault-interface`
//! crate: its instruction builders and its zero-copy `VaultState`. Nothing is
//! copied from the kVault source.
//!
//! # The four pins
//!
//! `create_pool` stores them in the Pool's `klend_*` fields. For this kind they
//! are, in order: the kVault program, the vault state account, the vault's
//! shares mint, and the pool's token account of the shares mint. `check_pins`
//! checks all four against the vault state.
//!
//! The vault state sits in the `klend_market` slot, which every instruction
//! declares read-only, but a deposit or redeem CPI writes it. The client marks
//! it writable in the transaction message (a duplicate writable meta in the
//! remaining accounts does it); the program only reads the flag and refuses with
//! `VaultStateNotWritable` when it is off. The shares mint and the shares
//! account take the `klend_reserve` and `klend_ctoken` slots, both writable.
//!
//! # Remaining accounts
//!
//! In this order, after the pinned four. N is the number of non-empty slots in
//! the vault's allocation list, read from the vault state.
//!
//! - `0`: the klend program (the owner of every allocation reserve)
//! - `1..=N`: the allocation reserves, writable, in allocation order
//! - `N+1..=2N`: their lending markets, read-only, in the same order
//! - then nine extras: the vault's token vault, its base authority, the
//!   kVault event authority PDA, the kVault global config PDA, and for the
//!   source reserve of a redeem: its cToken vault, its lending market
//!   authority, its liquidity supply, its cToken mint, and the instructions
//!   sysvar. A value-only call (every instruction that syncs) needs only the
//!   first block, a deploy needs the first three extras, a redeem needs all nine.
//!
//! The reserve list is checked against the vault state's allocation list,
//! because the vault's value reads exactly those reserves. The extras the vault
//! derives itself are checked against the vault state or the source reserve
//! where the state names them, and kVault checks the rest.
//!
//! # Value
//!
//! `floor(shares x net AUM / shares issued) - exit_cost`, read after a klend
//! `refresh_reserves_batch` CPI over every allocation reserve (the spike's
//! formula, `research/01-kvault-spike.md`). AUM is the vault's idle tokens plus
//! every allocation's cTokens at their reserve's rate. Net means after the
//! fees the vault will charge: the recorded pending fees rounded up, plus an
//! estimate of the performance and management fees accrued since the vault's
//! last fee charge, so the value never counts yield the vault will keep.
//!
//! The vault pays 1,000 base units less than the formula on every withdraw
//! (spike, confirmed on the fork: a flat shortfall for burns from 2,000 shares
//! to 50M, whatever the fee fields say; its `min_withdraw_amount` is the same
//! 1,000). When the withdraw has to disinvest from a reserve, klend's floor on
//! the cTokens' worth costs one more unit (measured), so the cost is 1,001.
//! `exit_cost` is 1,010, with headroom for a reserve rate above 1. It comes off
//! the value, so a full redeem never returns less than the value says. A
//! partial redeem pays it again on each call, which the callers book as dust
//! against `fee_owed`, as they do klend's one-unit rounding.
//!
//! A vault may also set a withdrawal penalty, `withdrawal_penalty_bps` of the
//! payout plus `withdrawal_penalty_lamports` flat, which it keeps for the
//! remaining holders (the Institutional Commodity Yield vault charges 1 bps
//! plus 1 unit, measured on a fork 2026-10-11: a 30,000.001010 USDC burn paid
//! 29,997.001009). It comes off the value the same way as the exit cost, so a
//! deploy books it as dust at once and a full redeem still returns at least the
//! value; a redeem grosses its burn up by it.
//!
//! # Redeem
//!
//! Burns the shares worth `amount + exit_cost`, grossed up for the penalty, at
//! the conservative price, so the payout is at least `amount`. When the vault cannot pay that much now
//! (idle tokens plus the source reserve's free liquidity, or the pool's own
//! shares) it burns what the limit allows and pays less. The caller books what
//! arrived. `recall`, `harvest` and the refund path refuse a short payout with
//! `VenueShortReturn`; a drain books it.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::invoke,
};
use klend_interface::instructions::refresh_reserves_batch;
use klend_interface::state::Reserve;
use klend_interface::util::{readonly, writable};
use klend_interface::{from_account_data as reserve_from_data, SYSVAR_INSTRUCTIONS_ID};
use kvault_interface::instructions::deposit::{deposit as deposit_ix, DepositAccounts};
use kvault_interface::instructions::withdraw::{withdraw as withdraw_ix, WithdrawAccounts};
use kvault_interface::state::{from_account_data as vault_from_data, VaultState};
use kvault_interface::KVAULT_PROGRAM_ID;

use super::klend::{
    check_fresh, ctoken_value, invoke_pool_signed, rebuild, same, total_supply_sf, FRACTION_BITS,
};
use crate::errors::HexVaultError;
use crate::state::Pool;
use crate::venue::{Funds, ReserveStats, Venue};

/// What the vault keeps of every withdraw, in USDC atomic units. Measured
/// 2026-10-07 on a mainnet fork: the payout is the formula minus exactly this,
/// for every burn that succeeds. The vault's own `min_withdraw_amount` is the
/// same number; whichever is larger is used.
const VAULT_KEEPS: u64 = 1_000;
/// What klend's floor can take on top when the withdraw disinvests from a
/// reserve: one unit measured at a rate of 1.06, so ten leaves room for a
/// reserve that has earned many times more.
const DISINVEST_ROUNDING: u64 = 10;
/// The value of a position is its shares' worth less this, and a redeem burns
/// shares for the amount plus this (`exit_cost` with the usual minimum).
#[cfg(test)]
const EXIT_COST: u64 = VAULT_KEEPS + DISINVEST_ROUNDING;

fn exit_cost(min_withdraw: u64) -> u64 {
    VAULT_KEEPS
        .max(min_withdraw)
        .saturating_add(DISINVEST_ROUNDING)
}

const BPS: u128 = 10_000;
const SECONDS_PER_YEAR: u128 = 31_536_000;

/// The vault's withdrawal penalty, read off its state: `bps` of every payout
/// plus `flat` units, both kept by the vault.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Penalty {
    pub bps: u64,
    pub flat: u64,
}

impl Penalty {
    #[cfg(test)]
    pub const NONE: Penalty = Penalty { bps: 0, flat: 0 };

    /// What the vault keeps of a payout of `tokens`, rounded against the pool.
    fn of(&self, tokens: u128) -> u128 {
        (tokens * u128::from(self.bps)).div_ceil(BPS) + u128::from(self.flat)
    }

    /// The payout the vault must compute so that `base` arrives after the
    /// penalty: the smallest `gross` with `gross - of(gross) >= base`.
    fn gross_up(&self, base: u64) -> Result<u64> {
        require!(u128::from(self.bps) < BPS, HexVaultError::VenueIlliquid);
        let base = u128::from(base);
        let mut gross = ((base + u128::from(self.flat)) * BPS).div_ceil(BPS - u128::from(self.bps));
        // The ceilings can leave it one or two units under; never more.
        while gross - self.of(gross) < base {
            gross += 1;
        }
        u64::try_from(gross).map_err(|_| error!(HexVaultError::ArithmeticOverflow))
    }
}

/// SPL token account, byte offsets: mint, amount, owner, and the length.
const TOKEN_MINT: usize = 0;
const TOKEN_OWNER: usize = 32;
const TOKEN_AMOUNT: usize = 64;
const TOKEN_ACCOUNT_LEN: usize = 165;

/// Indices into the extras that follow the reserve and market blocks.
const X_TOKEN_VAULT: usize = 0;
const X_BASE_AUTHORITY: usize = 1;
const X_EVENT_AUTHORITY: usize = 2;
const X_GLOBAL_CONFIG: usize = 3;
const X_SOURCE_CTOKEN_VAULT: usize = 4;
const X_SOURCE_MARKET_AUTHORITY: usize = 5;
const X_SOURCE_LIQUIDITY: usize = 6;
const X_SOURCE_CTOKEN_MINT: usize = 7;
const X_SYSVAR: usize = 8;
const DEPOSIT_EXTRAS: usize = 3;
const REDEEM_EXTRAS: usize = 9;

// ---- Pure arithmetic ------------------------------------------------------

/// The fee fields of a `VaultState` the AUM estimate needs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Fees {
    pub prev_aum_sf: u128,
    pub pending_sf: u128,
    pub performance_bps: u64,
    pub management_bps: u64,
    pub last_charge: u64,
}

fn ceil_sf(sf: u128) -> u128 {
    (sf >> FRACTION_BITS) + u128::from(sf & ((1u128 << FRACTION_BITS) - 1) != 0)
}

/// The vault's assets under management after the fees it owes, never more than
/// the vault will price a share at.
///
/// `gross` is the idle tokens plus every allocation at its fresh rate. The
/// vault's own books hold `prev_aum + pending` as the gross at its last fee
/// charge, so anything above that is yield it has not taken a fee on yet: the
/// performance fee on it, and the management fee for the time since, come off
/// here, both rounded up.
pub fn net_aum(gross: u64, fees: &Fees, now: i64) -> u64 {
    let pending = ceil_sf(fees.pending_sf);
    let at_last_charge = (fees.prev_aum_sf + fees.pending_sf) >> FRACTION_BITS;
    let earned = u128::from(gross).saturating_sub(at_last_charge);
    let performance = (earned * u128::from(fees.performance_bps)).div_ceil(BPS);
    let elapsed =
        u128::try_from(now.saturating_sub(i64::try_from(fees.last_charge).unwrap_or(i64::MAX)))
            .unwrap_or(0);
    let management = ((fees.prev_aum_sf >> FRACTION_BITS)
        .saturating_mul(u128::from(fees.management_bps))
        .saturating_mul(elapsed))
    .div_ceil(BPS * SECONDS_PER_YEAR);
    let owed = pending
        .saturating_add(performance)
        .saturating_add(management);
    u64::try_from(u128::from(gross).saturating_sub(owed)).unwrap_or(u64::MAX)
}

/// What a full redeem of `shares` returns, at most: the shares' worth at the
/// net AUM, rounded down, less the penalty on it and what the vault keeps.
/// Zero shares are worth zero, not a negative exit cost.
pub fn position_value(
    shares: u64,
    net: u64,
    issued: u64,
    exit_cost: u64,
    penalty: Penalty,
) -> Result<u64> {
    if shares == 0 || issued == 0 {
        return Ok(0);
    }
    let worth = u128::from(shares) * u128::from(net) / u128::from(issued);
    let after_penalty = worth.saturating_sub(penalty.of(worth));
    let value =
        u64::try_from(after_penalty).map_err(|_| error!(HexVaultError::ArithmeticOverflow))?;
    Ok(value.saturating_sub(exit_cost))
}

/// Shares to burn for `tokens` of payout before the exit cost. Rounded up when
/// `round_up` (asking for at least `tokens`), down when capped by liquidity
/// (asking for at most `tokens`).
pub fn shares_for(tokens: u64, net: u64, issued: u64, round_up: bool) -> Result<u64> {
    require!(net > 0 && issued > 0, HexVaultError::VenueIlliquid);
    let n = u128::from(tokens) * u128::from(issued);
    let net = u128::from(net);
    let shares = if round_up { n.div_ceil(net) } else { n / net };
    u64::try_from(shares).map_err(|_| error!(HexVaultError::VenueIlliquid))
}

/// How many shares a redeem of `amount` burns, and what the vault is expected
/// to pay for them before the exit cost.
///
/// - `want` is `amount`, lifted to the vault's minimum withdraw.
/// - The burn is priced at `want + exit_cost`, grossed up for the penalty, so
///   the payout reaches `want`.
/// - `limit` is what the vault can pay now before the exit cost: idle tokens
///   plus the source reserve's free liquidity. A burn above it is cut down to
///   it, rounded down, so the CPI cannot fail on liquidity.
/// - `held` caps the burn at the pool's shares.
///
/// Fails with `VenueIlliquid` when nothing above the minimum can move.
#[allow(clippy::too_many_arguments)]
pub fn redeem_shares(
    amount: u64,
    net: u64,
    issued: u64,
    exit_cost: u64,
    min_withdraw: u64,
    limit: u64,
    held: u64,
    penalty: Penalty,
) -> Result<u64> {
    let want = amount.max(min_withdraw);
    let tokens = penalty.gross_up(
        want.checked_add(exit_cost)
            .ok_or(HexVaultError::ArithmeticOverflow)?,
    )?;
    let shares = if tokens <= limit {
        shares_for(tokens, net, issued, true)?
    } else {
        shares_for(limit, net, issued, false)?
    };
    let shares = shares.min(held);
    // The vault refuses a payout under its minimum; the payout is the burn's
    // worth less the penalty and the exit cost.
    let paid = u128::from(shares) * u128::from(net) / u128::from(issued);
    require!(
        paid.saturating_sub(penalty.of(paid)) >= u128::from(exit_cost) + u128::from(min_withdraw),
        HexVaultError::VenueIlliquid
    );
    Ok(shares)
}

// ---- Account plumbing -----------------------------------------------------

/// The remaining accounts after they were checked against the vault state.
struct Layout<'a, 'info> {
    klend: &'a AccountInfo<'info>,
    reserves: &'a [AccountInfo<'info>],
    markets: &'a [AccountInfo<'info>],
    extras: &'a [AccountInfo<'info>],
    /// The allocation slot of each reserve, in the order they were passed.
    slots: Vec<usize>,
}

fn vault_state<'a>(venue: &Venue<'_, '_>, data: &'a [u8]) -> Result<&'a VaultState> {
    require_keys_eq!(
        *venue.market.owner,
        *venue.program.key,
        HexVaultError::VaultStateUnreadable
    );
    vault_from_data::<VaultState>(data).map_err(|_| error!(HexVaultError::VaultStateUnreadable))
}

fn is_empty_slot(reserve: &impl AsRef<[u8]>) -> bool {
    reserve.as_ref().iter().all(|b| *b == 0)
}

/// Splits the remaining accounts and checks the reserve block against the vault
/// state's allocation list.
fn layout<'a, 'info>(venue: &Venue<'a, 'info>) -> Result<Layout<'a, 'info>> {
    let data = venue.market.try_borrow_data()?;
    let state = vault_state(venue, &data)?;
    let slots: Vec<usize> = state
        .vault_allocation_strategy
        .iter()
        .enumerate()
        .filter(|(_, a)| !is_empty_slot(&a.reserve.to_bytes()))
        .map(|(i, _)| i)
        .collect();
    let n = slots.len();
    let [klend, rest @ ..] = venue.remaining else {
        return err!(ErrorCode::AccountNotEnoughKeys);
    };
    require!(rest.len() >= 2 * n, ErrorCode::AccountNotEnoughKeys);
    let (reserves, tail) = rest.split_at(n);
    let (markets, extras) = tail.split_at(n);
    for (info, &slot) in reserves.iter().zip(&slots) {
        require!(
            same(
                info.key,
                &state.vault_allocation_strategy[slot].reserve.to_bytes()
            ) && info.owner == klend.key,
            HexVaultError::VaultAccountMismatch
        );
    }
    Ok(Layout {
        klend,
        reserves,
        markets,
        extras,
        slots,
    })
}

/// Makes every allocation reserve current, the way the vault does before it
/// prices anything.
fn refresh(l: &Layout<'_, '_>) -> Result<()> {
    let metas = l
        .reserves
        .iter()
        .zip(l.markets)
        .flat_map(|(r, m)| {
            [
                writable(r.key.to_bytes().into()),
                readonly(m.key.to_bytes().into()),
            ]
        })
        .collect();
    let ix = rebuild!(refresh_reserves_batch(true, metas), l.klend.key);
    let mut infos = Vec::with_capacity(l.reserves.len() * 2 + 1);
    infos.extend(l.reserves.iter().cloned());
    infos.extend(l.markets.iter().cloned());
    infos.push(l.klend.clone());
    invoke(&ix, &infos)?;
    Ok(())
}

/// One allocation: what the vault's cTokens in the reserve are worth, and what
/// the reserve can pay out now.
struct Holding {
    value: u64,
    available: u64,
}

/// The vault, priced.
struct Snapshot {
    idle: u64,
    issued: u64,
    net: u64,
    exit_cost: u64,
    min_withdraw: u64,
    penalty: Penalty,
    holdings: Vec<Holding>,
}

impl Snapshot {
    /// What the vault can pay out now, before the exit cost: its idle tokens
    /// and every reserve's free liquidity up to what the vault holds there.
    fn withdrawable(&self) -> u64 {
        let reserves: u128 = self
            .holdings
            .iter()
            .map(|h| u128::from(h.value.min(h.available)))
            .sum();
        u64::try_from(u128::from(self.idle) + reserves).unwrap_or(u64::MAX)
    }
}

/// Reads and prices the vault. Every reserve must be fresh in this slot, which
/// the caller's refresh (or an earlier instruction's) guarantees, and is
/// refused with `ReserveStale` when it is not.
fn snapshot(venue: &Venue<'_, '_>, l: &Layout<'_, '_>) -> Result<Snapshot> {
    let clock = Clock::get()?;
    let data = venue.market.try_borrow_data()?;
    let state = vault_state(venue, &data)?;
    let mut gross = u128::from(state.token_available);
    let mut holdings = Vec::with_capacity(l.slots.len());
    for (info, &slot) in l.reserves.iter().zip(&l.slots) {
        let rdata = info.try_borrow_data()?;
        let reserve: &Reserve =
            reserve_from_data(&rdata).map_err(|_| error!(HexVaultError::ReserveUnreadable))?;
        check_fresh(&reserve.last_update, clock.slot)?;
        let held = state.vault_allocation_strategy[slot].ctoken_allocation;
        let value = ctoken_value(
            held,
            total_supply_sf(reserve)?,
            reserve.collateral.mint_total_supply,
        )?;
        gross += u128::from(value);
        holdings.push(Holding {
            value,
            available: reserve.available_liquidity(),
        });
    }
    let gross = u64::try_from(gross).map_err(|_| error!(HexVaultError::ArithmeticOverflow))?;
    let fees = Fees {
        prev_aum_sf: u128::from(state.prev_aum_sf),
        pending_sf: u128::from(state.pending_fees_sf),
        performance_bps: state.performance_fee_bps,
        management_bps: state.management_fee_bps,
        last_charge: state.last_fee_charge_timestamp,
    };
    Ok(Snapshot {
        idle: state.token_available,
        issued: state.shares_issued,
        net: net_aum(gross, &fees, clock.unix_timestamp),
        exit_cost: exit_cost(state.min_withdraw_amount),
        min_withdraw: state.min_withdraw_amount,
        penalty: Penalty {
            bps: state.withdrawal_penalty_bps,
            flat: state.withdrawal_penalty_lamports,
        },
        holdings,
    })
}

/// The pool's shares: the pinned account must be a classic SPL token account of
/// the pinned shares mint.
fn shares_held(venue: &Venue<'_, '_>) -> Result<u64> {
    require_keys_eq!(
        *venue.ctoken.owner,
        anchor_spl::token::ID,
        HexVaultError::VaultPinMismatch
    );
    let data = venue.ctoken.try_borrow_data()?;
    require!(
        data.len() >= TOKEN_ACCOUNT_LEN
            && data[TOKEN_MINT..TOKEN_MINT + 32] == venue.reserve.key.to_bytes(),
        HexVaultError::VaultPinMismatch
    );
    let mut amount = [0u8; 8];
    amount.copy_from_slice(&data[TOKEN_AMOUNT..TOKEN_AMOUNT + 8]);
    Ok(u64::from_le_bytes(amount))
}

pub fn value(_pool: &Pool, venue: &Venue<'_, '_>) -> Result<u64> {
    let l = layout(venue)?;
    refresh(&l)?;
    let snap = snapshot(venue, &l)?;
    position_value(
        shares_held(venue)?,
        snap.net,
        snap.issued,
        snap.exit_cost,
        snap.penalty,
    )
}

/// The vault's assets under management as supply, what it can pay out now as
/// available, so the two deploy caps keep their constants and their meaning.
/// Reads without refreshing, like the klend backing: the caller synced in this
/// slot, and `snapshot` still refuses a stale reserve.
pub fn reserve_stats(_pool: &Pool, venue: &Venue<'_, '_>) -> Result<ReserveStats> {
    let l = layout(venue)?;
    let snap = snapshot(venue, &l)?;
    Ok(ReserveStats {
        supply: snap.net,
        available: snap.withdrawable(),
    })
}

/// The vault's own accounts, taken from the vault state and checked against the
/// extras and the pins.
fn check_vault_accounts(
    venue: &Venue<'_, '_>,
    l: &Layout<'_, '_>,
    funds: &Funds<'_, '_>,
    needed: usize,
) -> Result<()> {
    require!(
        venue.market.is_writable,
        HexVaultError::VaultStateNotWritable
    );
    require!(l.extras.len() >= needed, ErrorCode::AccountNotEnoughKeys);
    // The event authority is the one account the builders derive themselves and
    // the program cannot read off the vault state; a wrong one would fail the
    // CPI with an unnamed missing-account error.
    let (event_authority, _) =
        Pubkey::find_program_address(&[b"__event_authority"], venue.program.key);
    require_keys_eq!(
        *l.extras[X_EVENT_AUTHORITY].key,
        event_authority,
        HexVaultError::VaultAccountMismatch
    );
    let data = venue.market.try_borrow_data()?;
    let state = vault_state(venue, &data)?;
    require!(
        same(venue.reserve.key, &state.shares_mint.to_bytes())
            && same(l.extras[X_TOKEN_VAULT].key, &state.token_vault.to_bytes())
            && same(
                l.extras[X_BASE_AUTHORITY].key,
                &state.base_vault_authority.to_bytes()
            )
            && same(&funds.mint.key(), &state.token_mint.to_bytes())
            && same(&funds.token_program.key(), &state.token_program.to_bytes())
            && funds.token_program.key() == anchor_spl::token::ID,
        HexVaultError::VaultAccountMismatch
    );
    Ok(())
}

/// Every account the CPI might name, for `invoke_signed` to find by key.
fn candidates<'info>(
    pool: &Account<'info, Pool>,
    venue: &Venue<'_, 'info>,
    l: &Layout<'_, 'info>,
    funds: &Funds<'_, 'info>,
) -> Vec<AccountInfo<'info>> {
    let mut infos = Vec::with_capacity(l.reserves.len() * 2 + l.extras.len() + 9);
    infos.push(pool.to_account_info());
    infos.push(venue.program.clone());
    infos.push(venue.market.clone());
    infos.push(venue.reserve.clone());
    infos.push(venue.ctoken.clone());
    infos.push(funds.vault.to_account_info());
    infos.push(funds.mint.to_account_info());
    infos.push(funds.token_program.to_account_info());
    infos.push(l.klend.clone());
    infos.extend(l.reserves.iter().cloned());
    infos.extend(l.markets.iter().cloned());
    infos.extend(l.extras.iter().cloned());
    infos
}

/// Moves `amount` USDC from the principal vault into the vault, and the shares
/// to the pool's shares account. The vault credits the deposit at its own
/// price, which can be a few base units under `amount`; the caller books what
/// the value rose by.
pub fn deposit<'info>(
    pool: &Account<'info, Pool>,
    venue: &Venue<'_, 'info>,
    funds: &Funds<'_, 'info>,
    amount: u64,
) -> Result<()> {
    let l = layout(venue)?;
    check_vault_accounts(venue, &l, funds, DEPOSIT_EXTRAS)?;
    let ix = rebuild!(
        deposit_ix(
            DepositAccounts {
                user: pool.key().to_bytes().into(),
                vault_state: venue.market.key.to_bytes().into(),
                token_vault: l.extras[X_TOKEN_VAULT].key.to_bytes().into(),
                token_mint: funds.mint.key().to_bytes().into(),
                base_vault_authority: l.extras[X_BASE_AUTHORITY].key.to_bytes().into(),
                shares_mint: venue.reserve.key.to_bytes().into(),
                user_token_ata: funds.vault.key().to_bytes().into(),
                user_shares_ata: venue.ctoken.key.to_bytes().into(),
                klend_program: l.klend.key.to_bytes().into(),
                token_program: funds.token_program.key().to_bytes().into(),
                shares_token_program: funds.token_program.key().to_bytes().into(),
            },
            amount,
            l.reserves
                .iter()
                .map(|r| writable(r.key.to_bytes().into()))
                .chain(l.markets.iter().map(|m| readonly(m.key.to_bytes().into())))
                .collect(),
        ),
        venue.program.key
    );
    invoke_pool_signed(pool, &ix, &candidates(pool, venue, &l, funds))
}

/// Burns shares for at least `amount` USDC into the principal vault, or for as
/// much as the vault can pay now when that is less (see the module doc). The
/// source reserve is the one whose cToken vault the caller passed: the vault
/// pays from its idle tokens first and from that reserve for the rest.
pub fn redeem<'info>(
    pool: &Account<'info, Pool>,
    venue: &Venue<'_, 'info>,
    funds: &Funds<'_, 'info>,
    amount: u64,
) -> Result<()> {
    let l = layout(venue)?;
    check_vault_accounts(venue, &l, funds, REDEEM_EXTRAS)?;
    let snap = snapshot(venue, &l)?;
    let source = {
        let data = venue.market.try_borrow_data()?;
        let state = vault_state(venue, &data)?;
        l.slots
            .iter()
            .position(|&slot| {
                same(
                    l.extras[X_SOURCE_CTOKEN_VAULT].key,
                    &state.vault_allocation_strategy[slot]
                        .ctoken_vault
                        .to_bytes(),
                )
            })
            .ok_or(HexVaultError::VaultAccountMismatch)?
    };
    {
        let rdata = l.reserves[source].try_borrow_data()?;
        let reserve: &Reserve =
            reserve_from_data(&rdata).map_err(|_| error!(HexVaultError::ReserveUnreadable))?;
        require!(
            same(
                l.extras[X_SOURCE_LIQUIDITY].key,
                &reserve.liquidity.supply_vault.to_bytes()
            ) && same(
                l.extras[X_SOURCE_CTOKEN_MINT].key,
                &reserve.collateral.mint_pubkey.to_bytes()
            ) && same(l.extras[X_SYSVAR].key, &SYSVAR_INSTRUCTIONS_ID.to_bytes()),
            HexVaultError::KlendAccountMismatch
        );
    }
    let from = &snap.holdings[source];
    let limit = snap.idle.saturating_add(from.value.min(from.available));
    let shares = redeem_shares(
        amount,
        snap.net,
        snap.issued,
        snap.exit_cost,
        snap.min_withdraw,
        limit,
        shares_held(venue)?,
        snap.penalty,
    )?;
    let ix = rebuild!(
        withdraw_ix(
            WithdrawAccounts {
                user: pool.key().to_bytes().into(),
                vault_state: venue.market.key.to_bytes().into(),
                global_config: l.extras[X_GLOBAL_CONFIG].key.to_bytes().into(),
                token_vault: l.extras[X_TOKEN_VAULT].key.to_bytes().into(),
                base_vault_authority: l.extras[X_BASE_AUTHORITY].key.to_bytes().into(),
                user_token_ata: funds.vault.key().to_bytes().into(),
                token_mint: funds.mint.key().to_bytes().into(),
                user_shares_ata: venue.ctoken.key.to_bytes().into(),
                shares_mint: venue.reserve.key.to_bytes().into(),
                token_program: funds.token_program.key().to_bytes().into(),
                shares_token_program: funds.token_program.key().to_bytes().into(),
                klend_program: l.klend.key.to_bytes().into(),
                invested_vault_state: venue.market.key.to_bytes().into(),
                reserve: l.reserves[source].key.to_bytes().into(),
                ctoken_vault: l.extras[X_SOURCE_CTOKEN_VAULT].key.to_bytes().into(),
                lending_market: l.markets[source].key.to_bytes().into(),
                lending_market_authority: l.extras[X_SOURCE_MARKET_AUTHORITY].key.to_bytes().into(),
                reserve_liquidity_supply: l.extras[X_SOURCE_LIQUIDITY].key.to_bytes().into(),
                reserve_collateral_mint: l.extras[X_SOURCE_CTOKEN_MINT].key.to_bytes().into(),
                reserve_collateral_token_program: funds.token_program.key().to_bytes().into(),
                instruction_sysvar_account: l.extras[X_SYSVAR].key.to_bytes().into(),
            },
            shares,
            l.reserves
                .iter()
                .map(|r| writable(r.key.to_bytes().into()))
                .chain(l.markets.iter().map(|m| readonly(m.key.to_bytes().into())))
                .collect(),
        ),
        venue.program.key
    );
    invoke_pool_signed(pool, &ix, &candidates(pool, venue, &l, funds))
}

/// `create_pool`'s check of the four pins of a kVault pool against the vault
/// state: the kVault program (the mainnet one, the only one the interface
/// crate's builders address), the vault state account it owns, the vault's
/// shares mint, and a classic token account of that mint owned by the pool.
/// The vault must hold the pool's accepted mint under the classic token
/// program.
pub fn check_pins(
    program: &AccountInfo,
    vault: &AccountInfo,
    shares_mint: &AccountInfo,
    shares_account: &AccountInfo,
    accepted_mint: &Pubkey,
    pool: &Pubkey,
) -> Result<()> {
    require!(
        same(program.key, &KVAULT_PROGRAM_ID.to_bytes()),
        HexVaultError::VaultPinMismatch
    );
    require_keys_eq!(
        *vault.owner,
        *program.key,
        HexVaultError::VaultStateUnreadable
    );
    let data = vault.try_borrow_data()?;
    let state = vault_from_data::<VaultState>(&data)
        .map_err(|_| error!(HexVaultError::VaultStateUnreadable))?;
    require!(
        same(shares_mint.key, &state.shares_mint.to_bytes())
            && *shares_mint.owner == anchor_spl::token::ID,
        HexVaultError::VaultPinMismatch
    );
    require!(
        same(accepted_mint, &state.token_mint.to_bytes())
            && same(&anchor_spl::token::ID, &state.token_program.to_bytes()),
        HexVaultError::VaultMintMismatch
    );
    require_keys_eq!(
        *shares_account.owner,
        anchor_spl::token::ID,
        HexVaultError::VaultPinMismatch
    );
    let token = shares_account.try_borrow_data()?;
    require!(
        token.len() >= TOKEN_ACCOUNT_LEN
            && token[TOKEN_MINT..TOKEN_MINT + 32] == shares_mint.key.to_bytes()
            && token[TOKEN_OWNER..TOKEN_OWNER + 32] == pool.to_bytes(),
        HexVaultError::VaultPinMismatch
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use core::mem::offset_of;
    use kvault_interface::state::VaultAllocation;

    const ONE: u128 = 1 << FRACTION_BITS;

    /// The live RockawayX figures from the spike, read right after a deposit.
    fn spike_fees() -> Fees {
        Fees {
            prev_aum_sf: 66_368_566_433_528 * ONE,
            pending_sf: 2_951_268_845 * ONE,
            performance_bps: 500,
            management_bps: 0,
            last_charge: 1_000,
        }
    }

    #[test]
    fn the_layout_matches_the_spike_offsets() {
        // The spike read these straight off the account, discriminator included.
        let at = |offset: usize| offset + 8;
        assert_eq!(at(offset_of!(VaultState, base_vault_authority)), 40);
        assert_eq!(at(offset_of!(VaultState, token_mint)), 80);
        assert_eq!(at(offset_of!(VaultState, token_vault)), 120);
        assert_eq!(at(offset_of!(VaultState, token_program)), 152);
        assert_eq!(at(offset_of!(VaultState, shares_mint)), 184);
        assert_eq!(at(offset_of!(VaultState, token_available)), 224);
        assert_eq!(at(offset_of!(VaultState, shares_issued)), 232);
        assert_eq!(at(offset_of!(VaultState, performance_fee_bps)), 256);
        assert_eq!(at(offset_of!(VaultState, management_fee_bps)), 264);
        assert_eq!(at(offset_of!(VaultState, last_fee_charge_timestamp)), 272);
        assert_eq!(at(offset_of!(VaultState, prev_aum_sf)), 280);
        assert_eq!(at(offset_of!(VaultState, pending_fees_sf)), 296);
        assert_eq!(at(offset_of!(VaultState, vault_allocation_strategy)), 312);
        assert_eq!(at(offset_of!(VaultState, min_withdraw_amount)), 58_416);
        // Read off the Institutional Commodity Yield vault on a fork, 2026-10-11.
        assert_eq!(
            at(offset_of!(VaultState, withdrawal_penalty_lamports)),
            58_680
        );
        assert_eq!(at(offset_of!(VaultState, withdrawal_penalty_bps)), 58_688);
        assert_eq!(offset_of!(VaultAllocation, ctoken_vault), 32);
        assert_eq!(offset_of!(VaultAllocation, ctoken_allocation), 1_104);
        assert_eq!(core::mem::size_of::<VaultAllocation>(), 2_160);
    }

    #[test]
    fn net_aum_matches_the_vaults_own_books_right_after_a_touch() {
        // Gross equals prev + pending at the last charge: nothing unrecorded.
        let gross = 66_371_517_702_373;
        let net = net_aum(gross, &spike_fees(), 1_000);
        // The vault stored prev_aum 66_368_566_433_528; ours is the same or
        // one unit under (the pending fees round up).
        assert!(
            net == 66_368_566_433_528 || net == 66_368_566_433_527,
            "{net}"
        );
    }

    #[test]
    fn yield_since_the_last_charge_pays_its_performance_fee() {
        let touched = net_aum(66_371_517_702_373, &spike_fees(), 1_000);
        // 1 USDC earned since: 5% of it is the vault's.
        let later = net_aum(66_371_517_702_373 + 1_000_000, &spike_fees(), 1_000);
        assert_eq!(later - touched, 950_000);
    }

    #[test]
    fn management_fee_accrues_per_second_and_rounds_up() {
        let mut fees = spike_fees();
        fees.performance_bps = 0;
        fees.management_bps = 100; // 1% a year
        let gross = 66_371_517_702_373;
        let a_year = net_aum(gross, &fees, 1_000 + 31_536_000);
        let none = net_aum(gross, &fees, 1_000);
        // 1% of prev_aum, rounded up.
        assert_eq!(none - a_year, 663_685_664_336);
        // A clock before the last charge owes nothing.
        assert_eq!(net_aum(gross, &fees, 10), none);
    }

    #[test]
    fn gross_below_the_vaults_books_never_goes_negative() {
        assert_eq!(net_aum(5, &spike_fees(), 1_000), 0);
    }

    #[test]
    fn the_spike_position_values_under_the_deposit() {
        // 500 USDC bought 482,811,493 shares; the formula said 499,999,987.
        let net = 66_368_566_433_527;
        let issued = 64_087_014_918_202;
        let v = position_value(482_811_493, net, issued, 0, Penalty::NONE).unwrap();
        assert!(v <= 500_000_000 && 500_000_000 - v < 100, "{v}");
        // With the exit cost off: what a full redeem returns, at most.
        assert_eq!(
            position_value(482_811_493, net, issued, EXIT_COST, Penalty::NONE).unwrap(),
            v - EXIT_COST
        );
        assert_eq!(
            position_value(0, net, issued, EXIT_COST, Penalty::NONE).unwrap(),
            0
        );
        assert_eq!(
            position_value(10, net, issued, EXIT_COST, Penalty::NONE).unwrap(),
            0
        );
    }

    /// What the vault pays, worst case measured: the formula less the penalty
    /// as the vault rounds it (down on the bps, measured 2026-10-11), less
    /// 1,000 and less one more for klend's floor on a disinvest.
    fn payout_with(shares: u64, net: u64, issued: u64, p: Penalty) -> u64 {
        let worth = u128::from(shares) * u128::from(net) / u128::from(issued);
        let penalty = worth * u128::from(p.bps) / BPS + u128::from(p.flat);
        (worth - penalty) as u64 - VAULT_KEEPS - 1
    }

    fn payout(shares: u64, net: u64, issued: u64) -> u64 {
        payout_with(shares, net, issued, Penalty::NONE)
    }

    /// The Institutional Commodity Yield vault's penalty.
    const ONE_BPS: Penalty = Penalty { bps: 1, flat: 1 };

    #[test]
    fn a_redeem_pays_at_least_the_amount() {
        let (net, issued) = (66_368_566_433_527u64, 64_087_014_918_202u64);
        for amount in [
            1_000u64,
            1_001,
            2_000,
            12_345,
            1_000_000,
            333_666_660,
            9_000_000_000,
        ] {
            let shares = redeem_shares(
                amount,
                net,
                issued,
                EXIT_COST,
                1_000,
                u64::MAX,
                u64::MAX,
                Penalty::NONE,
            )
            .unwrap();
            assert!(
                payout(shares, net, issued) >= amount.max(1_000),
                "{amount} -> {shares}"
            );
            // Not by much: the ten units of headroom and a share of rounding.
            assert!(
                payout(shares, net, issued) <= amount.max(1_000) + 12,
                "{amount} -> {shares}"
            );
        }
    }

    #[test]
    fn a_penalised_redeem_pays_at_least_the_amount_and_not_much_more() {
        let (net, issued) = (66_368_566_433_527u64, 64_087_014_918_202u64);
        for amount in [
            1_000u64,
            1_001,
            2_000,
            12_345,
            1_000_000,
            333_666_660,
            30_000_000_000,
        ] {
            let shares = redeem_shares(
                amount,
                net,
                issued,
                EXIT_COST,
                10,
                u64::MAX,
                u64::MAX,
                ONE_BPS,
            )
            .unwrap();
            let paid = payout_with(shares, net, issued, ONE_BPS);
            assert!(paid >= amount, "{amount} -> {shares} pays {paid}");
            // Headroom, two units of ceiling slack, and a share of rounding.
            assert!(paid <= amount + 14, "{amount} -> {shares} pays {paid}");
        }
    }

    #[test]
    fn the_fork_measured_burn_is_grossed_up_past_what_the_vault_kept() {
        // 2026-10-11: a 30,000.001010 burn paid 29,997.001009, so the gross-up
        // for 30,000.001010 must clear that shortfall.
        let gross = ONE_BPS.gross_up(30_000_001_010).unwrap();
        assert!(gross - (gross / 10_000) - 1 >= 30_000_001_010, "{gross}");
        assert!(gross <= 30_003_001_320, "{gross}");
        // No penalty, no change.
        assert_eq!(Penalty::NONE.gross_up(12_345).unwrap(), 12_345);
        // Each of the first ten thousand bases clears its own penalty.
        for base in 0..10_000u64 {
            let g = u128::from(ONE_BPS.gross_up(base).unwrap());
            assert!(g - ONE_BPS.of(g) >= u128::from(base), "{base} -> {g}");
            assert!(g - ONE_BPS.of(g) <= u128::from(base) + 2, "{base} -> {g}");
        }
        // A penalty of everything cannot be grossed up.
        assert!(Penalty {
            bps: 10_000,
            flat: 0
        }
        .gross_up(1)
        .is_err());
    }

    #[test]
    fn a_full_redeem_never_returns_less_than_the_penalised_value() {
        let (net, issued) = (66_368_566_433_527u64, 64_087_014_918_202u64);
        for shares in [2_000u64, 482_811_493, 29_544_077_666, 133_000_000_000_000] {
            let value = position_value(shares, net, issued, EXIT_COST, ONE_BPS).unwrap();
            assert!(
                payout_with(shares, net, issued, ONE_BPS) >= value,
                "{shares}"
            );
            // And the penalty is the only difference from the unpenalised value.
            let plain = position_value(shares, net, issued, EXIT_COST, Penalty::NONE).unwrap();
            assert!(
                plain - value <= plain / 10_000 + 2,
                "{shares}: {plain} vs {value}"
            );
        }
    }

    #[test]
    fn a_small_redeem_is_lifted_to_the_vaults_minimum() {
        let (net, issued) = (66_368_566_433_527u64, 64_087_014_918_202u64);
        let shares = redeem_shares(
            10,
            net,
            issued,
            EXIT_COST,
            1_000,
            u64::MAX,
            u64::MAX,
            Penalty::NONE,
        )
        .unwrap();
        assert!(payout(shares, net, issued) >= 1_000);
    }

    #[test]
    fn liquidity_caps_the_burn_and_the_payout_comes_up_short() {
        let (net, issued) = (66_368_566_433_527u64, 64_087_014_918_202u64);
        let limit = 5_000_000;
        let shares = redeem_shares(
            9_000_000,
            net,
            issued,
            EXIT_COST,
            1_000,
            limit,
            u64::MAX,
            Penalty::NONE,
        )
        .unwrap();
        let paid_before_cost = (u128::from(shares) * u128::from(net) / u128::from(issued)) as u64;
        assert!(paid_before_cost <= limit, "{paid_before_cost}");
        assert!(paid_before_cost > limit - 10);
        assert!(payout(shares, net, issued) < 9_000_000);
    }

    #[test]
    fn the_pools_own_shares_cap_the_burn() {
        let (net, issued) = (66_368_566_433_527u64, 64_087_014_918_202u64);
        let shares = redeem_shares(
            9_000_000,
            net,
            issued,
            EXIT_COST,
            1_000,
            u64::MAX,
            1_000_000,
            Penalty::NONE,
        )
        .unwrap();
        assert_eq!(shares, 1_000_000);
    }

    #[test]
    fn nothing_above_the_minimum_to_pay_is_illiquid_by_name() {
        let (net, issued) = (66_368_566_433_527u64, 64_087_014_918_202u64);
        // Liquidity under the exit cost plus the minimum.
        let err = redeem_shares(
            5_000,
            net,
            issued,
            EXIT_COST,
            1_000,
            1_500,
            u64::MAX,
            Penalty::NONE,
        )
        .unwrap_err();
        assert!(format!("{err:?}").contains("VenueIlliquid"));
        // No shares at all.
        let err = redeem_shares(
            5_000,
            net,
            issued,
            EXIT_COST,
            1_000,
            u64::MAX,
            0,
            Penalty::NONE,
        )
        .unwrap_err();
        assert!(format!("{err:?}").contains("VenueIlliquid"));
        // An empty vault prices nothing.
        assert!(shares_for(5_000, 0, issued, true).is_err());
    }

    #[test]
    fn withdrawable_is_idle_plus_what_each_reserve_can_pay() {
        let snap = Snapshot {
            idle: 100,
            issued: 1,
            net: 1,
            exit_cost: EXIT_COST,
            min_withdraw: 1_000,
            penalty: Penalty::NONE,
            holdings: vec![
                Holding {
                    value: 500,
                    available: 900,
                },
                Holding {
                    value: 500,
                    available: 200,
                },
                Holding {
                    value: 0,
                    available: 50,
                },
            ],
        };
        assert_eq!(snap.withdrawable(), 100 + 500 + 200);
    }

    #[test]
    fn an_all_zero_key_is_an_empty_allocation_slot() {
        assert!(is_empty_slot(&[0u8; 32]));
        assert!(!is_empty_slot(&[0, 0, 1]));
    }
}
