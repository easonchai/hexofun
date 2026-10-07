//! Releasing and reusing Weight tree leaves (mainnet-readiness-fixes ticket
//! 08).
//!
//! A leaf is a position in the Fenwick tree, not an owner (`weight_tree.rs`),
//! so a Player with nothing in the tree can give its position back and the next
//! first deposit takes it instead of growing the account. The positions wait on
//! a stack in the pool's `FreeLeaves` account: a 40-byte header, then `u32`
//! leaf indices. `release_leaf` pushes, paying any rent for growth; `deposit`
//! pops, so a reuse costs the depositor nothing extra.
//!
//! Reuse is sound because a released leaf adds 0 to the live `principal_sum`
//! and reads 0 Tickets in both readable epochs, so no pending draw or payout
//! can land on the new owner.

use anchor_lang::__private::bytemuck;
use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, Transfer};

use crate::constants::{FREE_LEAVES_VERSION, SEED_FREE_LEAVES, SEED_PLAYER, SEED_POOL};
use crate::errors::HexVaultError;
use crate::events::LeafReleased;
use crate::state::{FreeLeaves, Player, Pool, WeightTree};
use crate::weight;
use crate::weight_tree::MAX_NODES;

/// The discriminator and the `FreeLeaves` header; a multiple of 4, so the
/// entries after it are 4-aligned.
pub const HEADER_BYTES: usize = 8 + 40;

const ENTRY_BYTES: usize = 4;

/// Bytes of an account that holds `capacity` entries.
pub fn account_len(capacity: usize) -> usize {
    HEADER_BYTES + capacity * ENTRY_BYTES
}

/// Sets the header of a just-created account. Called by `create_pool`.
pub fn init(account: &AccountLoader<FreeLeaves>, pool: Pubkey) -> Result<()> {
    let mut header = account.load_init()?;
    header.count = 0;
    header.version = FREE_LEAVES_VERSION;
    header.pool = pool;
    Ok(())
}

/// The pure stack: `entries` is the account's capacity, the first `count` of
/// them live.
fn pop_from(entries: &[u32], count: &mut u32) -> Option<u32> {
    let top = count.checked_sub(1)?;
    *count = top;
    entries.get(top as usize).copied()
}

fn push_onto(entries: &mut [u32], count: &mut u32, leaf: u32) -> Result<()> {
    let slot = entries
        .get_mut(*count as usize)
        .ok_or(HexVaultError::FreeLeavesInvalid)?;
    *slot = leaf;
    *count += 1;
    Ok(())
}

fn split(data: &mut [u8]) -> Result<(&mut FreeLeaves, &mut [u32])> {
    let invalid = || error!(HexVaultError::FreeLeavesInvalid);
    require!(data.len() >= HEADER_BYTES, HexVaultError::FreeLeavesInvalid);
    let (head, body) = data.split_at_mut(HEADER_BYTES);
    let header: &mut FreeLeaves =
        bytemuck::try_from_bytes_mut(&mut head[8..]).map_err(|_| invalid())?;
    let entries: &mut [u32] = bytemuck::try_cast_slice_mut(body).map_err(|_| invalid())?;
    require!(
        header.count as usize <= entries.len(),
        HexVaultError::FreeLeavesInvalid
    );
    Ok((header, entries))
}

/// Takes the most recently released leaf, or `None` when the stack is empty
/// and the caller appends instead.
pub fn pop(account: &AccountLoader<FreeLeaves>) -> Result<Option<u32>> {
    let info = account.to_account_info();
    let mut data = info.try_borrow_mut_data()?;
    let (header, entries) = split(&mut data)?;
    Ok(pop_from(entries, &mut header.count))
}

/// Puts `leaf` on the stack. Grows the account by one entry, `payer` paying
/// the rent, only when every slot is taken.
pub fn push<'info>(
    account: &AccountLoader<'info, FreeLeaves>,
    payer: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    leaf: u32,
) -> Result<()> {
    let info = account.to_account_info();
    let (count, capacity) = {
        let mut data = info.try_borrow_mut_data()?;
        let (header, entries) = split(&mut data)?;
        (header.count as usize, entries.len())
    };
    if count == capacity {
        // Each leaf sits on the stack once, so the stack never outgrows the tree.
        require!(capacity < MAX_NODES, HexVaultError::FreeLeavesInvalid);
        let new_len = account_len(capacity + 1);
        let short = Rent::get()?
            .minimum_balance(new_len)
            .saturating_sub(info.lamports());
        if short > 0 {
            system_program::transfer(
                CpiContext::new(
                    system_program.key(),
                    Transfer {
                        from: payer.clone(),
                        to: info.clone(),
                    },
                ),
                short,
            )?;
        }
        info.resize(new_len)?;
    }
    let mut data = info.try_borrow_mut_data()?;
    let (header, entries) = split(&mut data)?;
    push_onto(entries, &mut header.count, leaf)
}

/// What `release_leaf` asks of the Player itself. The tree's own check (no
/// Tickets in either readable epoch) is `weight::check_leaf_empty`.
pub fn check_releasable(player: &Player) -> Result<()> {
    require!(!player.is_house, HexVaultError::HouseLeafCannotBeReleased);
    require!(player.leaf_index != 0, HexVaultError::PlayerHasNoLeaf);
    require!(
        player.principal == 0 && player.pending_withdraw == 0 && player.open_positions == 0,
        HexVaultError::LeafInUse
    );
    Ok(())
}

/// Permissionless: anyone can give an empty Player's leaf back, and pays the
/// rent if the stack has to grow.
pub fn release_leaf(ctx: Context<ReleaseLeaf>) -> Result<()> {
    let a = ctx.accounts;
    check_releasable(&a.player)?;
    weight::check_leaf_empty(&a.weight_tree, &a.pool, &a.player)?;

    let leaf_index = a.player.leaf_index;
    push(
        &a.free_leaves,
        &a.payer.to_account_info(),
        &a.system_program.to_account_info(),
        leaf_index,
    )?;
    a.player.leaf_index = 0;

    emit!(LeafReleased {
        pool: a.pool.key(),
        owner: a.player.owner,
        leaf_index,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct ReleaseLeaf<'info> {
    /// Pays the rent if the stack grows. Any key.
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        seeds = [SEED_POOL, &pool.pool_id.to_le_bytes()],
        bump = pool.bump,
        has_one = weight_tree,
    )]
    pub pool: Box<Account<'info, Pool>>,

    #[account(
        mut,
        seeds = [SEED_PLAYER, pool.key().as_ref(), player.owner.as_ref()],
        bump = player.bump,
    )]
    pub player: Box<Account<'info, Player>>,

    pub weight_tree: AccountLoader<'info, WeightTree>,

    #[account(mut, seeds = [SEED_FREE_LEAVES, pool.key().as_ref()], bump)]
    pub free_leaves: AccountLoader<'info, FreeLeaves>,

    pub system_program: Program<'info, System>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::weight_tree::{self as tree, Clock, Node};

    #[test]
    fn pops_in_reverse_order_and_reports_empty() {
        let mut entries = [0u32; 3];
        let mut count = 0;
        assert_eq!(pop_from(&entries, &mut count), None);
        push_onto(&mut entries, &mut count, 7).unwrap();
        push_onto(&mut entries, &mut count, 9).unwrap();
        assert_eq!(pop_from(&entries, &mut count), Some(9));
        assert_eq!(pop_from(&entries, &mut count), Some(7));
        assert_eq!(pop_from(&entries, &mut count), None);
        assert_eq!(count, 0);
    }

    #[test]
    fn a_full_stack_refuses_a_push() {
        let mut entries = [0u32; 1];
        let mut count = 0;
        push_onto(&mut entries, &mut count, 2).unwrap();
        assert!(push_onto(&mut entries, &mut count, 3).is_err());
    }

    #[test]
    fn a_pop_leaves_capacity_for_the_next_push() {
        let mut entries = [0u32; 1];
        let mut count = 0;
        push_onto(&mut entries, &mut count, 2).unwrap();
        assert_eq!(pop_from(&entries, &mut count), Some(2));
        push_onto(&mut entries, &mut count, 5).unwrap();
        assert_eq!(entries[0], 5);
    }

    fn player(set: impl FnOnce(&mut Player)) -> Player {
        let mut p = Player::deserialize(&mut &vec![0u8; Player::INIT_SPACE][..]).unwrap();
        p.leaf_index = 2;
        set(&mut p);
        p
    }

    fn refused(p: &Player, code: HexVaultError) -> bool {
        match check_releasable(p) {
            Err(Error::AnchorError(e)) => e.error_code_number == u32::from(code),
            _ => false,
        }
    }

    #[test]
    fn release_is_refused_while_the_player_holds_anything() {
        assert!(check_releasable(&player(|_| {})).is_ok());
        assert!(refused(&player(|p| p.principal = 1), HexVaultError::LeafInUse));
        assert!(refused(&player(|p| p.pending_withdraw = 1), HexVaultError::LeafInUse));
        assert!(refused(&player(|p| p.open_positions = 1), HexVaultError::LeafInUse));
        assert!(refused(&player(|p| p.leaf_index = 0), HexVaultError::PlayerHasNoLeaf));
    }

    #[test]
    fn the_house_cannot_be_released() {
        assert!(refused(
            &player(|p| p.is_house = true),
            HexVaultError::HouseLeafCannotBeReleased
        ));
    }

    // Tree side of the same rule, on a three-leaf tree where leaf 2 is the
    // Player under test.
    fn tree_of_three(clock: &Clock) -> Vec<Node> {
        let mut nodes = Vec::new();
        for _ in 0..3 {
            let node = tree::append(&nodes, clock).unwrap();
            nodes.push(node);
        }
        nodes
    }

    #[test]
    fn release_is_refused_while_tickets_remain_in_the_current_epoch() {
        let clock = Clock { current: 5 };
        let mut nodes = tree_of_three(&clock);
        assert!(tree::is_empty(&nodes, 2, &clock).unwrap());
        tree::update(&mut nodes, 2, 10, 10, &clock).unwrap();
        assert!(!tree::is_empty(&nodes, 2, &clock).unwrap());
        tree::update(&mut nodes, 2, -10, -10, &clock).unwrap();
        assert!(tree::is_empty(&nodes, 2, &clock).unwrap());
    }

    #[test]
    fn release_is_refused_while_the_previous_epoch_still_reads_tickets() {
        let mut nodes = tree_of_three(&Clock { current: 5 });
        tree::update(&mut nodes, 2, 10, 10, &Clock { current: 5 }).unwrap();

        // Everything leaves in epoch 6, but epoch 5's draw may still pay.
        let six = Clock { current: 6 };
        tree::update(&mut nodes, 2, -10, -10, &six).unwrap();
        assert!(!tree::is_empty(&nodes, 2, &six).unwrap());

        // Epoch 5 is no longer readable in epoch 7.
        assert!(tree::is_empty(&nodes, 2, &Clock { current: 7 }).unwrap());
    }

    #[test]
    fn a_released_leaf_is_reused_without_growing_or_moving_old_reads() {
        let five = Clock { current: 5 };
        let mut nodes = tree_of_three(&five);
        tree::update(&mut nodes, 1, 4, 4, &five).unwrap();
        tree::update(&mut nodes, 2, 10, 10, &five).unwrap();
        tree::update(&mut nodes, 2, -10, -10, &five).unwrap();

        let mut entries = [0u32; 1];
        let mut count = 0;
        push_onto(&mut entries, &mut count, 2).unwrap();
        let leaf = pop_from(&entries, &mut count).unwrap();
        assert_eq!(leaf, 2);

        // A new owner deposits 7 on the reused leaf in the next epoch.
        let six = Clock { current: 6 };
        let before = tree::prefix(&nodes, nodes.len(), 5, &six).unwrap();
        tree::update(&mut nodes, leaf as usize, 7, 0, &six).unwrap();
        assert_eq!(nodes.len(), 3);
        assert_eq!(tree::prefix(&nodes, nodes.len(), 5, &six).unwrap(), before);
        assert_eq!(tree::prefix(&nodes, nodes.len(), 6, &six).unwrap(), 4);
        assert_eq!(tree::leaf_range(&nodes, 2, 5, &six).unwrap(), (4, 4));
    }

    #[test]
    fn the_header_layout_is_pinned() {
        assert_eq!(HEADER_BYTES % ENTRY_BYTES, 0);
        assert_eq!(account_len(2), HEADER_BYTES + 8);
    }
}
