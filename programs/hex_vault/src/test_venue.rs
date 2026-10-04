//! Localnet stand-in for the yield venue, compiled only under `test-venue`
//! (yield-claimer ticket 05). Backs `venue.rs` with a stub reserve whose rate
//! any test can set, up or down, and a token vault that holds the USDC.
//!
//! The pool pins `klend_program` = this program's ID, `klend_market` = the
//! pool PDA, `klend_reserve` = the reserve PDA and `klend_ctoken` = the stub
//! vault PDA. The stub's refresh does nothing, so `stub_value` just reads.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    self, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::constants::SEED_POOL;
use crate::errors::HexVaultError;
use crate::state::Pool;
use crate::venue::{self, Funds, Venue};

pub const SEED_TEST_RESERVE: &[u8] = b"test-venue-reserve";
pub const SEED_TEST_VAULT: &[u8] = b"test-venue-vault";

/// `TestReserve::rate` is USDC per share scaled by this.
pub const RATE_SCALE: u128 = 1_000_000_000_000_000_000;

#[account]
#[derive(InitSpace)]
pub struct TestReserve {
    pub pool: Pubkey,
    pub shares: u64,
    /// USDC per share, scaled by [`RATE_SCALE`]. Starts at 1.0.
    pub rate: u128,
    pub bump: u8,
}

fn load(info: &AccountInfo) -> Result<TestReserve> {
    require_keys_eq!(*info.owner, crate::ID, ErrorCode::AccountOwnedByWrongProgram);
    TestReserve::try_deserialize(&mut &info.try_borrow_data()?[..])
}

fn store(info: &AccountInfo, reserve: &TestReserve) -> Result<()> {
    reserve.try_serialize(&mut &mut info.try_borrow_mut_data()?[..])
}

fn value_of(shares: u64, rate: u128) -> Result<u64> {
    let value = u128::from(shares)
        .checked_mul(rate)
        .ok_or(HexVaultError::ArithmeticOverflow)?
        / RATE_SCALE;
    u64::try_from(value).map_err(|_| error!(HexVaultError::ArithmeticOverflow))
}

/// `floor(shares x rate / 1e18)`.
pub fn stub_value(_pool: &Pool, venue: &Venue<'_, '_>) -> Result<u64> {
    let reserve = load(venue.reserve)?;
    value_of(reserve.shares, reserve.rate)
}

/// Adds `floor(amount x 1e18 / rate)` shares.
pub fn stub_deposit<'info>(
    pool: &Account<'info, Pool>,
    venue: &Venue<'_, 'info>,
    funds: &Funds<'_, 'info>,
    amount: u64,
) -> Result<()> {
    let mut reserve = load(venue.reserve)?;
    let minted = u128::from(amount)
        .checked_mul(RATE_SCALE)
        .ok_or(HexVaultError::ArithmeticOverflow)?
        / reserve.rate.max(1);
    reserve.shares = reserve
        .shares
        .checked_add(u64::try_from(minted).map_err(|_| error!(HexVaultError::ArithmeticOverflow))?)
        .ok_or(HexVaultError::ArithmeticOverflow)?;
    store(venue.reserve, &reserve)?;
    move_usdc(pool, funds, &funds.vault.to_account_info(), venue.ctoken, amount)
}

/// Burns `ceil(amount x 1e18 / rate)` shares. Fails with `VenueIlliquid` when
/// the stub vault holds less than `amount`, or fewer shares than that.
pub fn stub_redeem<'info>(
    pool: &Account<'info, Pool>,
    venue: &Venue<'_, 'info>,
    funds: &Funds<'_, 'info>,
    amount: u64,
) -> Result<()> {
    let vault = TokenAccount::try_deserialize(&mut &venue.ctoken.try_borrow_data()?[..])?;
    require!(vault.amount >= amount, HexVaultError::VenueIlliquid);

    let mut reserve = load(venue.reserve)?;
    let rate = reserve.rate.max(1);
    let burned = u128::from(amount)
        .checked_mul(RATE_SCALE)
        .ok_or(HexVaultError::ArithmeticOverflow)?
        .checked_add(rate - 1)
        .ok_or(HexVaultError::ArithmeticOverflow)?
        / rate;
    let burned = u64::try_from(burned).map_err(|_| error!(HexVaultError::VenueIlliquid))?;
    reserve.shares = reserve
        .shares
        .checked_sub(burned)
        .ok_or(HexVaultError::VenueIlliquid)?;
    store(venue.reserve, &reserve)?;
    move_usdc(pool, funds, venue.ctoken, &funds.vault.to_account_info(), amount)
}

/// The stub vault and the principal vault are both owned by the pool PDA, so
/// the pool signs either direction.
fn move_usdc<'info>(
    pool: &Account<'info, Pool>,
    funds: &Funds<'_, 'info>,
    from: &AccountInfo<'info>,
    to: &AccountInfo<'info>,
    amount: u64,
) -> Result<()> {
    let pool_id_bytes = pool.pool_id.to_le_bytes();
    let pool_bump = [pool.bump];
    let signer_seeds: &[&[u8]] = &[SEED_POOL, &pool_id_bytes, &pool_bump];
    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            funds.token_program.key(),
            TransferChecked {
                from: from.clone(),
                mint: funds.mint.to_account_info(),
                to: to.clone(),
                authority: pool.to_account_info(),
            },
            &[signer_seeds],
        ),
        amount,
        funds.mint.decimals,
    )
}

pub fn test_venue_init(ctx: Context<TestVenueInit>) -> Result<()> {
    let reserve = &mut ctx.accounts.reserve;
    reserve.pool = ctx.accounts.pool.key();
    reserve.shares = 0;
    reserve.rate = RATE_SCALE;
    reserve.bump = ctx.bumps.reserve;
    Ok(())
}

pub fn test_set_venue_rate(ctx: Context<TestSetVenueRate>, rate: u128) -> Result<()> {
    require!(rate > 0, HexVaultError::InvalidParameter);
    ctx.accounts.reserve.rate = rate;
    Ok(())
}

pub fn test_sync<'info>(ctx: Context<'info, TestSync<'info>>) -> Result<()> {
    let a = &mut *ctx.accounts;
    let venue = Venue {
        program: &a.klend_program,
        market: &a.klend_market,
        reserve: &a.klend_reserve,
        ctoken: &a.klend_ctoken,
        remaining: ctx.remaining_accounts,
    };
    venue::sync(&mut a.pool, &venue)?;
    Ok(())
}

/// Called once after `create_pool`. Permissionless: it only creates the two
/// PDAs the pool's pinned venue addresses point at.
#[derive(Accounts)]
pub struct TestVenueInit<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(seeds = [SEED_POOL, &pool.pool_id.to_le_bytes()], bump = pool.bump)]
    pub pool: Box<Account<'info, Pool>>,

    #[account(address = pool.accepted_mint @ HexVaultError::MintMismatch)]
    pub accepted_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        init,
        payer = payer,
        seeds = [SEED_TEST_RESERVE, pool.key().as_ref()],
        bump,
        space = 8 + TestReserve::INIT_SPACE,
    )]
    pub reserve: Box<Account<'info, TestReserve>>,

    #[account(
        init,
        payer = payer,
        seeds = [SEED_TEST_VAULT, pool.key().as_ref()],
        bump,
        token::mint = accepted_mint,
        token::authority = pool,
        token::token_program = token_program,
    )]
    pub venue_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct TestSetVenueRate<'info> {
    #[account(seeds = [SEED_POOL, &pool.pool_id.to_le_bytes()], bump = pool.bump)]
    pub pool: Box<Account<'info, Pool>>,

    #[account(
        mut,
        seeds = [SEED_TEST_RESERVE, pool.key().as_ref()],
        bump = reserve.bump,
    )]
    pub reserve: Box<Account<'info, TestReserve>>,
}

#[derive(Accounts)]
pub struct TestSync<'info> {
    #[account(mut, seeds = [SEED_POOL, &pool.pool_id.to_le_bytes()], bump = pool.bump)]
    pub pool: Box<Account<'info, Pool>>,

    /// CHECK: `venue::check` pins it to `pool.klend_program`.
    pub klend_program: UncheckedAccount<'info>,
    /// CHECK: `venue::check` pins it to `pool.klend_market`.
    pub klend_market: UncheckedAccount<'info>,
    /// CHECK: `venue::check` pins it to `pool.klend_reserve`.
    #[account(mut)]
    pub klend_reserve: UncheckedAccount<'info>,
    /// CHECK: `venue::check` pins it to `pool.klend_ctoken`.
    #[account(mut)]
    pub klend_ctoken: UncheckedAccount<'info>,
}
