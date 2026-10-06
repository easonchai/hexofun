# HEXO

The product is HEXO (hexo.fun). `hex_vault` is the program name and HexVault the codename; neither appears on a screen.

A no-loss savings app on Solana: users deposit USDC into a pool, earn a Base yield on it, the rest of the pool's yield becomes the daily draw's prize, and each depositor's Tickets decide their odds. Tickets can be risked in a MinePEA-style hex-tile game against other depositors to win more Tickets, but principal is never at stake.

Player-facing words differ from mechanism names in three places, on purpose: the screen says "day" where the code says epoch, "prize" or "hexpot" where the code says jackpot, and "tickets" where the code says entries. Code, API and program identifiers keep the mechanism names.

## Language

### Custody

**Pool**:
One deployed instance of the product: one accepted asset, one principal vault, one jackpot vault, one epoch schedule. The demo runs a single hexUSDC pool.
_Avoid_: Vault (ambiguous with the token accounts), protocol

**Deposit**:
The single action that puts USDC into the pool and credits equal Principal to the depositor at once. The matching Tickets start with the next epoch, and until then the amount is a Pending deposit.
_Avoid_: Stake, mine, buy-in

**Principal**:
A depositor's 1:1 claim on the USDC they deposited, tracked as a number in their Player account. Never at risk in the game or the draw.
_Avoid_: PT, principal token, receipt, balance

**Withdraw**:
Removing Principal from the pool with one request, `request_withdraw(amount)`, which needs Principal, less what is already queued, of at least the amount and splits it. The part up to the Player's Pending deposit never held a Ticket and refunds in the same transaction. It pays from free idle in the principal vault and redeems any gap from the venue in the same instruction. When the venue's free liquidity cannot cover the gap the whole request fails and changes nothing. The rest becomes a Pending withdrawal and pays after the epoch it was requested in ends, when anyone may push the transfer with `process_withdraw`, unless the pool is Impaired, when only the owner may. There is no instant exit for Principal that holds Tickets. A pause blocks neither part, and while the pool is Impaired both pay a Haircut.
_Avoid_: Unstake, redeem (a venue operation), cash out

**Pending withdrawal**:
The queued part of a withdrawal request, whose USDC has not moved yet. It lives on the Player as `pending_withdraw` and `pending_epoch`, and is summed across the pool as `Pool.pending_withdrawals`. It is a sub-balance of Principal and a reservation of idle USDC, not a second claim beside Principal. The Principal and Tickets behind it stay in place until it pays, so it stays in the draw and the game and keeps earning yield. The transfer happens on the first `process_withdraw` after `pending_epoch` ends, which takes the amount off Principal and Tickets. It fails with `InsufficientVaultLiquidity` while the vault is short, and it fails while the Player has a Position open, so a stake cannot sit on the board while its Principal leaves (ADR 0021). Several requests in one epoch merge into one.
_Avoid_: Queue, unbonding, escrow, claim, instant withdraw (retired)

**Pending deposit**:
Principal deposited in the current epoch. It earns yield from the second it lands and Tickets from the next epoch, and the Player can refund it at once. It lives on the Player as `pending_deposit` and `pending_deposit_epoch`, and it is part of Principal, not an addition to it. The screen shows it as "+N from tomorrow's draw" beside the active Tickets.
_Avoid_: Unconfirmed deposit, escrow, queued deposit, activation queue

**Player**:
One wallet's account in one pool: its Principal, Tickets, any Pending deposit and Pending withdrawal, the Yield index at its last settle, and its Leaf in the Weight tree.
_Avoid_: User account, position (a game concept)

**House**:
The Player account owned by the Operator key. It holds no Principal, receives forfeited round pots as Tickets, and competes in the draw like any player. Its Tickets reset to zero each epoch.
_Avoid_: Admin wallet, protocol player, operator (a service, not an account)

**Treasury**:
The USDC account that receives the Yield fee at each Harvest and 20% of a prize the House wins. `create_pool` is given its address and the Admin can change it, and on mainnet that address is the Admin multisig's associated token account.
_Avoid_: Fee account, protocol revenue

**Buyback reserve**:
The USDC account that receives 50% of a prize the House wins, earmarked for a future token buyback. Its address is set at `create_pool` like the Treasury's.
_Avoid_: Buyback wallet, HEX fund

**Base yield**:
The depositors' share of what the venue paid: the gain left after the Yield fee, up to a ceiling of `base_rate_bps` a year on `total_principal`. It floats with the venue's rate and with how much of the pool is deployed, and anything above the ceiling goes to the Prize. Credited through the Yield index, never from a budget. The screen shows it as "up to X%" beside the rate actually paid over the last 7 days.
_Avoid_: Interest, APY (as the mechanism name), staking reward, fixed rate, Yield budget (retired)

**Sync**:
The first step of every instruction that moves USDC or changes Principal. It values the pool's venue position, repays any recorded deficit from the gain, splits the rest into the Yield fee, the Base yield share and the prize share, and raises the Yield index by the Base yield share. It moves no USDC and never runs on its own; a second Sync in the same second does nothing.
_Avoid_: Harvest (which moves USDC), accrue, refresh (klend's reserve update, which Sync calls), crank

**Yield index**:
A pool-wide number, scaled by 1e18, that rises at each Sync by the Base yield share per unit of Principal and never falls. A Player settles against it when they act: their Principal times the rise since their last settle is added to their Principal and Tickets. A credit that rounds to zero leaves the Player's stored index where it was, so a small balance accumulates instead of losing every fraction.
_Avoid_: Share price, exchange rate (klend's cToken term), accumulator, APY

**Yield fee**:
The team's cut of each venue gain, taken first at Sync: `yield_fee_bps` of the gain, default 10%, capped at 20% by a program constant. It is owed on the Pool until Harvest sends it to the Treasury.
_Avoid_: House cut (a game cut, paid in Tickets), performance fee, rake, protocol revenue

**Idle band**:
The share of the pool's USDC kept in the principal vault instead of at the venue, between a floor of 5% and a target of 10% by default. Free idle is the vault balance minus Pending withdrawals. Anyone may deploy what sits above the target to the venue, and anyone may recall from the venue while free idle is under the target. Either key can pause deployment; only the Admin restarts it.
_Avoid_: Buffer, reserve (klend's lending reserve), float, Deployed principal (retired)

**Harvest**:
The permissionless instruction that redeems the Yield fee owed and the prize share owed from the venue, sends the first to the Treasury and the second to the jackpot vault, and emits both amounts. The Operator runs it once per epoch before `epoch_end`; a missed one makes that day's Prize smaller and the next one larger. It touches no Player and is refused while Impaired.
_Avoid_: Sync (which moves no USDC), claim, sweep, funding the jackpot

**Impaired**:
A pool state set when the venue position's value falls between two Syncs by more than the loss tolerance, 1 bps by default. The prize share owed absorbs the loss first, then the Yield fee owed; what remains is a recorded deficit. While Impaired, Harvest, deploy and deposits are refused and every withdrawal pays a Haircut. A queued withdrawal and an Emergency withdraw then pay only with the owner's signature, so leaving at the Haircut is the depositor's choice (ADR 0021). `request_withdraw`, `recall` and `cover_deficit` still work. It clears when later gains or the permissionless `cover_deficit` bring the deficit to zero. The Yield index does not fall.
_Avoid_: Paused (a separate switch), insolvent, frozen, default

**Haircut**:
What a withdrawal pays while the pool is Impaired: the amount times the pool's real value, `vault balance + venue value − owed amounts`, divided by `total_principal`, rounded down. A Pending withdrawal sits inside `total_principal`, so it is not counted a second time. Principal and Tickets still fall by the full amount, and a Player who leaves this way takes no part in a later recovery. The refund of a Pending deposit, a processed Pending withdrawal and Emergency withdraw all apply it, and a queued one applies it at the moment it pays. While Impaired, only the Player's owner can trigger the queued and Emergency withdraw payments, so nobody else can realise a Haircut for them.
_Avoid_: Loss (the venue's fall in value), slashing, penalty, exit fee

### Lottery

**Bought tickets**:
Tickets a depositor pays USDC for, at a pool-set number of Tickets per USDC, up to their locked Principal (the Pending deposit excluded) in USDC per epoch. The USDC goes to the jackpot vault and is never returned. Bought tickets are ordinary Tickets from the moment they land. `buy_tickets` is refused while the pool's on-chain buy-tickets pause is set, which only the Admin changes and which is on at mainnet launch.
_Avoid_: Purchased entries, deposit (a bought ticket is not Principal)

**Granted tickets**:
Tickets credited to a Player by the Operator key or the Admin rather than earned by depositing, buying or playing. Operator grants are capped per Player at their locked Principal (the Pending deposit excluded) and per pool at the Principal total as the epoch began; Admin grants are not. Ordinary Tickets once credited.
_Avoid_: Minted tickets, airdrop, free tickets (those are the daily reset)

**Referral bonus**:
The Granted tickets a Referrer receives at the start of each epoch: a rate set by their count of Qualified referrals, applied to those referrals' Principal.
_Avoid_: Commission, referral reward pool


**Tickets**:
A whole-unit count, one per micro-USDC, and the number the draw selects over. A Player holds Principal's worth of Tickets in each epoch, and fresh Principal joins from the next epoch, so a deposit made today is in tomorrow's draw. Yield, Bought tickets, Granted tickets, round rewards, void refunds, House credits and the Prize add Tickets the moment they land. The game moves them between players, and Tickets reset to equal Principal at each new epoch. Non-transferable, non-redeemable, never USDC. Code, the API and the program call them entries (`Player.entries`); the screen and this glossary say Tickets.
_Avoid_: Entries (on screen), ET, entry token, chances, chips, TWAB

**Weight**:
Retired as a quantity. It was Tickets times seconds held, and the draw now selects over Tickets, so the number on screen is the number the draw uses. The word survives only in "Weight tree".
_Avoid_: TWAB, average balance, odds, registered weight (retired), ticket-seconds

**Weight tree**:
One zero-copy account per pool that holds every Player's Tickets as a Fenwick tree, one entry per Player ever created. Each entry keeps two epoch-parity slots, so a new epoch starts with no transaction and the ended one stays readable until the epoch after next begins. The root is the epoch's total Tickets, and the Draw walks down from it to the winner. It grows by one 56-byte entry at a Player's first deposit, paid for by that depositor, up to 10 MiB, about 187,000 Players. It replaced per-Player registration.
_Avoid_: Sum tree (the general structure), registration, snapshot, Merkle tree

**Leaf**:
A Player's place in the Weight tree: an index assigned at first deposit, stored on the Player, never reused. A Fenwick entry holds a range sum, not one Player's value, so a Player's own Tickets in the tree are the difference of two prefix sums; the Indexer reads the Player's Tickets directly. `payout` checks that the winner's Leaf range holds the draw's target.
_Avoid_: Node, entry (a tree slot that sums a range), slot (one epoch-parity half of an entry), registration interval

**Epoch**:
One lottery cycle. Its boundaries are points on a fixed grid: the pool's Anchor sets where the grid sits, and the cycle length, a pool parameter, sets the spacing. Epochs are contiguous, and a late crank lands on the same grid a punctual one would, so an operator outage skips whole epochs instead of moving the boundary. A pool's first epoch is the short stub from launch to the next grid point.
_Avoid_: Season, draw period

**Anchor**:
The timestamp that fixes the phase of a pool's epoch grid, so the draw ends at the same clock time every cycle instead of at whatever second the pool launched. The pool's anchor is a Sunday 16:00 UTC, one instant that sits on the hourly, daily and weekly grids at once, so changing the cycle length never moves the draw off midnight Malaysian time.
_Avoid_: Epoch start, genesis, offset

**Daily draw**:
The player-facing name for one epoch's draw and payout. The screen says "daily draw", "day #4", "draw in 3h 20m"; code and the API say epoch. The cycle length is a pool parameter, so the name follows the pool's cadence rather than fixing it.
_Avoid_: Jackpot, lottery, raffle

**Prize**:
What the jackpot vault holds for an epoch at close, paid in full to the daily draw's single winner: the prize share of venue yield, which is whatever is left above the Base yield ceiling after the Yield fee, plus sponsor money sent through `fund_jackpot` and Bought tickets' USDC. Harvest moves the prize share into the jackpot vault before the epoch ends. Code and the API call this amount the jackpot (`jackpotAmount`, `fund_jackpot`).
_Avoid_: Jackpot (on screen), pot, reward (a game concept)

**Hexpot**:
The jackpot vault's current balance: this epoch's prize once funded, plus anything a rollover or the House's 30% seed left behind. Shown on the odometer under the board, served by the Read model, which reads the vault balance on the browser's behalf.
_Avoid_: Jackpot (on screen), honeypot, prize pool

**Draw**:
The verifiable random selection of one point in an epoch's Ticket total via ORAO VRF. The program hashes all 64 bytes of the randomness and reduces the digest to a target under the 64-bit total of Tickets. The Player whose Leaf in the Weight tree covers the target wins the Prize.
_Avoid_: Snapshot, lottery, raffle

**Payout**:
Moving the Prize from the jackpot vault into the principal vault and adding it to the winner's Principal, so it compounds and is withdrawn like any other Principal. No claim step, and no signer: the operator cranks it, but anyone can, because the winner is fixed on chain. If the House wins, the Prize splits 50% buyback reserve, 30% stays for the next epoch, 20% treasury.
_Avoid_: Claim, redeem

**Rollover**:
A Prize that stays in the hexpot for the next epoch because the epoch ended with no Tickets, the draw's randomness never arrived, or the jackpot vault held less than the pool's `min_jackpot` when the draw was requested.
_Avoid_: Expiry, unclaimed prize

### Game

**Round**:
One 60 second game on the 36-tile hex board. Players place Tickets on tiles; VRF selects one winning tile; the round pot goes to the positions on it.
_Avoid_: Game, match, session

**Tile**:
One of the 36 indexed hex cells (0 to 35) on a round's board.
_Avoid_: Hex, cell, square

**Position**:
A Player's immutable placement in one round: a set of tiles and one uniform stake per tile, paid in Tickets. One per Player per round; the Position address is derived from the round and the owner, so a second `buy_position` in the same round fails.
_Avoid_: Bet, wager, deployment, mine, top-up

**Round pot**:
All Tickets staked in a round. The positions covering the winning tile get their own stakes back, and the losers' pot, the rest of the pot after the House cut, is distributed to them pro rata, so the total Tickets in the pool is unchanged by a round.
_Avoid_: Bonus, reward pool, prize pool

**House cut**:
A pool-configurable percentage of a settled round's losers' pot, the pot minus the winning tile's total, credited to the House as Tickets. Winners get their own stake back whole and pay the cut only on what they win. Forfeited and voided rounds have no House cut. PRD-V2 calls this the round fee.
_Avoid_: Round fee, tax, rake, commission, Yield fee (a cut of venue yield)

**Round reward**:
A winning position's own stake back plus its share of the losers' pot after the House cut, credited as Tickets.
_Avoid_: Winnings, payout (a lottery concept), bonus

**Forfeit**:
A round pot whose winning tile nobody covered. It is credited to the House as Tickets.
_Avoid_: Burn, rollover (a lottery concept)

**Void**:
A round whose randomness never arrived within `vrf_timeout`. Every Position's stake comes back as Tickets when it settles, and no House cut is taken.
_Avoid_: Cancel, carry (the retired rule that moved a voided pot into the next round)

### Growth

**Invite code**:
A single-use code that lets a wallet past the beta gate. It may have an owner. Goes away with the beta. The gate is in the app, not the program.
_Avoid_: Access token, whitelist, referral code (a different thing)

**Referral code**:
A wallet's own code, one per wallet, minted at first deposit or once it is past the beta gate, unlimited uses, shared as a link. Applying it makes its owner that wallet's Referrer, before or after the wallet's first deposit. Outlives the beta; does not pass the beta gate.
_Avoid_: Invite code (a different thing), promo code

**Referrer**:
The owner of the Referral code a wallet applied, or failing that, the owner of the Invite code it redeemed. Bound at any time, deposited or not. Fixed for good once written.
_Avoid_: Sponsor, upline, inviter

**Qualified referral**:
A wallet whose Referrer is set and whose Principal has stayed at or above 50 USDC for the last 7 days without a break. Dropping below ends it at once; it restarts the 7 days from zero. The screen labels it "Active".
_Avoid_: Active referral (outside screen copy), crew member

### Operations

**Admin**:
The multisig or wallet that changes pool parameters, venue parameters included, unpauses (including starting the game and the jackpot on a new pool, and restarting deployment), sets the Bought tickets pause, changes the Treasury and Buyback reserve accounts, and rotates the Operator key. No instruction lets it send pool USDC anywhere. It is `Pool.admin` in the program, a Squads multisig on mainnet, and it never signs a round. The role moves in two steps, `propose_admin` then `accept_admin`, so a typo cannot hand the pool to an address nobody holds.
_Avoid_: Authority (the removed program role), owner, admin wallet, Operator

**Operator key**:
The hot keypair on the VPS that the Operator service signs with, and `Pool.operator` in the program. It exclusively opens epochs and rounds and requests the draw's randomness; settling, voiding, drawing and rolling over an epoch are permissionless (production-hardening ticket 01), and so are deploy, recall and Harvest, so the Operator key still cranks them but a stalled or stolen one cannot withhold a fulfilled result or leave a timed-out request stuck. It owns the House Player. Paying the winner needs no signer, so it only pays that transaction's fee. It can pause deployment but not restart it. It cannot change parameters, unpause, or move principal. The Admin rotates it in one transaction.
_Avoid_: Authority keypair, pool authority, admin key, hot wallet

**Operator**:
The backend service that advances the protocol: opens epochs and rounds, requests randomness, settles rounds and positions, deploys to and recalls from the venue to keep the Idle band, runs Harvest once per epoch, pays the winner, and pushes each Pending withdrawal once its epoch has ended. Deadline-driven: it sleeps until the next moment a decision could change rather than running on a fixed schedule, with a slow safety tick as its backstop. Signs with the Operator key and the Sparring player's keypair; never holds a human depositor's funds.
_Avoid_: Bot, cron, CLI, admin (a separate role), authority (the removed program role)

**Sparring player**:
A backend-owned Player that deposits once and buys one Position in every Round, on all 36 Tiles at one Ticket per tile, so a lone human always has someone to play against on whichever tile wins. On screen it is indistinguishable from any other wallet, and it competes in the draw like any Player. It is not the House. It runs only when its backend environment flag is set, and no production env file sets it.
_Avoid_: Bot, house player, NPC, dummy user

**Read model**:
The Indexer's Postgres mirror of program accounts and finalized events, and the only path by which the browser learns anything about the protocol. A cache may be bypassed for a fresher read; the Read model may not, since the browser keeps no chain read of its own to fall back to.
_Avoid_: Cache, backend

**Indexer**:
The backend component that mirrors program accounts and finalized events into Postgres. It is the Read model: the browser's only path to learning anything about the protocol.
_Avoid_: Cache, backend (too broad)

**Pause**:
A reversible pool state (`Pool.paused`) that stops all Ticket movement, `buy_position` and both `grant_tickets` paths, while leaving an open Round free to finish: Withdraw, `settle_round`, `void_round`, `settle_position`, `close_round`, the epoch cranks and `fund_jackpot` all stay open. Either the Admin or the Operator key can set it; only the Admin can unset it, so a stolen hot key can cost a day of rounds but cannot reopen a pool the team has halted.
_Avoid_: Shutdown (a separate, irreversible state), freeze, halt

**Shutdown**:
An admin-only, irreversible pool state (`Pool.shutdown`) that stops every inflow, the game and the draw, and lets withdrawals skip the epoch lock. Set once, by `shutdown`. Modelled on Marginfi/Kamino's ReduceOnly.
_Avoid_: Pause (a separate, reversible state), wind-down, freeze

**Game pause**:
A reversible pool switch (`Pool.game_paused`) that stops new Rounds opening and new Positions being bought. A Round already open still settles or voids, so no stake is stuck. Either key can turn it on; only the Admin can turn it off, and never after Shutdown. A new pool starts with it on, so turning it off is how the game starts. Set by `set_feature_pause`.
_Avoid_: Freeze, stop the board

**Jackpot pause**:
A reversible pool switch (`Pool.jackpot_paused`) that stops the epoch cycle at its next step: no new Epoch begins, no Tickets are bought or granted, and an ended Epoch does not request its draw. An Epoch already Drawing or Drawn still draws and pays. Rounds live inside an Epoch, so once the current one ends the game stops too. Same key rules and starting state as the Game pause.
_Avoid_: Draw freeze, skip the draw

**Feature gate**:
A per-deployment switch the team sets when the app is deployed that covers a feature (the game, the jackpot) with a Coming soon card of the same size, so the layout does not move. It says "not launched here yet" and knows nothing about the pool: a gated feature stays covered even when its Pause is off, and an ungated feature shows the Pause copy when its Pause is on. Never set on chain.
_Avoid_: Pause (a pool switch), feature flag, hide

**Emergency withdraw**:
A crank, valid only once a pool is shut down, that pays one Player's whole Principal to their own wallet in one instruction (`emergency_withdraw`). Principal already holds the Pending deposit and the Pending withdrawal, so nothing is paid twice, and a Haircut applies while Impaired. Anyone may run it for any Player while the pool is not Impaired, and only the owner while it is. The House is excluded, since its principal is protocol money and leaves through a Sweep instead.
_Avoid_: Force withdraw, bailout, rescue

**Sweep**:
The admin-only `sweep_house`, valid only once a pool is shut down, that moves the jackpot vault's surplus over `jackpot_reserved` to the Treasury. Never touches Principal; callable more than once.
_Avoid_: Drain, liquidate, close out

**Environment**:
One deployment of the whole stack: its own program keypair, its own pools, its own Postgres database and its own env file. Dev, staging and mainnet share nothing but the box and Traefik. See `docs/ops/environments.md`.
_Avoid_: Env (fine in code and flags), cluster (a Solana term, narrower than this)

**Active pool**:
The one Pool the backend and web are configured against. Every other Pool the database knows about is a retired pool: its rows stay, nothing reads them as current.
_Avoid_: Current pool, live pool, the pool (when more than one exists)

**Pool cutover**:
Pointing the backend and web at a new Active pool. Nothing in the database is deleted; invites, referral codes and referrals carry over, and the retired pool's rows stay as history. Depositors in the retired pool get their Principal back through Emergency withdraw.
_Avoid_: Pool switch, reset, wipe
