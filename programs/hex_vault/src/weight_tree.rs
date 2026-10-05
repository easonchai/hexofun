//! The Fenwick weight tree behind the draw (ADR 0018, yield-claimer ticket 08).
//!
//! Lifted from ticket 02's prototype, whose property test against an eager
//! model of the old `touch` and `register` still runs below. The functions
//! work on a slice of [`Node`]; `weight.rs` maps that slice onto the pool's
//! zero-copy tree account.
//!
//! Entry `i` (1-based) sums the leaves `(i - lowbit(i), i]`: a live
//! `principal_sum` and, per epoch parity, a slot of `stamp` (epoch id),
//! `base` (the entry's `principal_sum` when the slot was first written in
//! that epoch) and `weight`. Every Ticket change credits its Weight up to the
//! epoch's end at once, so an epoch's numbers are final when it ends, and a
//! slot stamped with an older epoch is reset lazily on the next write.

use anchor_lang::zero_copy;

/// One epoch's half of an entry.
#[zero_copy]
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Slot {
    pub stamp: u64,
    pub base: u64,
    /// A `u128` stored as two halves so the node stays 8-byte aligned and
    /// 72 bytes on every target (host `u128` is 16-aligned, SBF's is 8).
    weight: [u64; 2],
}

impl Slot {
    pub fn weight(&self) -> u128 {
        u128::from(self.weight[0]) | (u128::from(self.weight[1]) << 64)
    }

    fn set_weight(&mut self, w: u128) {
        self.weight = [w as u64, (w >> 64) as u64];
    }
}

#[zero_copy]
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Node {
    pub principal_sum: u64,
    pub slots: [Slot; 2],
}

pub const NODE_SIZE: usize = core::mem::size_of::<Node>();
const _: () = assert!(NODE_SIZE == 72);

/// Bytes ahead of the first node in the tree account: the 8-byte
/// discriminator and the 48-byte `WeightTree` header. A multiple of 8, so the
/// nodes start 8-aligned.
pub const HEADER_BYTES: usize = 8 + 48;
/// The runtime's cap on one account's data (`MAX_PERMITTED_DATA_LENGTH`).
pub const MAX_ACCOUNT_BYTES: usize = 10 * 1024 * 1024;
/// Most Players one tree holds, 145,634. Past it deposits fail with
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

/// The two readable epochs, as `Pool` keeps them today
/// (`current_epoch_id`, `current_epoch_start`, ...).
#[derive(Clone, Copy, Debug, Default)]
pub struct Clock {
    pub current: u64,
    pub cur_start: i64,
    pub cur_end: i64,
    pub prev_start: i64,
    pub prev_end: i64,
}

impl Clock {
    /// O(1): no tree entry is touched. Epoch `current - 1` stops being
    /// readable here, so its payout must land before this call.
    pub fn begin_epoch(&mut self, start: i64, end: i64) {
        *self = Clock {
            current: self.current + 1,
            cur_start: start,
            cur_end: end,
            prev_start: self.cur_start,
            prev_end: self.cur_end,
        };
    }

    pub fn length(&self, e: u64) -> Result<u128> {
        if e == self.current {
            Ok(elapsed(self.cur_start, self.cur_end))
        } else if e.checked_add(1) == Some(self.current) {
            Ok(elapsed(self.prev_start, self.prev_end))
        } else {
            Err(TreeError::EpochNotReadable)
        }
    }

    /// Weight `delta_tickets` earns from `now` to the current epoch's end.
    /// Zero once that end has passed, as the clamp in `touch` does today.
    pub fn forward(&self, delta_tickets: i128, now: i64) -> Result<i128> {
        let remaining =
            i128::try_from(elapsed(now, self.cur_end)).map_err(|_| TreeError::Overflow)?;
        delta_tickets
            .checked_mul(remaining)
            .ok_or(TreeError::Overflow)
    }
}

/// Seconds from `from` to `to`, zero when negative. Same as `touch::elapsed`.
fn elapsed(from: i64, to: i64) -> u128 {
    u128::from(u64::try_from(to.saturating_sub(from)).unwrap_or(0))
}

/// Not `isolate_lowest_one`: SBF's rustc 1.89 predates it.
fn lowbit(i: usize) -> usize {
    i & i.wrapping_neg()
}

fn parity(e: u64) -> usize {
    (e % 2) as usize
}

fn mul(a: u64, b: u128) -> Result<u128> {
    u128::from(a).checked_mul(b).ok_or(TreeError::Overflow)
}

fn add_signed(a: u64, d: i128) -> Result<u64> {
    i128::from(a)
        .checked_add(d)
        .and_then(|v| u64::try_from(v).ok())
        .ok_or(TreeError::Overflow)
}

/// `(base, weight)` of one entry in epoch `e`. The slot if it is stamped
/// `e`. Otherwise no leaf under the entry changed during `e`, so the entry
/// held one `principal_sum` throughout: the next epoch's `base` if that slot
/// is stamped, else the live `principal_sum`.
fn resolve(node: &Node, e: u64, clock: &Clock) -> Result<(u64, u128)> {
    let len = clock.length(e)?;
    let slot = node.slots[parity(e)];
    if slot.stamp == e {
        return Ok((slot.base, slot.weight()));
    }
    let next = node.slots[parity(e + 1)];
    let base = if next.stamp == e + 1 {
        next.base
    } else {
        node.principal_sum
    };
    Ok((base, mul(base, len)?))
}

pub fn read(node: &Node, e: u64, clock: &Clock) -> Result<u128> {
    Ok(resolve(node, e, clock)?.1)
}

/// Applies one Player change to every entry on `leaf`'s update path, in the
/// current epoch. `d_weight` is the signed Weight change (usually
/// `clock.forward(d_tickets, now)`, plus any round pre-credit). A slot not
/// yet written this epoch is first reset to the full-epoch Weight of the
/// `principal_sum` it held before this write.
pub fn update(
    nodes: &mut [Node],
    leaf: usize,
    d_principal: i128,
    d_weight: i128,
    clock: &Clock,
) -> Result<()> {
    if leaf == 0 || leaf > nodes.len() {
        return Err(TreeError::NoSuchLeaf);
    }
    let e = clock.current;
    let len = clock.length(e)?;
    let mut i = leaf;
    while i <= nodes.len() {
        let node = &mut nodes[i - 1];
        let principal_sum = node.principal_sum;
        let slot = &mut node.slots[parity(e)];
        if slot.stamp != e {
            slot.stamp = e;
            slot.base = principal_sum;
            slot.set_weight(mul(principal_sum, len)?);
        }
        let w = slot
            .weight()
            .checked_add_signed(d_weight)
            .ok_or(TreeError::Overflow)?;
        slot.set_weight(w);
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
        let (mut base, mut weight) = (0u64, 0u128);
        let mut j = i - 1;
        while j > i - lowbit(i) {
            let (b, w) = resolve(&nodes[j - 1], e, clock)?;
            base = base.checked_add(b).ok_or(TreeError::Overflow)?;
            weight = weight.checked_add(w).ok_or(TreeError::Overflow)?;
            j -= lowbit(j);
        }
        let slot = &mut node.slots[parity(e)];
        slot.stamp = e;
        slot.base = base;
        slot.set_weight(weight);
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
pub fn prefix(nodes: &[Node], mut i: usize, e: u64, clock: &Clock) -> Result<u128> {
    let mut sum = 0u128;
    while i > 0 {
        sum = sum
            .checked_add(read(&nodes[i - 1], e, clock)?)
            .ok_or(TreeError::Overflow)?;
        i -= lowbit(i);
    }
    Ok(sum)
}

/// `[start, end)` of `leaf`'s Weight in epoch `e`. `payout` checks the
/// target falls in the winner's range, as it checks `reg_start..reg_end`
/// today.
pub fn leaf_range(nodes: &[Node], leaf: usize, e: u64, clock: &Clock) -> Result<(u128, u128)> {
    if leaf == 0 || leaf > nodes.len() {
        return Err(TreeError::NoSuchLeaf);
    }
    Ok((
        prefix(nodes, leaf - 1, e, clock)?,
        prefix(nodes, leaf, e, clock)?,
    ))
}

/// Binary lifting: the leaf whose range in epoch `e` holds `target`.
pub fn find(nodes: &[Node], mut target: u128, e: u64, clock: &Clock) -> Result<usize> {
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
            let w = read(&nodes[next - 1], e, clock)?;
            if w <= target {
                pos = next;
                target -= w;
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
pub fn pick(nodes: &[Node], random: u128, e: u64, clock: &Clock) -> Result<usize> {
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

    /// Today's Player Weight fields, driven by a transcription of
    /// `touch.rs::touch` (principal-seconds dropped; it is not Weight).
    /// Kept as a copy so the test survives the layout rewrite that deletes
    /// `touch` and these fields.
    #[derive(Clone, Debug, Default)]
    struct Eager {
        principal: u64,
        entries: u64,
        weight_acc: u128,
        last_update: i64,
        epoch_id: u64,
        frozen_weight: u128,
        frozen_epoch: u64,
        /// The epoch `init_if_fresh` ran in. Earlier epochs read zero.
        created: u64,
    }

    impl Eager {
        /// `Player::init_if_fresh`.
        fn new(clock: &Clock, now: i64) -> Self {
            Eager {
                last_update: now,
                epoch_id: clock.current,
                created: clock.current,
                ..Eager::default()
            }
        }

        fn touch(&mut self, clock: &Clock, now: i64) {
            if self.epoch_id >= clock.current {
                let until = if clock.current == 0 {
                    now
                } else {
                    now.min(clock.cur_end)
                };
                self.weight_acc += u128::from(self.entries) * elapsed(self.last_update, until);
                self.last_update = now;
                return;
            }
            let previous = clock.current - 1;
            self.frozen_weight = if self.epoch_id == previous {
                self.weight_acc
                    + u128::from(self.entries) * elapsed(self.last_update, clock.prev_end)
            } else {
                u128::from(self.principal) * elapsed(clock.prev_start, clock.prev_end)
            };
            self.frozen_epoch = previous;
            self.entries = self.principal;
            self.weight_acc =
                u128::from(self.principal) * elapsed(clock.cur_start, now.min(clock.cur_end));
            self.last_update = now;
            self.epoch_id = clock.current;
        }

        /// Final Weight in epoch `e`. For the ended epoch these are the
        /// three cases of `epochs.rs::weight_and_principal_seconds`; for the
        /// current one, the same tail projected to its `ends_at`, which is
        /// what that function returns once the epoch ends with no further
        /// change.
        fn weight(&self, e: u64, clock: &Clock) -> u128 {
            let (start, end) = if e == clock.current {
                (clock.cur_start, clock.cur_end)
            } else {
                (clock.prev_start, clock.prev_end)
            };
            if self.created > e {
                0
            } else if self.epoch_id == e {
                self.weight_acc + u128::from(self.entries) * elapsed(self.last_update, end)
            } else if self.epoch_id > e {
                assert_eq!(self.frozen_epoch, e, "register would refuse this read");
                self.frozen_weight
            } else {
                u128::from(self.principal) * elapsed(start, end)
            }
        }
    }

    /// `epochs.rs::grid_floor`.
    fn grid_floor(anchor: i64, period: i64, t: i64) -> i64 {
        anchor + (t - anchor).div_euclid(period) * period
    }

    /// Leaf Weights of every Player in epoch `e`, in O(n): `P[i] =
    /// P[i - lowbit(i)] + entry i`.
    fn leaf_weights(nodes: &[Node], e: u64, clock: &Clock) -> Vec<u128> {
        let mut pre = vec![0u128; nodes.len() + 1];
        for i in 1..=nodes.len() {
            pre[i] = pre[i - lowbit(i)] + read(&nodes[i - 1], e, clock).unwrap();
        }
        pre.windows(2).map(|w| w[1] - w[0]).collect()
    }

    #[derive(Default, Debug)]
    struct Coverage {
        events: u64,
        epochs: u64,
        gap_events: u64,
        late_begins: u64,
        skipped_grid: u64,
        live_appends: u64,
        idle_current_checks: u64,
        idle_previous_checks: u64,
        previous_checks: u64,
        lifting_checks: u64,
        precredits: u64,
        period_changes: u64,
    }

    /// One pool: the tree and the eager model side by side. Player `k` sits
    /// at leaf `k + 1`, and Player 0 is the House.
    struct Sim {
        rng: Rng,
        clock: Clock,
        now: i64,
        anchor: i64,
        period: i64,
        tree: Vec<Node>,
        players: Vec<Eager>,
        acted_current: Vec<bool>,
        /// Expected Weight in the previous epoch of Players idle through it.
        idle_previous: Vec<Option<u128>>,
        cov: Coverage,
    }

    const MAX_PLAYERS: usize = 24;
    const MAX_AMOUNT: u64 = 1_000_000_000_000; // 1M USDC at 6 decimals

    impl Sim {
        fn new(seed: u64) -> Self {
            let mut rng = Rng(seed);
            let period = match rng.below(4) {
                0 => 600,
                1 => 3_600,
                2 => 86_400,
                _ => 60 + rng.below(100_000) as i64,
            };
            let anchor = rng.below(1_000_000) as i64;
            let now = 1_700_000_000 + rng.below(1_000_000) as i64;
            let mut sim = Sim {
                rng,
                clock: Clock::default(),
                now,
                anchor,
                period,
                tree: Vec::new(),
                players: Vec::new(),
                acted_current: Vec::new(),
                idle_previous: Vec::new(),
                cov: Coverage::default(),
            };
            // `begin_epoch` for epoch 1: a stub from `now` to the next grid
            // point.
            sim.begin_epoch();
            sim.new_player(); // the House
            sim
        }

        /// `epochs.rs::begin_epoch`'s schedule, then the idle-player stash.
        fn begin_epoch(&mut self) {
            let start = if self.clock.current == 0 {
                self.now
            } else {
                let grid = grid_floor(self.anchor, self.period, self.now);
                if grid > self.clock.cur_end {
                    self.cov.skipped_grid += 1;
                }
                if self.now > self.clock.cur_end {
                    self.cov.late_begins += 1;
                }
                self.clock.cur_end.max(grid)
            };
            let end = grid_floor(self.anchor, self.period, start) + self.period;
            let ended_len = elapsed(self.clock.cur_start, self.clock.cur_end);
            self.idle_previous = self
                .players
                .iter()
                .zip(&self.acted_current)
                .map(|(p, &acted)| (!acted).then(|| u128::from(p.principal) * ended_len))
                .collect();
            self.clock.begin_epoch(start, end);
            self.acted_current = vec![false; self.players.len()];
            self.cov.epochs += 1;
        }

        /// A first deposit's append, checked to leave every other Player's
        /// Weight alone in both readable epochs.
        fn new_player(&mut self) -> usize {
            let before = self.readable_weights();
            let node = append(&self.tree, &self.clock).expect("append");
            self.tree.push(node);
            self.players.push(Eager::new(&self.clock, self.now));
            self.acted_current.push(true);
            self.idle_previous.push(None);
            let after = self.readable_weights();
            for ((e, b), (_, a)) in before.iter().zip(&after) {
                assert_eq!(&a[..b.len()], &b[..], "append moved a Weight in epoch {e}");
                assert_eq!(a[b.len()], 0, "a new leaf starts empty in epoch {e}");
            }
            if self.players.len() > 1 {
                self.cov.live_appends += 1;
            }
            self.players.len() - 1
        }

        fn readable_weights(&self) -> Vec<(u64, Vec<u128>)> {
            let c = self.clock.current;
            core::iter::once(c)
                .chain(c.checked_sub(1).filter(|&p| p > 0))
                .map(|e| (e, leaf_weights(&self.tree, e, &self.clock)))
                .collect()
        }

        /// One instruction on Player `k`: `touch` first, then `op` changes
        /// Principal and Entries (and returns any round pre-credit it put in
        /// `weight_acc`), then the same change goes into the tree.
        fn act(&mut self, k: usize, op: impl FnOnce(&mut Eager, &mut Rng, &Clock, i64) -> u128) {
            let (clock, now) = (self.clock, self.now);
            let p = &mut self.players[k];
            p.touch(&clock, now);
            let (p0, t0) = (p.principal, p.entries);
            let pre = op(p, &mut self.rng, &clock, now);
            let d_principal = i128::from(p.principal) - i128::from(p0);
            let d_tickets = i128::from(p.entries) - i128::from(t0);
            let d_weight = clock.forward(d_tickets, now).unwrap() + pre as i128;
            update(&mut self.tree, k + 1, d_principal, d_weight, &clock).expect("update");
            self.acted_current[k] = true;
            if now >= clock.cur_end {
                self.cov.gap_events += 1;
            }
            if pre > 0 {
                self.cov.precredits += 1;
            }
            self.cov.events += 1;
        }

        fn depositor(&mut self) -> Option<usize> {
            (self.players.len() > 1)
                .then(|| 1 + self.rng.below(self.players.len() as u64 - 1) as usize)
        }

        fn step(&mut self) {
            if self.now >= self.clock.cur_end && self.rng.chance(35) {
                if self.rng.chance(5) {
                    // The authority changes `epoch_seconds` between epochs.
                    self.period = 60 + self.rng.below(100_000) as i64;
                    self.cov.period_changes += 1;
                }
                self.begin_epoch();
                return;
            }
            self.now += if self.rng.chance(2) {
                // The Operator is down for whole epochs.
                self.period * (1 + self.rng.below(3) as i64)
            } else {
                self.rng.upto(self.period as u64 / 12 + 1) as i64
            };
            let roll = self.rng.below(100);
            let target = self.depositor();
            match (roll, target) {
                (0..=7, _) if self.players.len() < MAX_PLAYERS => {
                    let k = self.new_player();
                    self.act(k, |p, rng, _, _| {
                        let a = 1 + rng.below(MAX_AMOUNT);
                        p.principal += a;
                        p.entries += a;
                        0
                    });
                }
                (8..=32, Some(k)) => self.act(k, |p, rng, _, _| {
                    // Deposit, or settled yield: both add Principal and
                    // Tickets one for one.
                    let a = 1 + rng.below(MAX_AMOUNT);
                    p.principal += a;
                    p.entries += a;
                    0
                }),
                (33..=44, Some(k)) => self.act(k, |p, rng, _, _| {
                    // Instant withdraw under the Tickets rule.
                    let a = rng.upto(p.principal.min(p.entries));
                    p.principal -= a;
                    p.entries -= a;
                    0
                }),
                (45..=50, Some(k)) => self.act(k, |p, rng, _, _| {
                    // `request_withdraw`: Entries saturate.
                    let a = rng.upto(p.principal);
                    p.principal -= a;
                    p.entries = p.entries.saturating_sub(a);
                    0
                }),
                (51..=52, Some(k)) => self.act(k, |p, _, _, _| {
                    // `emergency_withdraw`.
                    p.principal = 0;
                    p.entries = 0;
                    0
                }),
                (53..=74, Some(k)) => self.act(k, |p, rng, clock, now| {
                    // `buy_position`: pre-credit the stake to the round's
                    // end, then take it out of Entries. Rounds end inside
                    // their epoch and close before they end.
                    if now + 1 >= clock.cur_end || p.entries == 0 {
                        return 0;
                    }
                    let round_end = now + 1 + rng.below((clock.cur_end - now) as u64) as i64;
                    let stake = 1 + rng.below(p.entries);
                    let pre = u128::from(stake) * elapsed(now, round_end);
                    p.weight_acc += pre;
                    p.entries -= stake;
                    pre
                }),
                (75..=89, _) => {
                    // Tickets in with no Principal: a win, a void refund, a
                    // forfeit or cut to the House, a bought or granted
                    // Ticket. The House (Player 0) is a valid target.
                    let k = self.rng.below(self.players.len() as u64) as usize;
                    self.act(k, |p, rng, _, _| {
                        p.entries += 1 + rng.below(MAX_AMOUNT);
                        0
                    })
                }
                _ => {} // nobody acts; time passes
            }
        }

        /// Tree against the eager model, for every Player, in both readable
        /// epochs.
        fn check(&mut self, lifting: bool) {
            let clock = self.clock;
            for (e, tree_w) in self.readable_weights() {
                let is_current = e == clock.current;
                for (k, p) in self.players.iter().enumerate() {
                    assert_eq!(
                        tree_w[k],
                        p.weight(e, &clock),
                        "Player {k}, epoch {e} (current {})",
                        clock.current
                    );
                    if is_current && !self.acted_current[k] {
                        assert_eq!(
                            tree_w[k],
                            u128::from(p.principal) * clock.length(e).unwrap()
                        );
                        self.cov.idle_current_checks += 1;
                    }
                    if !is_current {
                        if let Some(Some(w)) = self.idle_previous.get(k) {
                            assert_eq!(tree_w[k], *w, "idle Player {k} in epoch {e}");
                            self.cov.idle_previous_checks += 1;
                        }
                    }
                }
                if !is_current {
                    self.cov.previous_checks += 1;
                }
                let total: u128 = tree_w.iter().sum();
                assert_eq!(
                    prefix(&self.tree, self.tree.len(), e, &clock).unwrap(),
                    total
                );
                if lifting {
                    self.check_lifting(e, &tree_w, total);
                }
            }
        }

        fn check_lifting(&mut self, e: u64, tree_w: &[u128], total: u128) {
            let clock = self.clock;
            let mut start = 0u128;
            for (k, &w) in tree_w.iter().enumerate() {
                if w > 0 {
                    let targets = [start, start + w - 1, start + self.rng.next() as u128 % w];
                    for t in targets {
                        assert_eq!(find(&self.tree, t, e, &clock), Ok(k + 1), "target {t}");
                    }
                    assert_eq!(
                        leaf_range(&self.tree, k + 1, e, &clock),
                        Ok((start, start + w))
                    );
                }
                start += w;
            }
            assert_eq!(
                find(&self.tree, total, e, &clock),
                Err(TreeError::TargetOutOfRange)
            );
            self.cov.lifting_checks += 1;
        }
    }

    #[test]
    fn node_is_72_bytes() {
        assert_eq!(NODE_SIZE, 72);
        assert_eq!(core::mem::align_of::<Node>(), 8);
    }

    /// Checklist items 1 and 2: same Weight per Player as today's `touch`
    /// and `register`, to the unit, in the current epoch and in the previous
    /// one while the current is written, over random sequences.
    #[test]
    fn matches_todays_touch_over_random_sequences() {
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
            all.gap_events += c.gap_events;
            all.late_begins += c.late_begins;
            all.skipped_grid += c.skipped_grid;
            all.live_appends += c.live_appends;
            all.idle_current_checks += c.idle_current_checks;
            all.idle_previous_checks += c.idle_previous_checks;
            all.previous_checks += c.previous_checks;
            all.lifting_checks += c.lifting_checks;
            all.precredits += c.precredits;
            all.period_changes += c.period_changes;
        }
        // The generator must actually reach every case it claims to cover.
        let Coverage {
            gap_events,
            late_begins,
            skipped_grid,
            live_appends,
            idle_current_checks,
            idle_previous_checks,
            previous_checks,
            lifting_checks,
            precredits,
            period_changes,
            ..
        } = all;
        for (name, n) in [
            ("gap events", gap_events),
            ("late begin_epoch", late_begins),
            ("skipped grid points", skipped_grid),
            ("appends to a live tree", live_appends),
            ("idle checks, current epoch", idle_current_checks),
            ("idle checks, previous epoch", idle_previous_checks),
            ("previous-epoch checks", previous_checks),
            ("binary lifting checks", lifting_checks),
            ("round pre-credits", precredits),
            ("epoch length changes", period_changes),
        ] {
            assert!(n > 0, "never exercised: {name}");
        }
        println!("{all:?}");
    }

    const LEN: i64 = 1_000;

    /// A tree with `n` leaves, in epoch 1 = `[0, LEN)`.
    fn fresh(n: usize) -> (Vec<Node>, Clock) {
        let mut clock = Clock::default();
        clock.begin_epoch(0, LEN);
        let mut tree = Vec::new();
        for _ in 0..n {
            let node = append(&tree, &clock).unwrap();
            tree.push(node);
        }
        (tree, clock)
    }

    fn deposit(tree: &mut [Node], clock: &Clock, leaf: usize, a: u64, now: i64) {
        let d = i128::from(a);
        update(tree, leaf, d, clock.forward(d, now).unwrap(), clock).unwrap();
    }

    fn weight(tree: &[Node], clock: &Clock, leaf: usize, e: u64) -> u128 {
        let (s, end) = leaf_range(tree, leaf, e, clock).unwrap();
        end - s
    }

    /// Checklist item 3.
    #[test]
    fn a_player_who_never_acts_weighs_principal_times_length() {
        let (mut tree, mut clock) = fresh(5);
        deposit(&mut tree, &clock, 2, 300, 0);
        deposit(&mut tree, &clock, 4, 700, 0);

        // Epoch 2 runs 2,000 s after a 500 s gap. Leaf 4 acts, leaf 2 never.
        clock.begin_epoch(LEN + 500, LEN + 2_500);
        deposit(&mut tree, &clock, 4, 50, LEN + 600);
        assert_eq!(weight(&tree, &clock, 2, 2), 300 * 2_000);
        assert_eq!(weight(&tree, &clock, 2, 1), 300 * LEN as u128);

        // Still `principal × length` for epoch 2 while epoch 3 is written,
        // including after leaf 2 itself acts in epoch 3.
        clock.begin_epoch(LEN + 2_500, LEN + 3_500);
        deposit(&mut tree, &clock, 2, 1_000, LEN + 2_600);
        deposit(&mut tree, &clock, 1, 1, LEN + 2_600);
        assert_eq!(weight(&tree, &clock, 2, 2), 300 * 2_000);
        assert_eq!(weight(&tree, &clock, 4, 2), 700 * 2_000 + 50 * 1_900);
    }

    /// Checklist item 4.
    #[test]
    fn a_change_in_the_gap_credits_zero_to_the_ended_epoch_and_full_to_the_next() {
        let (mut tree, mut clock) = fresh(3);
        deposit(&mut tree, &clock, 1, 100, 0);
        // Epoch 1 ended at LEN; `begin_epoch` has not run yet.
        deposit(&mut tree, &clock, 2, 400, LEN + 30);
        assert_eq!(weight(&tree, &clock, 2, 1), 0);
        assert_eq!(weight(&tree, &clock, 1, 1), 100 * LEN as u128);

        clock.begin_epoch(LEN + 60, 2 * LEN + 60);
        assert_eq!(weight(&tree, &clock, 2, 2), 400 * LEN as u128);
        assert_eq!(weight(&tree, &clock, 2, 1), 0);
    }

    /// Checklist item 5, with a deterministic growth to 300 leaves on top of
    /// the random appends in the property test.
    #[test]
    fn appending_leaves_every_existing_weight_unchanged() {
        let mut rng = Rng(7);
        let (mut tree, mut clock) = fresh(1);
        let mut now = 0;
        while tree.len() < 300 {
            now += rng.below(40) as i64;
            if now >= clock.cur_end {
                clock.begin_epoch(clock.cur_end, clock.cur_end + LEN);
            }
            let leaf = 1 + rng.below(tree.len() as u64) as usize;
            deposit(&mut tree, &clock, leaf, rng.below(1_000), now);

            let epochs = [clock.current, clock.current - 1];
            let before = epochs.map(|e| leaf_weights(&tree, e, &clock));
            let node = append(&tree, &clock).unwrap();
            tree.push(node);
            for (e, b) in epochs.iter().zip(&before) {
                let after = leaf_weights(&tree, *e, &clock);
                assert_eq!(&after[..b.len()], &b[..], "epoch {e}, n = {}", tree.len());
                assert_eq!(after[b.len()], 0);
            }
        }
        assert!(clock.current >= 3, "growth crossed epochs");
    }

    /// Checklist item 6, exhaustively: every target in `[0, total)` maps to
    /// the leaf whose range holds it, zero-weight leaves are never picked,
    /// and `total` itself is out of range.
    #[test]
    fn binary_lifting_maps_every_target_to_its_leaf() {
        let mut rng = Rng(11);
        for n in 1..=70usize {
            let (mut tree, mut clock) = fresh(n);
            for leaf in 1..=n {
                if rng.chance(70) {
                    deposit(&mut tree, &clock, leaf, rng.below(4), 997);
                }
            }
            clock.begin_epoch(LEN, LEN + 2);
            for leaf in 1..=n {
                if rng.chance(30) {
                    deposit(&mut tree, &clock, leaf, rng.below(3), LEN + 1);
                }
            }
            for e in [1, 2] {
                let ws = leaf_weights(&tree, e, &clock);
                let mut t = 0u128;
                for (k, &w) in ws.iter().enumerate() {
                    for _ in 0..w {
                        assert_eq!(find(&tree, t, e, &clock), Ok(k + 1), "n {n} epoch {e}");
                        t += 1;
                    }
                }
                assert_eq!(find(&tree, t, e, &clock), Err(TreeError::TargetOutOfRange));
                if t > 0 {
                    let leaf = pick(&tree, rng.next() as u128, e, &clock).unwrap();
                    assert!(ws[leaf - 1] > 0);
                }
            }
        }
    }

    /// Checklist item 8. A stake taken in epoch `e` is already back in
    /// epoch `e + 1`: the slot reset rebuilds the Weight from
    /// `principal_sum`, which a stake never lowers. Crediting a void refund
    /// after the rollover would count the stake twice, exactly as today's
    /// `settle_position` evaporates a late reward for the same reason.
    #[test]
    fn a_stake_from_a_rolled_over_epoch_is_already_back() {
        let (mut tree, mut clock) = fresh(2);
        deposit(&mut tree, &clock, 1, 1_000, 0);
        deposit(&mut tree, &clock, 2, 1_000, 0);

        // Leaf 1 stakes 400 at t = 900 in a round ending at 960, which is
        // then voided and never settled inside epoch 1.
        let pre = 400 * 60;
        update(
            &mut tree,
            1,
            0,
            clock.forward(-400, 900).unwrap() + pre,
            &clock,
        )
        .unwrap();
        assert_eq!(weight(&tree, &clock, 1, 1), 1_000 * 960 + 600 * 40);

        clock.begin_epoch(LEN, 2 * LEN);
        // No refund yet, and leaf 1 already weighs its full Principal.
        assert_eq!(weight(&tree, &clock, 1, 2), weight(&tree, &clock, 2, 2));

        // A refund credited now would put leaf 1 above its Principal.
        update(
            &mut tree,
            1,
            0,
            clock.forward(400, LEN + 100).unwrap(),
            &clock,
        )
        .unwrap();
        assert_eq!(weight(&tree, &clock, 1, 2), 1_000 * LEN as u128 + 400 * 900);
    }

    #[test]
    fn epoch_two_back_is_not_readable() {
        let (tree, mut clock) = fresh(1);
        clock.begin_epoch(LEN, 2 * LEN);
        clock.begin_epoch(2 * LEN, 3 * LEN);
        assert_eq!(read(&tree[0], 1, &clock), Err(TreeError::EpochNotReadable));
    }

    /// The account holds 145,634 Players and no more: one past that would
    /// take it over the runtime's 10 MiB limit, so a deposit refuses by name
    /// before anything changes.
    #[test]
    fn the_account_refuses_a_node_past_10_mib() {
        assert_eq!(MAX_NODES, 145_634);
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
