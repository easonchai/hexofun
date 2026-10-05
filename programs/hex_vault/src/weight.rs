//! The pool's Weight tree account (ADR 0018, yield-claimer tickets 08 and 19).
//!
//! `weight_tree.rs` is the pure Fenwick arithmetic on a slice of nodes. This
//! module maps the pool's zero-copy account onto that slice and gives each
//! instruction three things: a [`Change`] to collect what it did to one
//! Player's Principal and Tickets, [`apply`] to write it in one walk of the
//! update path, and the draw's reads ([`root`], [`check_winner`]).
//!
//! The account is a 48-byte header and then `node_count` nodes of 56 bytes.
//! The first deposit by a Player grows it by one node ([`append_leaves`]) and
//! the depositor pays the rent for it. The House takes leaf 1 at `create_pool`.

use anchor_lang::__private::bytemuck;
use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, Transfer};

use crate::errors::HexVaultError;
use crate::state::{Player, Pool, WeightTree};
use crate::weight_tree::{self as tree, Clock, Node, TreeError, HEADER_BYTES, NODE_SIZE};

fn err(e: TreeError) -> Error {
    match e {
        TreeError::Overflow => HexVaultError::ArithmeticOverflow,
        TreeError::EpochNotReadable => HexVaultError::EpochNotReadable,
        TreeError::NoSuchLeaf => HexVaultError::PlayerHasNoLeaf,
        TreeError::TargetOutOfRange => HexVaultError::NotTheWinner,
        TreeError::Full => HexVaultError::WeightTreeFull,
    }
    .into()
}

/// The two readable epochs, as the Pool keeps them.
pub fn clock(pool: &Pool) -> Clock {
    Clock {
        current: pool.current_epoch_id,
    }
}

/// What one instruction does to one Player's leaf: Principal and Tickets, each
/// a signed sum. The changes are collected here and written in one walk of the
/// update path by [`apply`], whatever order they happen in.
#[derive(Default)]
pub struct Change {
    d_principal: i128,
    d_tickets: i128,
}

impl Change {
    /// Principal added (positive) or removed.
    pub fn principal(&mut self, delta: i128) -> Result<()> {
        self.d_principal = self
            .d_principal
            .checked_add(delta)
            .ok_or(HexVaultError::ArithmeticOverflow)?;
        Ok(())
    }

    /// Tickets added or removed.
    pub fn tickets(&mut self, delta: i128) -> Result<()> {
        self.d_tickets = self
            .d_tickets
            .checked_add(delta)
            .ok_or(HexVaultError::ArithmeticOverflow)?;
        Ok(())
    }

    /// Yield that `sync::settle` just added to Principal and to Tickets.
    pub fn settled(&mut self, owed: u64) -> Result<()> {
        self.principal(i128::from(owed))?;
        self.tickets(i128::from(owed))
    }
}

/// Header and nodes of a tree account's data. `nodes` covers every node the
/// header counts; the data may be longer only while [`append_leaves`] works.
fn split(data: &mut [u8]) -> Result<(&mut WeightTree, &mut [Node])> {
    let invalid = || error!(HexVaultError::WeightTreeInvalid);
    require!(data.len() >= HEADER_BYTES, HexVaultError::WeightTreeInvalid);
    let (head, body) = data.split_at_mut(HEADER_BYTES);
    let header: &mut WeightTree = bytemuck::try_from_bytes_mut(&mut head[8..]).map_err(|_| invalid())?;
    let len = usize::try_from(header.node_count)
        .ok()
        .and_then(|n| n.checked_mul(NODE_SIZE))
        .filter(|len| *len <= body.len())
        .ok_or_else(invalid)?;
    let nodes = bytemuck::try_cast_slice_mut(&mut body[..len]).map_err(|_| invalid())?;
    Ok((header, nodes))
}

/// [`split`] for a read-only borrow.
fn nodes_ref(data: &[u8]) -> Result<&[Node]> {
    let invalid = || error!(HexVaultError::WeightTreeInvalid);
    require!(data.len() >= HEADER_BYTES, HexVaultError::WeightTreeInvalid);
    let (head, body) = data.split_at(HEADER_BYTES);
    let header: &WeightTree = bytemuck::try_from_bytes(&head[8..]).map_err(|_| invalid())?;
    let len = usize::try_from(header.node_count)
        .ok()
        .and_then(|n| n.checked_mul(NODE_SIZE))
        .filter(|len| *len <= body.len())
        .ok_or_else(invalid)?;
    bytemuck::try_cast_slice(&body[..len]).map_err(|_| invalid())
}

/// Writes `change` to `player`'s leaf in the current epoch. Skips the walk
/// when the instruction changed nothing the tree holds.
pub fn apply(
    tree_account: &AccountLoader<WeightTree>,
    pool: &Pool,
    player: &Player,
    change: Change,
) -> Result<()> {
    if change.d_principal == 0 && change.d_tickets == 0 {
        return Ok(());
    }
    let info = tree_account.to_account_info();
    let mut data = info.try_borrow_mut_data()?;
    let (_, nodes) = split(&mut data)?;
    tree::update(
        nodes,
        player.leaf_index as usize,
        change.d_principal,
        change.d_tickets,
        &clock(pool),
    )
    .map_err(err)
}

/// Total Tickets of every leaf in epoch `epoch_id`, which has to be the
/// current epoch or the one before it.
pub fn root(tree_account: &AccountLoader<WeightTree>, pool: &Pool, epoch_id: u64) -> Result<u64> {
    let info = tree_account.to_account_info();
    let data = info.try_borrow_data()?;
    let nodes = nodes_ref(&data)?;
    tree::prefix(nodes, nodes.len(), epoch_id, &clock(pool)).map_err(err)
}

/// `payout`'s check that `winner`'s leaf holds `target` in epoch `epoch_id`:
/// `start <= target < end`, where `[start, end)` is the leaf's range.
pub fn check_winner(
    tree_account: &AccountLoader<WeightTree>,
    pool: &Pool,
    winner: &Player,
    epoch_id: u64,
    target: u64,
) -> Result<()> {
    let info = tree_account.to_account_info();
    let data = info.try_borrow_data()?;
    let nodes = nodes_ref(&data)?;
    let (start, end) = tree::leaf_range(nodes, winner.leaf_index as usize, epoch_id, &clock(pool))
        .map_err(err)?;
    require!(start <= target && target < end, HexVaultError::NotTheWinner);
    Ok(())
}

/// Grows the tree by `count` zero-Ticket leaves, `payer` paying the rent for
/// the bytes, and returns the first new leaf's 1-based index. Fails with
/// `WeightTreeFull` before anything changes if the account would pass 10 MiB.
pub fn append_leaves<'info>(
    tree_account: &AccountLoader<'info, WeightTree>,
    pool: &Pool,
    payer: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    count: usize,
) -> Result<u32> {
    let info = tree_account.to_account_info();
    let before = {
        let mut data = info.try_borrow_mut_data()?;
        split(&mut data)?.1.len()
    };
    let new_len = tree::account_len(before + count).map_err(err)?;
    let first = u32::try_from(before + 1).map_err(|_| HexVaultError::WeightTreeFull)?;

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

    let mut data = info.try_borrow_mut_data()?;
    let (head, body) = data.split_at_mut(HEADER_BYTES);
    let invalid = || error!(HexVaultError::WeightTreeInvalid);
    let header: &mut WeightTree = bytemuck::try_from_bytes_mut(&mut head[8..]).map_err(|_| invalid())?;
    let nodes: &mut [Node] = bytemuck::try_cast_slice_mut(body).map_err(|_| invalid())?;
    let clock = clock(pool);
    for i in before..before + count {
        nodes[i] = tree::append(&nodes[..i], &clock).map_err(err)?;
    }
    header.node_count = (before + count) as u64;
    Ok(first)
}
