//! Localnet stand-in for ORAO VRF, compiled only under `test-vrf`.
//!
//! Fabricates a fulfilled `RandomnessV2` account at the address
//! [`crate::vrf::randomness_address`] expects, so the epoch draw
//! can be tested end to end with no ORAO program deployed.

use anchor_lang::prelude::*;
use anchor_lang::system_program::{create_account, CreateAccount};

use crate::vrf::{self, TEST_VRF_SEED};

pub fn test_fulfill(ctx: Context<TestFulfill>, seed: [u8; 32], randomness: [u8; 64]) -> Result<()> {
    let bump = ctx.bumps.randomness;
    let bump_seed = [bump];
    let signer_seeds: &[&[u8]] = &[TEST_VRF_SEED, &seed, &bump_seed];

    let space = vrf::FULFILLED_LEN as u64;
    let rent = Rent::get()?.minimum_balance(vrf::FULFILLED_LEN);

    create_account(
        CpiContext::new_with_signer(
            ctx.accounts.system_program.key(),
            CreateAccount {
                from: ctx.accounts.payer.to_account_info(),
                to: ctx.accounts.randomness.to_account_info(),
            },
            &[signer_seeds],
        ),
        rent,
        space,
        &crate::ID,
    )?;

    // Mirrors ORAO's fulfilled `RandomnessV2` layout byte for byte: an
    // Anchor discriminator (the account name hashes the same regardless of
    // which program declares it), a Fulfilled tag, then client/seed/
    // randomness. `read_fulfilled` only ever reads this shape back.
    let mut data = ctx.accounts.randomness.try_borrow_mut_data()?;
    data[..8].copy_from_slice(&vrf::randomness_discriminator());
    data[8] = 1; // ORAO RequestAccount::Fulfilled
    data[9..41].copy_from_slice(ctx.accounts.payer.key().as_ref()); // client stand-in
    data[41..73].copy_from_slice(&seed);
    data[73..vrf::FULFILLED_LEN].copy_from_slice(&randomness);

    Ok(())
}

#[derive(Accounts)]
#[instruction(seed: [u8; 32])]
pub struct TestFulfill<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: fabricated ORAO `RandomnessV2` account, created and written
    /// here instead of deserialized.
    #[account(mut, seeds = [TEST_VRF_SEED, seed.as_ref()], bump)]
    pub randomness: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}
