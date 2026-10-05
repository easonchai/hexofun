//! klend backing for the venue module (yield-claimer ticket 12, spec "Venue
//! module"). Compiled only without `test-venue`; `venue.rs` re-exports the
//! three operations from here.
//!
//! Everything klend-specific lives in this file and goes through the published
//! `klend-interface` crate: its instruction builders and its zero-copy
//! `Reserve`. Nothing is copied from the kVault source.
//!
//! - **value.** Refreshes the reserve by CPI, fails with `ReserveStale` if it
//!   is still not fresh, then values the pool's cTokens at the reserve's
//!   exchange rate, `floor(cTokens x total supply / cToken supply)`, reading
//!   the reserve through `Reserve` instead of CPI-ing klend's own rate call
//!   (about 4k CU cheaper, ticket 01).
//! - **deposit, redeem.** CPIs signed by the pool PDA. Both need the reserve
//!   fresh, which every caller guarantees by syncing first.
//!
//! The refresh is `refresh_reserves_batch` with `skip_price_updates = true`.
//! It needs no oracle account, and deposit, redeem and valuing cTokens never
//! read the price (ticket 01, `progress-01.md`).
//!
//! The venue's four pinned accounts are checked by `Venue::check`. A deposit or
//! redeem takes these extra accounts in `Venue::remaining`, in order:
//!
//! 0. lending market authority (PDA of the market, seed `lma`)
//! 1. the reserve's liquidity supply vault
//! 2. the reserve's cToken mint
//! 3. the instructions sysvar
//!
//! Each is checked against the reserve where the reserve names it, and klend
//! checks them again. The liquidity mint is `Funds::mint`, and the token
//! program must be the classic SPL one, which klend uses for cTokens.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::{invoke, invoke_signed},
};
use klend_interface::instructions::{
    deposit_reserve_liquidity, redeem_reserve_collateral, refresh_reserves_batch,
    DepositReserveLiquidityAccounts, RedeemReserveCollateralAccounts,
};
use klend_interface::state::{LastUpdate, Reserve};
use klend_interface::util::{readonly, writable};
use klend_interface::{from_account_data, SYSVAR_INSTRUCTIONS_ID, TOKEN_PROGRAM_ID};

use crate::constants::SEED_POOL;
use crate::errors::HexVaultError;
use crate::state::Pool;
use crate::venue::{Funds, Venue};

/// Byte offsets inside an SPL token account.
const TOKEN_MINT: usize = 0;
const TOKEN_AMOUNT: usize = 64;
const TOKEN_ACCOUNT_LEN: usize = 165;

/// klend's `Fraction` has 60 fractional bits.
const FRACTION_BITS: u32 = 60;

/// Rebuilds a klend-interface instruction as an Anchor one. The crate's
/// `Pubkey` and `Instruction` come from solana-pubkey 2.x and
/// solana-instruction 2.x, which are not the types `invoke` takes. The program
/// id is the one pinned on the Pool, not the crate's mainnet constant, so a
/// pool pinned to klend's staging deployment would work too.
macro_rules! rebuild {
    ($ix:expr, $program:expr) => {{
        let ix = $ix;
        Instruction {
            program_id: *$program,
            accounts: ix
                .accounts
                .iter()
                .map(|m| AccountMeta {
                    pubkey: Pubkey::new_from_array(m.pubkey.to_bytes()),
                    is_signer: m.is_signer,
                    is_writable: m.is_writable,
                })
                .collect(),
            data: ix.data,
        }
    }};
}

/// Key equality across the two `Pubkey` types.
fn same(a: &Pubkey, b: &impl AsRef<[u8]>) -> bool {
    a.as_ref() == b.as_ref()
}

/// Makes the reserve current: accrues interest and stamps this slot. Needs
/// the reserve, the market and the klend program only.
fn refresh(venue: &Venue<'_, '_>) -> Result<()> {
    let ix = rebuild!(
        refresh_reserves_batch(
            true,
            vec![
                writable(venue.reserve.key.to_bytes().into()),
                readonly(venue.market.key.to_bytes().into()),
            ],
        ),
        venue.program.key
    );
    invoke(
        &ix,
        &[
            venue.reserve.clone(),
            venue.market.clone(),
            venue.program.clone(),
        ],
    )?;
    Ok(())
}

/// The reserve behind `info`, which klend must own. Checks the discriminator
/// and the length through `klend-interface`.
fn read_reserve<'a>(venue: &Venue<'_, '_>, data: &'a [u8]) -> Result<&'a Reserve> {
    require_keys_eq!(
        *venue.reserve.owner,
        *venue.program.key,
        HexVaultError::ReserveUnreadable
    );
    from_account_data::<Reserve>(data).map_err(|_| error!(HexVaultError::ReserveUnreadable))
}

/// The reserve must have been refreshed in this very slot, with no stale flag.
/// klend's own deposit and redeem require the same and nothing about the price
/// status.
fn check_fresh(last_update: &LastUpdate, slot: u64) -> Result<()> {
    require!(
        last_update.stale == 0 && last_update.slot == slot,
        HexVaultError::ReserveStale
    );
    Ok(())
}

/// klend's total supply, `available + borrowed - protocol fees - referrer fees
/// - pending referrer fees`, as a fixed-point number with 60 fractional bits.
fn total_supply_sf(reserve: &Reserve) -> Result<u128> {
    let l = &reserve.liquidity;
    (u128::from(l.total_available_amount) << FRACTION_BITS)
        .checked_add(u128::from(l.borrowed_amount_sf))
        .and_then(|v| v.checked_sub(u128::from(l.accumulated_protocol_fees_sf)))
        .and_then(|v| v.checked_sub(u128::from(l.accumulated_referrer_fees_sf)))
        .and_then(|v| v.checked_sub(u128::from(l.pending_referrer_fees_sf)))
        .ok_or_else(|| error!(HexVaultError::ArithmeticOverflow))
}

/// `floor(ctokens x total supply / cToken supply)` in USDC atomic units. An
/// empty reserve exchanges 1:1, as in klend.
fn ctoken_value(ctokens: u64, supply_sf: u128, ctoken_supply: u64) -> Result<u64> {
    if ctoken_supply == 0 || supply_sf == 0 {
        return Ok(ctokens);
    }
    let (bal, cs) = (u128::from(ctokens), u128::from(ctoken_supply));
    // floor(bal x supply_sf / cs) split as bal x q + bal x r / cs, which stays
    // inside u128 while the balance is at most the cToken supply, as on chain.
    // r < cs <= 2^64, so the second product always fits.
    let (q, r) = (supply_sf / cs, supply_sf % cs);
    let sf = bal
        .checked_mul(q)
        .and_then(|v| v.checked_add(bal * r / cs))
        .ok_or(HexVaultError::ArithmeticOverflow)?;
    u64::try_from(sf >> FRACTION_BITS).map_err(|_| error!(HexVaultError::ArithmeticOverflow))
}

/// cTokens that redeem for at least `amount` USDC. Divides by the floor of the
/// liquidity supply, so it can be one cToken above the minimum when the supply
/// has a large fractional part. The redeem then returns a base unit too much,
/// which the callers book as dust.
// ponytail: not the exact minimum; add a one-step refinement if a pool ever
// shows more than a unit of overshoot.
fn ctokens_for(amount: u64, supply_sf: u128, ctoken_supply: u64) -> Result<u64> {
    if ctoken_supply == 0 || supply_sf == 0 {
        return Ok(amount);
    }
    let liquidity = supply_sf >> FRACTION_BITS;
    require!(liquidity > 0, HexVaultError::VenueIlliquid);
    let n = u128::from(amount)
        .checked_mul(u128::from(ctoken_supply))
        .ok_or(HexVaultError::ArithmeticOverflow)?;
    let c = n / liquidity + u128::from(n % liquidity != 0);
    u64::try_from(c).map_err(|_| error!(HexVaultError::VenueIlliquid))
}

/// The pool's cToken balance. The pinned account must be a classic SPL token
/// account of the reserve's cToken mint.
fn ctoken_balance(ctoken: &AccountInfo, reserve: &Reserve) -> Result<u64> {
    require_keys_eq!(
        *ctoken.owner,
        anchor_spl::token::ID,
        HexVaultError::KlendAccountMismatch
    );
    let data = ctoken.try_borrow_data()?;
    require!(
        data.len() >= TOKEN_ACCOUNT_LEN
            && data[TOKEN_MINT..TOKEN_MINT + 32] == reserve.collateral.mint_pubkey.to_bytes(),
        HexVaultError::KlendAccountMismatch
    );
    let mut amount = [0u8; 8];
    amount.copy_from_slice(&data[TOKEN_AMOUNT..TOKEN_AMOUNT + 8]);
    Ok(u64::from_le_bytes(amount))
}

pub fn value(_pool: &Pool, venue: &Venue<'_, '_>) -> Result<u64> {
    refresh(venue)?;
    let data = venue.reserve.try_borrow_data()?;
    let reserve = read_reserve(venue, &data)?;
    check_fresh(&reserve.last_update, Clock::get()?.slot)?;
    let balance = ctoken_balance(venue.ctoken, reserve)?;
    ctoken_value(
        balance,
        total_supply_sf(reserve)?,
        reserve.collateral.mint_total_supply,
    )
}

/// The four extra accounts, after checking each against the reserve.
struct Extra<'a, 'info> {
    authority: &'a AccountInfo<'info>,
    supply_vault: &'a AccountInfo<'info>,
    ctoken_mint: &'a AccountInfo<'info>,
    sysvar: &'a AccountInfo<'info>,
}

fn extra<'a, 'info>(
    venue: &Venue<'a, 'info>,
    funds: &Funds<'_, 'info>,
    reserve: &Reserve,
) -> Result<Extra<'a, 'info>> {
    let [authority, supply_vault, ctoken_mint, sysvar, ..] = venue.remaining else {
        return err!(ErrorCode::AccountNotEnoughKeys);
    };
    let ok = same(supply_vault.key, &reserve.liquidity.supply_vault.to_bytes())
        && same(ctoken_mint.key, &reserve.collateral.mint_pubkey.to_bytes())
        && same(&funds.mint.key(), &reserve.liquidity.mint_pubkey.to_bytes())
        && same(venue.market.key, &reserve.lending_market.to_bytes())
        && same(sysvar.key, &SYSVAR_INSTRUCTIONS_ID.to_bytes())
        && same(&funds.token_program.key(), &TOKEN_PROGRAM_ID.to_bytes());
    require!(ok, HexVaultError::KlendAccountMismatch);
    Ok(Extra {
        authority,
        supply_vault,
        ctoken_mint,
        sysvar,
    })
}

/// Moves `amount` USDC from the principal vault into the reserve and the
/// cTokens to the pool's cToken account.
pub fn deposit<'info>(
    pool: &Account<'info, Pool>,
    venue: &Venue<'_, 'info>,
    funds: &Funds<'_, 'info>,
    amount: u64,
) -> Result<()> {
    let x = {
        let data = venue.reserve.try_borrow_data()?;
        let reserve = read_reserve(venue, &data)?;
        check_fresh(&reserve.last_update, Clock::get()?.slot)?;
        extra(venue, funds, reserve)?
    };
    let ix = rebuild!(
        deposit_reserve_liquidity(
            DepositReserveLiquidityAccounts {
                owner: pool.key().to_bytes().into(),
                reserve: venue.reserve.key.to_bytes().into(),
                lending_market: venue.market.key.to_bytes().into(),
                lending_market_authority: x.authority.key.to_bytes().into(),
                reserve_liquidity_mint: funds.mint.key().to_bytes().into(),
                reserve_liquidity_supply: x.supply_vault.key.to_bytes().into(),
                reserve_collateral_mint: x.ctoken_mint.key.to_bytes().into(),
                user_source_liquidity: funds.vault.key().to_bytes().into(),
                user_destination_collateral: venue.ctoken.key.to_bytes().into(),
                liquidity_token_program: funds.token_program.key().to_bytes().into(),
            },
            amount,
        ),
        venue.program.key
    );
    invoke_pool_signed(
        pool,
        &ix,
        &[
            pool.to_account_info(),
            venue.reserve.clone(),
            venue.market.clone(),
            x.authority.clone(),
            funds.mint.to_account_info(),
            x.supply_vault.clone(),
            x.ctoken_mint.clone(),
            funds.vault.to_account_info(),
            venue.ctoken.clone(),
            funds.token_program.to_account_info(),
            x.sysvar.clone(),
            venue.program.clone(),
        ],
    )
}

/// Redeems cTokens for at least `amount` USDC into the principal vault.
///
/// Fails with `VenueIlliquid` before any CPI when `amount` is above the
/// reserve's free liquidity, or above what the pool's cTokens are worth, since
/// a program cannot catch a failed CPI. klend's other limits are not
/// pre-checked: its daily withdrawal cap (90M USDC on the mainnet USDC reserve
/// on 2026-10-05, far above any pool here) and its withdraw queue (empty).
pub fn redeem<'info>(
    pool: &Account<'info, Pool>,
    venue: &Venue<'_, 'info>,
    funds: &Funds<'_, 'info>,
    amount: u64,
) -> Result<()> {
    let (x, ctokens) = {
        let data = venue.reserve.try_borrow_data()?;
        let reserve = read_reserve(venue, &data)?;
        check_fresh(&reserve.last_update, Clock::get()?.slot)?;
        let x = extra(venue, funds, reserve)?;
        require!(
            amount <= reserve.available_liquidity(),
            HexVaultError::VenueIlliquid
        );
        let supply_sf = total_supply_sf(reserve)?;
        let supply = reserve.collateral.mint_total_supply;
        let held = ctoken_balance(venue.ctoken, reserve)?;
        // Never more than the pool holds; if all of it is not enough the
        // amount is more than the position is worth.
        let ctokens = ctokens_for(amount, supply_sf, supply)?.min(held);
        // What klend will pay for them: at least `amount`, and no more than it
        // holds, which can differ from `amount` by the one unit of overshoot.
        let out = ctoken_value(ctokens, supply_sf, supply)?;
        require!(
            out >= amount && out <= reserve.available_liquidity(),
            HexVaultError::VenueIlliquid
        );
        (x, ctokens)
    };
    let ix = rebuild!(
        redeem_reserve_collateral(
            RedeemReserveCollateralAccounts {
                owner: pool.key().to_bytes().into(),
                lending_market: venue.market.key.to_bytes().into(),
                reserve: venue.reserve.key.to_bytes().into(),
                lending_market_authority: x.authority.key.to_bytes().into(),
                reserve_liquidity_mint: funds.mint.key().to_bytes().into(),
                reserve_collateral_mint: x.ctoken_mint.key.to_bytes().into(),
                reserve_liquidity_supply: x.supply_vault.key.to_bytes().into(),
                user_source_collateral: venue.ctoken.key.to_bytes().into(),
                user_destination_liquidity: funds.vault.key().to_bytes().into(),
                liquidity_token_program: funds.token_program.key().to_bytes().into(),
            },
            ctokens,
        ),
        venue.program.key
    );
    invoke_pool_signed(
        pool,
        &ix,
        &[
            pool.to_account_info(),
            venue.market.clone(),
            venue.reserve.clone(),
            x.authority.clone(),
            funds.mint.to_account_info(),
            x.ctoken_mint.clone(),
            x.supply_vault.clone(),
            venue.ctoken.clone(),
            funds.vault.to_account_info(),
            funds.token_program.to_account_info(),
            x.sysvar.clone(),
            venue.program.clone(),
        ],
    )
}

fn invoke_pool_signed<'info>(
    pool: &Account<'info, Pool>,
    ix: &Instruction,
    infos: &[AccountInfo<'info>],
) -> Result<()> {
    let pool_id_bytes = pool.pool_id.to_le_bytes();
    let pool_bump = [pool.bump];
    let signer_seeds: &[&[u8]] = &[SEED_POOL, &pool_id_bytes, &pool_bump];
    invoke_signed(ix, infos, &[signer_seeds])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use bytemuck::Zeroable;

    const ONE: u128 = 1 << FRACTION_BITS;

    #[test]
    fn value_is_floor_of_cokens_times_rate() {
        // Rate 1.2 (supply 1.2e6 over 1e6 cTokens), 100 cTokens.
        let supply_sf = 1_200_000 * ONE;
        assert_eq!(ctoken_value(100, supply_sf, 1_000_000).unwrap(), 120);
        // 7 x 1.2 = 8.4 floors to 8.
        assert_eq!(ctoken_value(7, supply_sf, 1_000_000).unwrap(), 8);
    }

    #[test]
    fn an_empty_reserve_is_one_to_one() {
        assert_eq!(ctoken_value(42, 0, 0).unwrap(), 42);
        assert_eq!(ctoken_value(42, 5 * ONE, 0).unwrap(), 42);
        assert_eq!(ctokens_for(42, 0, 0).unwrap(), 42);
    }

    #[test]
    fn value_does_not_overflow_at_mainnet_scale() {
        // 3e13 USDC units of supply, 2.5e13 cTokens, the pool holds all of them.
        let supply_sf = 30_000_000_000_000 * ONE + 12_345;
        let v = ctoken_value(25_000_000_000_000, supply_sf, 25_000_000_000_000).unwrap();
        assert_eq!(v, 30_000_000_000_000);
        // The full u64 range stays inside u128 as long as bal <= supply.
        assert_eq!(
            ctoken_value(u64::MAX, u128::from(u64::MAX) * ONE, u64::MAX).unwrap(),
            u64::MAX
        );
    }

    #[test]
    fn ctokens_for_redeems_at_least_the_amount() {
        for (supply, cs) in [
            (1_200_000 * ONE + 77, 1_000_000u64),
            (30_000_000_000_000 * ONE + 999, 25_000_000_000_000),
            (3 * ONE, 7),
        ] {
            for amount in [1u64, 2, 3, 99, 1_000, 123_456, 1_000_000] {
                let Ok(c) = ctokens_for(amount, supply, cs) else {
                    continue;
                };
                let got = ctoken_value(c, supply, cs).unwrap();
                assert!(got >= amount, "{amount} -> {c} -> {got}");
                // Never more than a unit or so above, at these sizes.
                assert!(got <= amount + 2, "{amount} -> {c} -> {got}");
            }
        }
    }

    #[test]
    fn ctokens_for_refuses_a_supply_under_one_unit() {
        assert!(ctokens_for(1, ONE / 2, 10).is_err());
    }

    #[test]
    fn a_stale_or_old_reserve_is_refused() {
        let mut lu = LastUpdate::zeroed();
        lu.slot = 100;
        assert!(check_fresh(&lu, 100).is_ok());
        assert!(check_fresh(&lu, 101).is_err());
        lu.stale = 1;
        assert!(check_fresh(&lu, 100).is_err());
        // Price status does not matter: klend's deposit ignores it too.
        lu.stale = 0;
        lu.price_status = 0;
        assert!(check_fresh(&lu, 100).is_ok());
    }

    #[test]
    fn total_supply_subtracts_the_three_fee_pots() {
        let mut r = Box::new(Reserve::zeroed());
        r.liquidity.total_available_amount = 1_000;
        r.liquidity.borrowed_amount_sf = (500 * ONE).into();
        r.liquidity.accumulated_protocol_fees_sf = (10 * ONE).into();
        r.liquidity.accumulated_referrer_fees_sf = (20 * ONE).into();
        r.liquidity.pending_referrer_fees_sf = (30 * ONE).into();
        assert_eq!(total_supply_sf(&r).unwrap(), 1_440 * ONE);
        // Fees above the supply cannot be valued.
        r.liquidity.accumulated_protocol_fees_sf = (9_999 * ONE).into();
        assert!(total_supply_sf(&r).is_err());
    }
}
