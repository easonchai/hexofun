//! Localnet fixture for the Weight tree, compiled only under `test-vrf`
//! (yield-claimer ticket 08).
//!
//! Real first deposits are one wallet and one transaction each, which makes a
//! 16,384-leaf tree too slow to build in a test. This appends zero-Ticket
//! leaves in bulk through the same `append_leaves` a deposit uses, so the
//! compute of a deposit or a position can be measured against a tree of that
//! size.

use anchor_lang::prelude::*;

use crate::constants::SEED_POOL;
use crate::state::{Pool, WeightTree};
use crate::weight;

pub fn test_tree_fill(ctx: Context<TestTreeFill>, count: u32) -> Result<()> {
    weight::append_leaves(
        &ctx.accounts.weight_tree,
        &ctx.accounts.pool,
        &ctx.accounts.payer.to_account_info(),
        &ctx.accounts.system_program.to_account_info(),
        count as usize,
    )?;
    Ok(())
}

#[derive(Accounts)]
pub struct TestTreeFill<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(seeds = [SEED_POOL, &pool.pool_id.to_le_bytes()], bump = pool.bump, has_one = weight_tree)]
    pub pool: Box<Account<'info, Pool>>,

    #[account(mut)]
    pub weight_tree: AccountLoader<'info, WeightTree>,

    pub system_program: Program<'info, System>,
}
