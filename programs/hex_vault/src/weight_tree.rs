//! The Fenwick weight tree behind the draw (ADR 0018, yield-claimer tickets 08
//! and 19).
//!
//! The functions work on a slice of [`Node`]; `weight.rs` maps that slice onto
//! the pool's zero-copy tree account.
//!
//! Entry `i` (1-based) sums the leaves `(i - lowbit(i), i]`: a live
//! `principal_sum` and, per epoch parity, a slot of `stamp` (epoch id), `base`
//! (the entry's `principal_sum` when the slot was first written in that epoch)
//! and `tickets`. The tickets are plain Ticket counts, so an epoch's root is the
//! sum of every Player's Tickets at the epoch's end. A slot stamped with an
//! older epoch is reset lazily on the next write.

use anchor_lang::zero_copy;

/// One epoch's half of an entry.
#[zero_copy]
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Slot {
    pub stamp: u64,
    pub base: u64,
    pub tickets: u64,
}

#[zero_copy]
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Node {
    pub principal_sum: u64,
    pub slots: [Slot; 2],
}

pub const NODE_SIZE: usize = core::mem::size_of::<Node>();
const _: () = assert!(NODE_SIZE == 56);

/// Bytes ahead of the first node in the tree account: the 8-byte
/// discriminator and the 48-byte `WeightTree` header. A multiple of 8, so the
/// nodes start 8-aligned.
pub const HEADER_BYTES: usize = 8 + 48;
/// The runtime's cap on one account's data (`MAX_PERMITTED_DATA_LENGTH`).
pub const MAX_ACCOUNT_BYTES: usize = 10 * 1024 * 1024;
/// Most Players one tree holds, 187,244. Past it deposits fail with
/// `WeightTreeFull` (a second tree is out of scope).
pub const MAX_NODES: usize = (MAX_ACCOUNT_BYTES - HEADER_BYTES) / NODE_SIZE;

/// Account length that holds `nodes` nodes, or `Full` past [`MAX_NODES`].
pub fn account_len(nodes: usize) -> Result<usize> {
    if nodes > MAX_NODES {
        return Err(TreeError::Full);
    }
    Ok(HEADER_BYTES + nodes * NODE_SIZE)
}

#[derive(Debug, PartialEq, Eq)]
pub enum TreeError {
    Overflow,
    EpochNotReadable,
    NoSuchLeaf,
    TargetOutOfRange,
    /// One more node would pass [`MAX_ACCOUNT_BYTES`].
    Full,
}

pub type Result<T> = core::result::Result<T, TreeError>;

/// Which epochs the tree can read: the current one and the one before it.
#[derive(Clone, Copy, Debug, Default)]
pub struct Clock {
    pub current: u64,
}

impl Clock {
    /// Epoch `current - 1` stops being readable when `begin_epoch` moves
    /// `current` on, so its payout must land before that call.
    fn readable(&self, e: u64) -> Result<()> {
        if e == self.current || e.checked_add(1) == Some(self.current) {
            Ok(())
        } else {
            Err(TreeError::EpochNotReadable)
        }
    }
}

/// Not `isolate_lowest_one`: SBF's rustc 1.89 predates it.
fn lowbit(i: usize) -> usize {
    i & i.wrapping_neg()
}

fn parity(e: u64) -> usize {
    (e % 2) as usize
}

fn add_signed(a: u64, d: i128) -> Result<u64> {
    i128::from(a)
        .checked_add(d)
        .and_then(|v| u64::try_from(v).ok())
        .ok_or(TreeError::Overflow)
}

/// `(base, tickets)` of one entry in epoch `e`. The slot if it is stamped
/// `e`. Otherwise no leaf under the entry changed during `e`, so the entry
/// held one `principal_sum` throughout: the next epoch's `base` if that slot
/// is stamped, else the live `principal_sum`. Every Player under it held
/// Tickets equal to Principal, so the entry's Tickets are that sum.
fn resolve(node: &Node, e: u64, clock: &Clock) -> Result<(u64, u64)> {
    clock.readable(e)?;
    let slot = node.slots[parity(e)];
    if slot.stamp == e {
        return Ok((slot.base, slot.tickets));
    }
    let next = node.slots[parity(e + 1)];
    let base = if next.stamp == e + 1 {
        next.base
    } else {
        node.principal_sum
    };
    Ok((base, base))
}

pub fn read(node: &Node, e: u64, clock: &Clock) -> Result<u64> {
    Ok(resolve(node, e, clock)?.1)
}

/// Applies one Player change to every entry on `leaf`'s update path, in the
/// current epoch. A slot not yet written this epoch is first reset to the
/// `principal_sum` it held before this write, for both its base and its
/// Tickets.
pub fn update(
    nodes: &mut [Node],
    leaf: usize,
    d_principal: i128,
    d_tickets: i128,
    clock: &Clock,
) -> Result<()> {
    if leaf == 0 || leaf > nodes.len() {
        return Err(TreeError::NoSuchLeaf);
    }
    let e = clock.current;
    let mut i = leaf;
    while i <= nodes.len() {
        let node = &mut nodes[i - 1];
        let principal_sum = node.principal_sum;
        let slot = &mut node.slots[parity(e)];
        if slot.stamp != e {
            slot.stamp = e;
            slot.base = principal_sum;
            slot.tickets = principal_sum;
        }
        slot.tickets = add_signed(slot.tickets, d_tickets)?;
        node.principal_sum = add_signed(principal_sum, d_principal)?;
        i += lowbit(i);
    }
    Ok(())
}

/// The entry for a new leaf `nodes.len() + 1` with zero Principal. It sums
/// the entries it now covers, each resolved through the slot rule, and
/// stamps both readable epochs so a later read never falls to the idle rule
/// with a `principal_sum` it did not hold. The caller grows the account by
/// one node and stores the result there.
pub fn append(nodes: &[Node], clock: &Clock) -> Result<Node> {
    let i = nodes.len() + 1;
    let c = clock.current;
    let mut node = Node::default();
    let readable = core::iter::once(c).chain(c.checked_sub(1));
    for e in readable {
        let (mut base, mut tickets) = (0u64, 0u64);
        let mut j = i - 1;
        while j > i - lowbit(i) {
            let (b, t) = resolve(&nodes[j - 1], e, clock)?;
            base = base.checked_add(b).ok_or(TreeError::Overflow)?;
            tickets = tickets.checked_add(t).ok_or(TreeError::Overflow)?;
            j -= lowbit(j);
        }
        let slot = &mut node.slots[parity(e)];
        slot.stamp = e;
        slot.base = base;
        slot.tickets = tickets;
    }
    let mut j = i - 1;
    while j > i - lowbit(i) {
        node.principal_sum = node
            .principal_sum
            .checked_add(nodes[j - 1].principal_sum)
            .ok_or(TreeError::Overflow)?;
        j -= lowbit(j);
    }
    Ok(node)
}

/// Sum of leaves `1..=i` in epoch `e`.
pub fn prefix(nodes: &[Node], mut i: usize, e: u64, clock: &Clock) -> Result<u64> {
    let mut sum = 0u64;
    while i > 0 {
        sum = sum
            .checked_add(read(&nodes[i - 1], e, clock)?)
            .ok_or(TreeError::Overflow)?;
        i -= lowbit(i);
    }
    Ok(sum)
}

/// `[start, end)` of `leaf`'s Tickets in epoch `e`. `payout` checks the
/// target falls in the winner's range.
pub fn leaf_range(nodes: &[Node], leaf: usize, e: u64, clock: &Clock) -> Result<(u64, u64)> {
    if leaf == 0 || leaf > nodes.len() {
        return Err(TreeError::NoSuchLeaf);
    }
    Ok((
        prefix(nodes, leaf - 1, e, clock)?,
        prefix(nodes, leaf, e, clock)?,
    ))
}

/// Binary lifting: the leaf whose range in epoch `e` holds `target`.
pub fn find(nodes: &[Node], mut target: u64, e: u64, clock: &Clock) -> Result<usize> {
    let n = nodes.len();
    let mut pos = 0;
    let mut step = if n == 0 {
        0
    } else {
        1usize << (usize::BITS - 1 - n.leading_zeros())
    };
    while step > 0 {
        let next = pos + step;
        if next <= n {
            let t = read(&nodes[next - 1], e, clock)?;
            if t <= target {
                pos = next;
                target -= t;
            }
        }
        step >>= 1;
    }
    if pos == n {
        Err(TreeError::TargetOutOfRange)
    } else {
        Ok(pos + 1)
    }
}

/// The draw: reduce a random number under the epoch's total and descend.
pub fn pick(nodes: &[Node], random: u64, e: u64, clock: &Clock) -> Result<usize> {
    let total = prefix(nodes, nodes.len(), e, clock)?;
    if total == 0 {
        return Err(TreeError::TargetOutOfRange);
    }
    find(nodes, random % total, e, clock)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// SplitMix64. No proptest in this crate; a seeded generator keeps every
    /// failure reproducible from the printed seed.
    struct Rng(u64);

    impl Rng {
        fn next(&mut self) -> u64 {
            self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
            let mut z = self.0;
            z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
            z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
            z ^ (z >> 31)
        }

        /// Uniform in `0..n`, `n > 0`.
        fn below(&mut self, n: u64) -> u64 {
            self.next() % n
        }

        /// Uniform in `0..=n`.
        fn upto(&mut self, n: u64) -> u64 {
            if n == u64::MAX {
                self.next()
            } else {
                self.below(n + 1)
            }
        }

        fn chance(&mut self, pct: u64) -> bool {
            self.below(100) < pct
        }
    }

    /// A Player's Ticket fields, driven by a transcription of
    /// `touch.rs::touch`: Tickets reset to Principal, pending deposit
    /// included, the first time the Player acts in a later epoch. `frozen_*` remembers what the Player held
    /// at the end of the epoch before the reset, which is what the tree must
    /// still report for it.
    #[derive(Clone, Debug, Default)]
    struct Eager {
        principal: u64,
        entries: u64,
        /// The part of `principal` deposited in `epoch_id`, which earns no
        /// Ticket until the next epoch.
        pending: u64,
        epoch_id: u64,
        frozen_tickets: u64,
        frozen_epoch: u64,
        /// The epoch `init_if_fresh` ran in. Earlier epochs read zero.
        created: u64,
    }

    impl Eager {
        /// `Player::init_if_fresh`.
        fn new(clock: &Clock) -> Self {
            Eager {
                epoch_id: clock.current,
                created: clock.current,
                ..Eager::default()
            }
        }

        fn touch(&mut self, clock: &Clock) {
            if self.epoch_id >= clock.current {
                return;
            }
            let previous = clock.current - 1;
            self.frozen_tickets = if self.epoch_id == previous {
                self.entries
            } else {
                self.principal
            };
            self.frozen_epoch = previous;
            self.entries = self.principal;
            self.pending = 0;
            self.epoch_id = clock.current;
        }

        /// `deposit`: Principal and the pending amount rise, Tickets do not.
        fn deposit(&mut self, a: u64) {
            self.principal += a;
            self.pending += a;
        }

        /// Tickets held at the end of epoch `e`, which the tree must report.
        fn tickets(&self, e: u64) -> u64 {
            if self.created > e {
                0
            } else if self.epoch_id == e {
                self.entries
            } else if self.epoch_id > e {
                assert_eq!(self.frozen_epoch, e, "the tree would refuse this read");
                self.frozen_tickets
            } else {
                // Idle through `e`: reset to Principal at its start and never
                // changed.
                self.principal
            }
        }
    }

    /// Tickets of every Player in epoch `e`, in O(n): `P[i] = P[i - lowbit(i)]
    /// + entry i`.
    fn leaf_tickets(nodes: &[Node], e: u64, clock: &Clock) -> Vec<u64> {
        let mut pre = vec![0u64; nodes.len() + 1];
        for i in 1..=nodes.len() {
            pre[i] = pre[i - lowbit(i)] + read(&nodes[i - 1], e, clock).unwrap();
        }
        pre.windows(2).map(|w| w[1] - w[0]).collect()
    }

    #[derive(Default, Debug)]
    struct Coverage {
        events: u64,
        epochs: u64,
        live_appends: u64,
        idle_current_checks: u64,
        idle_previous_checks: u64,
        previous_checks: u64,
        lifting_checks: u64,
        stakes: u64,
        settled_stakes: u64,
        stale_stakes: u64,
        untouched_tree: u64,
        deposits: u64,
        pending_folds: u64,
    }

    /// One pool: the tree and the eager model side by side. Player `k` sits
    /// at leaf `k + 1`, and Player 0 is the House.
    struct Sim {
        rng: Rng,
        clock: Clock,
        tree: Vec<Node>,
        players: Vec<Eager>,
        acted_current: Vec<bool>,
        /// Expected Tickets in the previous epoch of Players idle through it.
        idle_previous: Vec<Option<u64>>,
        /// `buy_position` stakes not yet settled: Player, amount, epoch.
        stakes: Vec<(usize, u64, u64)>,
        cov: Coverage,
    }

    const MAX_PLAYERS: usize = 24;
    const MAX_AMOUNT: u64 = 1_000_000_000_000; // 1M USDC at 6 decimals

    impl Sim {
        fn new(seed: u64) -> Self {
            let mut sim = Sim {
                rng: Rng(seed),
                clock: Clock::default(),
                tree: Vec::new(),
                players: Vec::new(),
                acted_current: Vec::new(),
                idle_previous: Vec::new(),
                stakes: Vec::new(),
                cov: Coverage::default(),
            };
            sim.begin_epoch(); // epoch 1
            sim.new_player(); // the House
            sim
        }

        /// `begin_epoch`, then the idle-player stash.
        fn begin_epoch(&mut self) {
            self.idle_previous = self
                .players
                .iter()
                .zip(&self.acted_current)
                .map(|(p, &acted)| (!acted).then_some(p.principal))
                .collect();
            self.clock.current += 1;
            self.acted_current = vec![false; self.players.len()];
            self.cov.epochs += 1;
        }

        /// A first deposit's append, checked to leave every other Player's
        /// Tickets alone in both readable epochs.
        fn new_player(&mut self) -> usize {
            let before = self.readable_tickets();
            let node = append(&self.tree, &self.clock).expect("append");
            self.tree.push(node);
            self.players.push(Eager::new(&self.clock));
            self.acted_current.push(true);
            self.idle_previous.push(None);
            let after = self.readable_tickets();
            for ((e, b), (_, a)) in before.iter().zip(&after) {
                assert_eq!(&a[..b.len()], &b[..], "append moved Tickets in epoch {e}");
                assert_eq!(a[b.len()], 0, "a new leaf starts empty in epoch {e}");
            }
            if self.players.len() > 1 {
                self.cov.live_appends += 1;
            }
            self.players.len() - 1
        }

        fn readable_tickets(&self) -> Vec<(u64, Vec<u64>)> {
            let c = self.clock.current;
            core::iter::once(c)
                .chain(c.checked_sub(1).filter(|&p| p > 0))
                .map(|e| (e, leaf_tickets(&self.tree, e, &self.clock)))
                .collect()
        }

        /// One instruction on Player `k`: `touch` first, then `op` changes
        /// Principal and Entries, then the same change goes into the tree,
        /// unless it changed nothing, as `weight::apply` skips it.
        fn act<R>(&mut self, k: usize, op: impl FnOnce(&mut Eager, &mut Rng) -> R) -> R {
            let clock = self.clock;
            let p = &mut self.players[k];
            if p.epoch_id < clock.current && p.pending > 0 {
                self.cov.pending_folds += 1;
            }
            p.touch(&clock);
            let (p0, t0) = (p.principal, p.entries);
            let out = op(p, &mut self.rng);
            let d_principal = i128::from(p.principal) - i128::from(p0);
            let d_tickets = i128::from(p.entries) - i128::from(t0);
            if d_principal == 0 && d_tickets == 0 {
                self.cov.untouched_tree += 1;
            } else {
                update(&mut self.tree, k + 1, d_principal, d_tickets, &clock).expect("update");
            }
            self.acted_current[k] = true;
            self.cov.events += 1;
            out
        }

        fn depositor(&mut self) -> Option<usize> {
            (self.players.len() > 1)
                .then(|| 1 + self.rng.below(self.players.len() as u64 - 1) as usize)
        }

        fn step(&mut self) {
            if self.rng.chance(12) {
                self.begin_epoch();
                return;
            }
            let roll = self.rng.below(100);
            let target = self.depositor();
            match (roll, target) {
                (0..=7, _) if self.players.len() < MAX_PLAYERS => {
                    let k = self.new_player();
                    self.act(k, |p, rng| p.deposit(1 + rng.below(MAX_AMOUNT)));
                }
                (8..=19, Some(k)) => {
                    self.act(k, |p, rng| p.deposit(1 + rng.below(MAX_AMOUNT)));
                    self.cov.deposits += 1;
                }
                (20..=32, Some(k)) => self.act(k, |p, rng| {
                    // Settled yield or a Prize: Principal and Tickets one for
                    // one, at once. A pending deposit stays pending.
                    let a = 1 + rng.below(MAX_AMOUNT);
                    p.principal += a;
                    p.entries += a;
                }),
                (33..=44, Some(k)) => self.act(k, |p, rng| {
                    // Instant withdraw under the Tickets rule.
                    let a = rng.upto(p.principal.min(p.entries));
                    p.principal -= a;
                    p.entries -= a;
                    p.pending = p.pending.min(p.principal);
                }),
                (45..=50, Some(k)) => self.act(k, |p, rng| {
                    // `request_withdraw`: Entries saturate.
                    let a = rng.upto(p.principal);
                    p.principal -= a;
                    p.entries = p.entries.saturating_sub(a);
                    p.pending = p.pending.min(p.principal);
                }),
                (51..=52, Some(k)) => self.act(k, |p, _| {
                    // `emergency_withdraw`.
                    p.principal = 0;
                    p.entries = 0;
                    p.pending = 0;
                }),
                (53..=64, Some(k)) => {
                    // `buy_position`: the stake leaves Entries and the tree.
                    let epoch = self.clock.current;
                    let stake = self.act(k, |p, rng| {
                        if p.entries == 0 {
                            return 0;
                        }
                        let stake = 1 + rng.below(p.entries);
                        p.entries -= stake;
                        stake
                    });
                    if stake > 0 {
                        self.stakes.push((k, stake, epoch));
                        self.cov.stakes += 1;
                    }
                }
                (65..=74, _) if !self.stakes.is_empty() => {
                    // `settle_position`: touch, then the stake and a reward
                    // come back as a plain delta, in whatever epoch is current
                    // by then.
                    let i = self.rng.below(self.stakes.len() as u64) as usize;
                    let (k, stake, epoch) = self.stakes.swap_remove(i);
                    self.act(k, |p, rng| p.entries += stake + rng.upto(stake));
                    if epoch == self.clock.current {
                        self.cov.settled_stakes += 1;
                    } else {
                        self.cov.stale_stakes += 1;
                    }
                }
                (75..=89, _) => {
                    // Tickets in with no Principal: a round reward, a forfeit
                    // or cut to the House, a bought or granted Ticket. The
                    // House (Player 0) is a valid target.
                    let k = self.rng.below(self.players.len() as u64) as usize;
                    self.act(k, |p, rng| p.entries += 1 + rng.below(MAX_AMOUNT));
                }
                _ => {} // nobody acts
            }
        }

        /// Tree against the eager model, for every Player, in both readable
        /// epochs.
        fn check(&mut self, lifting: bool) {
            let clock = self.clock;
            for (e, tree_t) in self.readable_tickets() {
                let is_current = e == clock.current;
                for (k, p) in self.players.iter().enumerate() {
                    assert!(p.pending <= p.principal, "Player {k}");
                    assert_eq!(
                        tree_t[k],
                        p.tickets(e),
                        "Player {k}, epoch {e} (current {})",
                        clock.current
                    );
                    if is_current && !self.acted_current[k] {
                        assert_eq!(tree_t[k], p.principal);
                        self.cov.idle_current_checks += 1;
                    }
                    if !is_current {
                        if let Some(Some(t)) = self.idle_previous.get(k) {
                            assert_eq!(tree_t[k], *t, "idle Player {k} in epoch {e}");
                            self.cov.idle_previous_checks += 1;
                        }
                    }
                }
                if !is_current {
                    self.cov.previous_checks += 1;
                }
                let total: u64 = tree_t.iter().sum();
                assert_eq!(
                    prefix(&self.tree, self.tree.len(), e, &clock).unwrap(),
                    total
                );
                if lifting {
                    self.check_lifting(e, &tree_t, total);
                }
            }
        }

        fn check_lifting(&mut self, e: u64, tree_t: &[u64], total: u64) {
            let clock = self.clock;
            let mut start = 0u64;
            for (k, &t) in tree_t.iter().enumerate() {
                if t > 0 {
                    let targets = [start, start + t - 1, start + self.rng.below(t)];
                    for target in targets {
                        assert_eq!(find(&self.tree, target, e, &clock), Ok(k + 1), "target {target}");
                    }
                    assert_eq!(
                        leaf_range(&self.tree, k + 1, e, &clock),
                        Ok((start, start + t))
                    );
                }
                start += t;
            }
            assert_eq!(
                find(&self.tree, total, e, &clock),
                Err(TreeError::TargetOutOfRange)
            );
            self.cov.lifting_checks += 1;
        }
    }

    #[test]
    fn node_is_56_bytes() {
        assert_eq!(NODE_SIZE, 56);
        assert_eq!(core::mem::align_of::<Node>(), 8);
    }

    /// Same Tickets per Player as `touch` gives, to the unit, in the current
    /// epoch and in the previous one while the current is written, over random
    /// sequences of deposits that activate next epoch, settles, round moves,
    /// Bought tickets and withdrawals.
    #[test]
    fn matches_the_eager_ticket_count_over_random_sequences() {
        const SEQUENCES: u64 = 1_000;
        const MIN_EVENTS: u64 = 200;
        const MIN_EPOCHS: u64 = 4;
        let mut all = Coverage::default();
        for seed in 0..SEQUENCES {
            let mut sim = Sim::new(seed);
            let mut steps = 0u64;
            while sim.cov.events < MIN_EVENTS || sim.cov.epochs < MIN_EPOCHS + 1 {
                sim.step();
                steps += 1;
                sim.check(steps.is_multiple_of(8));
            }
            let c = &sim.cov;
            assert!(
                c.events >= MIN_EVENTS && c.epochs > MIN_EPOCHS,
                "seed {seed}: {c:?}"
            );
            all.events += c.events;
            all.epochs += c.epochs;
            all.live_appends += c.live_appends;
            all.idle_current_checks += c.idle_current_checks;
            all.idle_previous_checks += c.idle_previous_checks;
            all.previous_checks += c.previous_checks;
            all.lifting_checks += c.lifting_checks;
            all.stakes += c.stakes;
            all.settled_stakes += c.settled_stakes;
            all.stale_stakes += c.stale_stakes;
            all.untouched_tree += c.untouched_tree;
            all.deposits += c.deposits;
            all.pending_folds += c.pending_folds;
        }
        // The generator must actually reach every case it claims to cover.
        let Coverage {
            live_appends,
            idle_current_checks,
            idle_previous_checks,
            previous_checks,
            lifting_checks,
            stakes,
            settled_stakes,
            stale_stakes,
            untouched_tree,
            deposits,
            pending_folds,
            ..
        } = all;
        for (name, n) in [
            ("appends to a live tree", live_appends),
            ("idle checks, current epoch", idle_current_checks),
            ("idle checks, previous epoch", idle_previous_checks),
            ("previous-epoch checks", previous_checks),
            ("binary lifting checks", lifting_checks),
            ("stakes", stakes),
            ("settled stakes", settled_stakes),
            ("stale stakes", stale_stakes),
            ("touches that leave the tree alone", untouched_tree),
            ("deposits into an existing Player", deposits),
            ("touches that fold a pending deposit", pending_folds),
        ] {
            assert!(n > 0, "never exercised: {name}");
        }
        println!("{all:?}");
    }

    /// A tree with `n` leaves, in epoch 1.
    fn fresh(n: usize) -> (Vec<Node>, Clock) {
        let clock = Clock { current: 1 };
        let mut tree = Vec::new();
        for _ in 0..n {
            let node = append(&tree, &clock).unwrap();
            tree.push(node);
        }
        (tree, clock)
    }

    /// A deposit: Principal and Tickets by the same amount.
    fn deposit(tree: &mut [Node], clock: &Clock, leaf: usize, a: u64) {
        let d = i128::from(a);
        update(tree, leaf, d, d, clock).unwrap();
    }

    fn tickets(tree: &[Node], clock: &Clock, leaf: usize, e: u64) -> u64 {
        let (s, end) = leaf_range(tree, leaf, e, clock).unwrap();
        end - s
    }

    #[test]
    fn a_player_who_never_acts_holds_principal() {
        let (mut tree, mut clock) = fresh(5);
        deposit(&mut tree, &clock, 2, 300);
        deposit(&mut tree, &clock, 4, 700);

        // Leaf 4 acts in epoch 2, leaf 2 never.
        clock.current = 2;
        deposit(&mut tree, &clock, 4, 50);
        assert_eq!(tickets(&tree, &clock, 2, 2), 300);
        assert_eq!(tickets(&tree, &clock, 2, 1), 300);

        // Still its Principal for epoch 2 while epoch 3 is written, including
        // after leaf 2 itself acts in epoch 3.
        clock.current = 3;
        deposit(&mut tree, &clock, 2, 1_000);
        deposit(&mut tree, &clock, 1, 1);
        assert_eq!(tickets(&tree, &clock, 2, 2), 300);
        assert_eq!(tickets(&tree, &clock, 4, 2), 750);
        assert_eq!(tickets(&tree, &clock, 2, 3), 1_300);
    }

    /// A deposit moves `principal_sum` only. It adds no Ticket in its own epoch
    /// and the whole amount in the next, with no touch in between, so a
    /// depositor who never comes back is still drawable.
    #[test]
    fn a_deposit_counts_from_the_next_epoch_without_a_touch() {
        let (mut tree, mut clock) = fresh(3);
        let pending = |tree: &mut [Node], clock: &Clock, leaf, a: u64| {
            update(tree, leaf, i128::from(a), 0, clock).unwrap()
        };
        deposit(&mut tree, &clock, 1, 100);
        pending(&mut tree, &clock, 2, 100);
        pending(&mut tree, &clock, 2, 50);
        assert_eq!(tickets(&tree, &clock, 1, 1), 100);
        assert_eq!(tickets(&tree, &clock, 2, 1), 0);
        assert_eq!(prefix(&tree, 3, 1, &clock), Ok(100));

        // Epoch 2: nobody touches, and the root already holds the deposit.
        clock.current = 2;
        assert_eq!(tickets(&tree, &clock, 2, 2), 150);
        assert_eq!(prefix(&tree, 3, 2, &clock), Ok(250));
        // Epoch 1 stays as it ended while epoch 2 is written.
        pending(&mut tree, &clock, 3, 70);
        assert_eq!(prefix(&tree, 3, 1, &clock), Ok(100));
        assert_eq!(prefix(&tree, 3, 2, &clock), Ok(250));
        clock.current = 3;
        assert_eq!(prefix(&tree, 3, 3, &clock), Ok(320));
    }

    /// Appending leaves every existing Ticket count unchanged, with a
    /// deterministic growth to 300 leaves on top of the random appends in the
    /// property test.
    #[test]
    fn appending_leaves_every_existing_count_unchanged() {
        let mut rng = Rng(7);
        let (mut tree, mut clock) = fresh(1);
        while tree.len() < 300 {
            if rng.chance(5) {
                clock.current += 1;
            }
            let leaf = 1 + rng.below(tree.len() as u64) as usize;
            deposit(&mut tree, &clock, leaf, rng.below(1_000));

            let epochs = [clock.current, clock.current - 1];
            let before = epochs.map(|e| leaf_tickets(&tree, e, &clock));
            let node = append(&tree, &clock).unwrap();
            tree.push(node);
            for (e, b) in epochs.iter().zip(&before) {
                let after = leaf_tickets(&tree, *e, &clock);
                assert_eq!(&after[..b.len()], &b[..], "epoch {e}, n = {}", tree.len());
                assert_eq!(after[b.len()], 0);
            }
        }
        assert!(clock.current >= 3, "growth crossed epochs");
    }

    /// Binary lifting, exhaustively: every target in `[0, total)` maps to the
    /// leaf whose range holds it, empty leaves are never picked, and `total`
    /// itself is out of range.
    #[test]
    fn binary_lifting_maps_every_target_to_its_leaf() {
        let mut rng = Rng(11);
        for n in 1..=70usize {
            let (mut tree, mut clock) = fresh(n);
            for leaf in 1..=n {
                if rng.chance(70) {
                    deposit(&mut tree, &clock, leaf, rng.below(4));
                }
            }
            clock.current = 2;
            for leaf in 1..=n {
                if rng.chance(30) {
                    deposit(&mut tree, &clock, leaf, rng.below(3));
                }
            }
            for e in [1, 2] {
                let ts = leaf_tickets(&tree, e, &clock);
                let mut t = 0u64;
                for (k, &count) in ts.iter().enumerate() {
                    for _ in 0..count {
                        assert_eq!(find(&tree, t, e, &clock), Ok(k + 1), "n {n} epoch {e}");
                        t += 1;
                    }
                }
                assert_eq!(find(&tree, t, e, &clock), Err(TreeError::TargetOutOfRange));
                if t > 0 {
                    let leaf = pick(&tree, rng.next(), e, &clock).unwrap();
                    assert!(ts[leaf - 1] > 0);
                }
            }
        }
    }

    /// A stake taken in epoch `e` is already back in epoch `e + 1`: the slot
    /// reset rebuilds the Tickets from `principal_sum`, which a stake never
    /// lowers. A settle after the rollover is a plain delta on top of that.
    #[test]
    fn a_stake_from_a_rolled_over_epoch_is_already_back() {
        let (mut tree, mut clock) = fresh(2);
        deposit(&mut tree, &clock, 1, 1_000);
        deposit(&mut tree, &clock, 2, 1_000);

        // Leaf 1 stakes 400, in and out of the tree within epoch 1.
        update(&mut tree, 1, 0, -400, &clock).unwrap();
        assert_eq!(tickets(&tree, &clock, 1, 1), 600);
        update(&mut tree, 1, 0, 400, &clock).unwrap();
        assert_eq!(tickets(&tree, &clock, 1, 1), 1_000);

        update(&mut tree, 2, 0, -400, &clock).unwrap();
        clock.current = 2;
        // No settle yet, and leaf 2 already holds its full Principal.
        assert_eq!(tickets(&tree, &clock, 2, 2), 1_000);

        // A settle credited now lands above its Principal.
        update(&mut tree, 2, 0, 400, &clock).unwrap();
        assert_eq!(tickets(&tree, &clock, 2, 2), 1_400);
        assert_eq!(tickets(&tree, &clock, 2, 1), 600);
    }

    #[test]
    fn epoch_two_back_is_not_readable() {
        let (tree, mut clock) = fresh(1);
        clock.current = 3;
        assert_eq!(read(&tree[0], 1, &clock), Err(TreeError::EpochNotReadable));
    }

    /// The account holds 187,244 Players and no more: one past that would
    /// take it over the runtime's 10 MiB limit, so a deposit refuses by name
    /// before anything changes.
    #[test]
    fn the_account_refuses_a_node_past_10_mib() {
        assert_eq!(MAX_NODES, 187_244);
        let full = account_len(MAX_NODES).unwrap();
        assert!(full <= MAX_ACCOUNT_BYTES);
        assert!(full + NODE_SIZE > MAX_ACCOUNT_BYTES);
        assert_eq!(account_len(MAX_NODES + 1), Err(TreeError::Full));
        // The header alone is the account `create_pool` receives.
        assert_eq!(account_len(0), Ok(HEADER_BYTES));
    }

    /// The glue reads the nodes out of account bytes with a plain cast, so a
    /// node must have no padding and the header must leave them 8-aligned.
    #[test]
    fn nodes_start_8_aligned_after_the_header() {
        assert_eq!(HEADER_BYTES % 8, 0);
        assert_eq!(core::mem::align_of::<Node>(), 8);
        let node = Node::default();
        let bytes: &[u8] = anchor_lang::__private::bytemuck::bytes_of(&node);
        assert_eq!(bytes.len(), NODE_SIZE);
    }
}
