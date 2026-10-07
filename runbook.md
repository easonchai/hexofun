 # terminal 1 - postgres + backend
  docker compose -f docker-compose.dev.yml up -d

  # terminal 2 - frontend
  pnpm --filter @hexvault/web dev

  Then http://localhost:5173, Phantom set to devnet. Faucet gives you 1000 hexUSDC.

  Check it came up: curl localhost:8080/status should show rpcOk: true and a lastAction a few seconds old. Watch it work with docker
  compose -f docker-compose.dev.yml logs -f backend, a round every round_seconds plus a few seconds to settle.

  Shut down with down in place of up -d.

  Pushing runs a pre-push hook (check-deployable.sh, pnpm check:sh, pnpm test:unit, pnpm check; no CI); skip it
  once with git push --no-verify.

  `pnpm test:unit` only gives a real signal once `pnpm --filter @hexvault/backend test:db` has created and migrated
  the per-suite databases on the 5433 test Postgres. That script starts the `hexvault-test-pg` container itself
  when nothing answers on 5433; `docker-compose.dev.yml`'s postgres is the dev database on 5432, not this one.
  Without it, every DB-backed suite skips itself and prints a warning naming the database it could not reach; a
  green run without those warnings is the only one that counts.

  See also: docs/architecture.md (components, accounts, roles, fund flow), docs/ops/deploy.md
  (deploying and upgrading), docs/ops/funds.md (pulling and returning principal, shutdown),
  docs/ops/environments.md (dev/staging/mainnet) and docs/ops/incidents.md (what to do when an
  /alerts code fires).

  When you change something

  | Changed | Do |
  | --- | --- |
  | Backend code | `up -d --build backend` |
  | .env | `up -d --force-recreate backend` (restart won't re-read it) |
  | Frontend | nothing, Vite hot-reloads |
  | Program | `scripts/deploy.sh dev`, or `--upgrade` on top of an existing pool, then `up -d --build backend`. See docs/ops/deploy.md. |

  Two gotchas worth remembering. Never build with --features test-vrf before a devnet deploy: that stubs the ORAO CPI and the operator
  picks the wrong randomness PDA off the IDL (deploy.sh's check-deployable.sh step catches this). And if a deploy says ExtendProgram
  requires more bytes, deploy.sh prints the exact solana program extend command to run; see docs/ops/deploy.md.

  Nothing needs re-bootstrapping. Only bump POOL_ID and re-run bootstrap if you want a clean pool, and then paste the new ACCEPTED_MINT
  into .env. See docs/ops/environments.md for adding a pool without touching old ones.

  After the backend has been down

  Epochs chain: begin_epoch starts the next one at the previous ends_at. Before 2026-09-07 that held no matter how late, so a backend
  that came back after hours replayed the whole gap one epoch at a time (begin_epoch, request_draw, draw, payout, 20s to 40s each,
  with two registration transactions in front of the draw until the Fenwick draw removed them), paid the jackpot floor to
  the players once per replayed epoch, and opened no Round until it caught up:
  tick step 7 needs a whole round_seconds to fit before the epoch's ends_at, and a replayed epoch has already ended. The UI said
  "no open round" the entire time. Now begin_epoch starts the next epoch at the latest point of the anchor grid it has reached, so
  one begin_epoch after an outage lands in real time and Rounds resume on the next tick. Ordinary lag still chains from the previous
  ends_at, because the next grid point is not there yet, and either way the draw keeps the same clock time. See "Epoch anchor: when
  the draw lands" below.

  close_buffer: the draw window

  close_buffer is the number of seconds before a Round's ends_at that Positions close and request_round_randomness starts accepting
  requests. The operator's first tick step requests randomness the moment that window opens, so ORAO's round trip runs inside the
  countdown instead of after it.

  Measured on devnet over 40 Rounds: request to settle takes 4s to 7s on 39 of them and 71s once (ORAO's tail). The request itself
  lands about 2s after the window opens (blockhash fetch, send, confirm). close_buffer is set to 12s on 30s rounds: 2s to land
  the request, 4s to 7s for the draw, and the rest is margin. The web countdown ends at the close and the stage reads DRAWING
  until the settle lands, at which point the reveal fires, so a slow draw shows as a longer DRAWING rather than a timer stuck at
  zero. The operator sleeps until its next deadline, so the next Round opens a second after ends_at; a 60s safety tick and the
  randomness subscription are what else wakes it. vrf_timeout (180s, the program's floor) bounds the ORAO tail.

  Demo cadence (2026-09-10): epoch_seconds 86400, round_seconds 30, close_buffer 12, on the anchored pool bootstrapped with
  --epoch-anchor 2026-09-13T16:00:00Z. One draw a day, landing at 00:00 MYT. Rounds switch on the next Round, epochs on the next
  epoch, and epoch_seconds is now safe to change mid-epoch because touch reads the epoch's stored ends_at instead of adding the
  parameter to the start. Before this the pool ran hourly at epoch_seconds 3600 off an arbitrary boundary.

  Nobody funds the prize or the depositors' yield by hand any more (yield-claimer ticket 13). The operator harvests once per
  epoch, inside the last 10 minutes before ends_at, which pays the Yield fee to the Treasury and the prize share to the jackpot
  vault. request_draw snapshots whatever the jackpot vault holds, and an epoch that closes under the pool's min_jackpot rolls over
  instead of paying a token prize: the vault keeps its balance and the next epoch draws for it. Set that floor with `admin set-params
  --min-jackpot`, or at bootstrap with `--min-jackpot`; the default is 1 USDC. `admin fund-jackpot` still works for sponsor money,
  from any wallet holding the accepted mint, and nothing else needs a daily top-up.

  Venue cranks (yield-claimer ticket 13)

  The operator keeps the pool's liquidity in shape without a human signature. Deploy, recall and harvest are permissionless
  instructions, so anyone can send them if the operator is down. The operator sends them on this schedule:

    deploy   free idle (vault less queued withdrawals) is above the idle target and the excess is at least min_venue_move
    recall   free idle is under the idle floor; recalls up to the target, or exactly the gap when a small queued
             withdrawal is what is short
    harvest  once per epoch, in the last 10 minutes before ends_at, if the pool holds a venue position

  A matured withdrawal the vault cannot cover triggers a recall first, and the push lands on the next tick. Deploy waits while
  deploy is paused, the venue is impaired or the pool is shut down. A refused crank is logged as a warning and not retried for 10
  minutes; a failed harvest never holds up the draw. Every crank passes the klend reserve, the cToken account and the three
  klend-derived accounts the program needs, and no refresh instruction, since the program refreshes the reserve itself.

  Setting the deploy pause from the operator key is pending yield-claimer ticket 10, which adds the instruction.

  Changing a pool's venue (ADR 0023)

  Status: rehearsed on localnet (stub to stub) and on a Surfpool mainnet fork on 2026-10-07 (klend to klend, klend to
  kVault, emergency park; tests/fork/venue-switch.fork.ts). Not yet run on mainnet.

  A pool holds one venue, a klend reserve or a Kamino Earn vault. Moving it takes a proposal, a 48 hour lock the
  program enforces, a drain and a migration. Every command is the admin CLI, `pnpm --filter @hexvault/backend admin
  <command>`, run with the target environment's env exported as in "Admin actions through Squads" below. On mainnet,
  export `ADMIN_ADDRESS=<squads-vault>` and the admin-gated ones (propose-venue, cancel-venue, set-venue-params,
  start-deploy) print a base58 transaction for Squads to import. `migrate-venue` and the Operator's `drain-venue` need no
  multisig. A kVault pool's `drain-venue` and `migrate-venue` build v0 transactions, so the CLI refuses them with
  `ADMIN_ADDRESS` set or a Ledger loaded; run those two from the Operator key with `ADMIN_ADDRESS` unset (the tick sends
  both by itself, so this only matters for a hand drain). `pause-jackpot`, `pause-deploy` and the other Operator-or-Admin
  commands ignore `ADMIN_ADDRESS` and send from the loaded key. Read the pool's state from `GET /ops/summary`: `venueKind`,
  `venueValue`, `venueProposal` (with `unlocksAt`, chain unix seconds) and `venueParams`, or from the Pool account.

  The operator needs no change and no restart: it reads the pool's venue kind and pins from chain every tick and builds the
  deploy, drain and migrate accounts from them.

  Migration

    1. Prepare the target. Create the pool's token account for the target's position token before proposing, since
       nothing creates it later. For a kVault that is the shares mint; for a klend reserve it is the reserve's cToken mint
       (the PDA `["reserve_coll_mint", <market>, <USDC mint>]` under the klend program). Any funded keypair pays:

         spl-token create-account <SHARES_OR_CTOKEN_MINT> --owner <POOL_PDA> --fee-payer <FUNDED_KEYPAIR>

       Check: `spl-token account-info --address <ATA>` shows `Balance: 0`, the mint above and the pool PDA as owner (the
       command printed the ATA address). The Squads vault also needs a little SOL, because the Admin pays the proposal
       account's rent. The rent returns to the Admin when the proposal closes.

    2. Propose. The four flags are positional pins: for a kVault, `--program` is the kVault program, `--market` the vault
       state, `--reserve` the shares mint and `--ctoken` the pool's shares account. For klend they are the klend
       program, market, USDC reserve and the pool's cToken account. Re-read the addresses from Kamino's API the same day
       (`https://api.kamino.finance/kamino-market/<market>/reserves/metrics` for a reserve,
       `https://api.kamino.finance/kvaults/vaults` for a vault).

         admin propose-venue --kind kvault \
           --program KvauGMspG5k6rtzrqqn7WNn3oZdyKqLKwK2XWQ8FLjd \
           --market <VAULT_STATE> --reserve <SHARES_MINT> --ctoken <POOL_SHARES_ATA>

         admin propose-venue --kind klend \
           --program KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD \
           --market <MARKET> --reserve <USDC_RESERVE> --ctoken <POOL_CTOKEN_ATA>

       With `ADMIN_ADDRESS` set the CLI prints one unsigned base58 transaction on stdout (555 characters for klend, 735 for
       a kVault, fee payer the Admin) and says so on stderr; paste it into Squads' "Import base58 encoded tx" within about a
       minute, since its blockhash expires. Check: the `VenueProposed` event shows the right kind and pins and `unlocksAt`
       exactly 172800 seconds after `proposedAt`; `/ops/summary` shows `venueProposal`. From here the operator's tick takes
       no action (deploys refused with `VenueProposalOpen`, no early drain), `venueValue` keeps growing because the old venue
       earns until the lock ends, and deposits work as before (a deposit during the proposal was part of the fork run, and a
       withdrawal queued before it was untouched). A second `propose-venue` replaces the
       proposal and restarts the lock. Do not do that by accident.

    3. Lower the dust line. Do not skip this. The tick sizes its first drain from `venue_value` as of the last sync, which
       is up to the whole lock old. The drain's own sync books the interest accrued since, redeems the stale figure and
       leaves that interest in the venue. On the fork that was 3.17 USDC on a 13.5k USDC position. The tick then migrates as
       soon as the position is at or under `min_venue_move` (default 100 USDC), and the migration leaves it untracked at the
       old venue. With the default line the fork run did exactly that: `left_behind` 3,167,018 and the pool's claims 3.17 USDC
       above what it tracks. Lower the line so the tick drains the interest too, and put it back in step 8:

         admin set-venue-params --min-venue-move 10000

       Check: `venueParams.minVenueMove` in `/ops/summary` reads 10000. With 10000 (0.01 USDC) both klend sources ended with
       `left_behind` 0. 10000 is enough for a klend source; it has not been run from a kVault source, whose redeem keeps
       a flat 1,000 base units and which the program values 1,010 under the formula, so read `left_behind` before trusting it
       there (step 6).

    4. Wait out the lock. Deposits and withdrawals work throughout. Watch the target the whole time. If it turns bad
       (the vault's fee or penalty changes, an allocation reserve is deprecated), run `admin cancel-venue`. It closes the
       proposal and deploys resume. Check: `venueProposal` is null.

    5. Drain. After `unlocksAt` the operator's tick drains by itself, with no manual step. It asks for the whole
       `venueValue` the first time and for what accrued since each time after, in steps no larger than the old venue's free
       liquidity. The fork run: `drain_venue` (13,500.395408 USDC asked, all received), `drain_venue` (3.165125 USDC), then
       the migration, three ticks about a second apart. Anyone may also drain by hand
       (`drain-venue` also sets the deploy pause, which step 7 then has to clear):

         admin drain-venue --amount <ATOMIC_USDC>

       Check after each step: `venueValue` falls, the principal vault balance rises by about the same amount, and the
       `VenueDrained` event shows `received` against `asked`. A klend reserve that cannot pay fails with
       `VenueIlliquid` and nothing moves, so retry smaller once `reserveFreeLiquidity` recovers. A kVault may hand back less than asked, and the book
       falls only by what came back. Keep draining until `venueValue` is at or under the line from step 3. Do not
       migrate with a larger position and expect to come back for it: nothing redeems the old position afterwards.

    6. Migrate. The tick does it on the tick after the last drain. If it has not:

         admin migrate-venue

       Check: the `VenueMigrated` event shows `left_behind` at or under the step 3 line, ideally 0. `/ops/summary`
       shows the new `venueKind`, `venueProposal` null and `venueValue` 0. The old venue's token account for the
       pool (the cToken or shares account) holds at most that dust. The Admin's SOL balance rises by the proposal's
       rent. The migration is refused by name if the lock has not elapsed (`VenueLockNotElapsed`) or the position is
       too large (`VenuePositionNotEmpty`). Then drain again.

    7. Deploy at the new venue. The tick does it on the next tick (`deploy_to_venue`, under the idle band and the deploy
       caps, which read the new venue from then on). If a hand drain set the deploy pause, the tick deploys nothing until the
       Admin clears it:

         admin start-deploy

       Check: `DEPLOY_PAUSED` leaves `/alerts`, a `VenueDeployed` event follows within a tick or two, `venueValue` rises
       toward the whole non-idle share, and `freeIdleBps` settles near the idle target. The gap between the last drain
       and this deploy earned nothing: one to two seconds on the fork, a tick period in production.

    8. Restore the dust line, and record the move here with the signatures and the fork's CU numbers:

         admin set-venue-params --min-venue-move 100000000

  What the fork showed (2026-10-07, pool of 15.2k USDC, three Players, one queued withdrawal)

    - Every Player's Principal was the same before the first drain, after the migration and after the deploy at the new
      venue, for klend to klend and for klend to kVault. The queued 500 USDC withdrawal was paid by the tick once its epoch
      ended, from the new venue's pool (`process_withdraw`), and only the payee's Principal moved (down by 500, plus her
      accrued yield settled into it).
    - The solvency check (vault plus the position at the venue it points at, against Principal and what is owed) held at every
      step to within 1 base unit on klend (the vault run reads up to 0.27 USDC above, the program's conservative fee estimate);
      the only shortfall is the `left_behind` of step 3.
    - Compute units, whole transaction: `drain_venue` from klend 76k then 71k, `migrate_venue` 26k, `deploy_to_venue`
      87k at the OnRe reserve and 323k at the kVault (two days of stale reserves, 13.2k USDC), `process_withdraw` 45k from klend
      and 133k from the vault, `propose_venue` 13k to 16k. Messages are 395 to 602 bytes. The kVault deploy is v0 with the
      vault's own lookup table.
    - Rehearsed signatures and the full transcript: docs/plan/venue-switch/research/07-fork-rehearsals.md (not committed).

  Emergency park

  Status: rehearsed on localnet and on the fork (2026-10-07).

  Use it when the venue is going bad: a reserve being deprecated, a curator raising fees, a market losing liquidity. It
  needs no proposal and no lock, because the USDC only goes into the pool's own principal vault. It also earns nothing
  until the pool has a new venue, so do not park for a wobble. See "The venue is going bad" in docs/ops/incidents.md.

    1. Run it from the Operator key on the box, so nobody waits for multisig approvals. Unset `ADMIN_ADDRESS` (an env file
       that sets it makes the CLI print a Squads transaction instead). The CLI then signs with the loaded key, and the Operator may drain. Start with the whole position:

         admin drain-venue --amount <venueValue from /ops/summary>

       The transaction sets the deploy pause first and drains second, so the crank cannot put the money back (85k CU on
       klend). Check: `DEPLOY_PAUSED` appears in `/alerts`, `venueValue` falls and the principal vault balance rises. On
       the fork, 13,500.395626 USDC asked and received, 18 base units of `venueValue` left (accrued since the
       last sync), the tick deployed nothing, and a refund from the vault worked while parked.

    2. If the venue cannot pay that much, the call fails and nothing moves (`VenueIlliquid` on klend). Repeat with
       smaller amounts as liquidity allows. A kVault may return less than asked, and the book falls by what returned.
       Check after each: the `VenueDrained` event, and `venueValue` against the vault balance.

    3. Watch solvency while it runs. `/ops/summary` `solvencyMargin` must stay non-negative. A real loss shows as
       Impaired, which has its own playbook (docs/ops/incidents.md, "Venue loss"). Withdrawals pay from the vault the
       whole time, and the idle USDC earns nothing.

    4. Pick the new venue, then run the Migration above from step 1. The position is already under the line, so after the
       lock the tick migrates at once with no drain (`left_behind` 18 base units on the fork), and nothing deploys until
       step 7's `admin start-deploy`, which only the Admin can send. If the old venue recovers and the team stays,
       `admin start-deploy` alone resumes deploying.

  Daily referral bonus (docs/plan/hexo-referrals ticket 08)

  Fully automatic, no manual step: the operator's own crank grants it, right after begin_epoch opens each new epoch, off
  the qualified referrals in Postgres. GET /status's bonusGrantedToday and bonusCap (ticket 05) show the pool-wide total
  against bonus_cap_bps; a grant stuck against the cap logs a warning on the operator and retries next tick rather than
  failing it, so a quiet crank with bonusGrantedToday sitting under bonusCap most of the day is expected, not a bug.
  REFERRAL_QUALIFY_SECONDS (default 604800, 7 days) is how long a referral's Principal has to stay above 50 USDC before it
  counts; shorten it on devnet in .env to see a referral qualify sooner without waiting a week.

    set -a; . ./.env; set +a; pnpm --filter @hexvault/backend admin set-params --epoch-seconds 86400 --round-seconds 30 --close-buffer 12

  Round length: 90s (2026-09-14)

  Every Round costs about five transactions, so round_seconds sets the biggest line on the RPC bill. At 60s the idle backend
  projects to just over a 1M-credit free-tier month, and 30s is worse; at 90s it projects to about 560k. bootstrap now defaults to 90.
  A live Pool keeps its old value until set-params moves it, and the change takes effect on the next Round. 120s roughly halves
  the round-linked cost again if the bill comes in over.

    Pool 7 (dev, .env):     epoch_seconds 86400, round_seconds 30, close_buffer 12. Move to 90: pending.
    Pool 8 (VPS, .env.vps): epoch_seconds 86400, round_seconds 30, close_buffer 12. Move to 90: pending.

    set -a; . ./.env; set +a
    DATABASE_URL=postgresql://x pnpm --filter @hexvault/backend admin set-params --round-seconds 90

  Same again from a fresh shell with .env.vps for Pool 8. Replace "pending" with the signature and slot once each lands.

  The buffer only works once the program that honours it is deployed. Until 2026-09-06 devnet ran the program from before ff22d53,
  whose request_round_randomness required `now >= ends_at`, so every draw request was rejected with RoundNotEnded until the round
  ended and settled 4s to 7s after zero no matter what close_buffer said. The tell in the operator log is a run of
  `skipped: RoundNotEnded` right before each `sent request_round_randomness`; the tell on chain is the AnchorError line number,
  rounds.rs:162, which the current source does not have. The pool also ran at close_buffer 5 while this note said 8; nobody had run
  set-params.

  Tune it with set-params if ORAO's latency changes, no redeploy needed. The program still enforces 0 <= close_buffer < round_seconds.
  set-params also carries --min-jackpot (whole USDC; an epoch closing under it rolls over instead of paying dust) and --payout-timeout
  (seconds a drawn epoch waits for its payout before it may roll over unpaid, above 0), alongside --epoch-seconds, --epoch-anchor, --round-seconds,
  --close-buffer, --vrf-timeout, --min-deposit and --house-cut-bps. Ticket 05 added --base-rate-bps and --bonus-cap-bps (basis points,
  0 to 10000) and --tickets-per-usdc (a positive whole number).
  Run it with the root .env exported first. The CLI reads process.env directly and loads no file of its own, so nothing reaches it
  except what the shell exports. DATABASE_URL is the catch: admin validates the backend's full env but neither .env nor .env.vps sets
  it (compose builds it from the POSTGRES_* keys), so a dummy value has to come along or the command dies on a missing key it never
  uses. (The docker `run --rm backend ... tsx` form in docs/plan does not work: the runtime image has no tsx and no decorator config.)

    set -a; . ./.env; set +a
    DATABASE_URL=postgresql://x pnpm --filter @hexvault/backend admin set-params --close-buffer 15

  House cut: the set-params flag

  --house-cut-bps sets the pool's House cut rate in basis points, a whole number from 0 to
  10000 inclusive (0% to 100%). The default at pool creation is 600, 6%. A change applies to
  the next round settled, never to one already settled.

    set -a; . ./.env; set +a
    DATABASE_URL=postgresql://x pnpm --filter @hexvault/backend admin set-params --house-cut-bps 600

  Epoch anchor: when the draw lands

  epoch_anchor is a unix timestamp on the Pool, and it is a phase reference rather than a start time. Every epoch boundary is a point
  on the grid anchor + k * epoch_seconds, so the draw ends at the same clock time whatever second the pool was bootstrapped and
  however late the operator cranks it. Only where the anchor sits inside one period matters, and it may sit in the future.

  bootstrap and admin set-params both take --epoch-anchor as an ISO 8601 string, and both default to the next Sunday 16:00 UTC at or
  after now. Bootstrap prints the resolved anchor in UTC, in MYT, and as the first three boundaries it produces, so a typo shows up
  before the pool is live instead of a week later. Pass it explicitly whenever you care which instant you get.

    set -a; . ./.env; set +a; pnpm --filter @hexvault/backend admin set-params --epoch-anchor 2026-09-13T16:00:00Z

  Keep Sunday 16:00 UTC. Malaysia is UTC+8 and observes no daylight saving, so 16:00 UTC is 00:00 MYT permanently, no twice-yearly
  shift to chase. That instant is 57600 seconds into the day and 316800 seconds into the week, both whole multiples of an hour, which
  is why the one value sits on all three cadences at once: hourly it is the top of every hour, daily it is 00:00 MYT every day, weekly
  it is 00:00 MYT every Monday. Choose the anchor once and no cadence change ever has to move it.

  Switching cadence is therefore one set-params and no redeploy:

    set -a; . ./.env; set +a; pnpm --filter @hexvault/backend admin set-params --epoch-seconds 604800

  The running epoch keeps its own stored ends_at, so nothing about it changes. The next begin_epoch starts there, which is off the new
  weekly grid, and ends at the first weekly point after it. You get one short transition epoch, then Mondays. Going back to 3600 or
  86400 works the same way.

  Standing up a fresh pool

  `Pool`, `Epoch` and `Player` now carry version and reserved padding (ADR 0013), so a field
  added there no longer forces this: `scripts/deploy.sh dev --upgrade` handles it in place. A
  fresh pool is still how you get a clean slate for a demo, or the rare change that cannot be
  append-only (removed or reordered fields; see docs/ops/environments.md, "When a new program
  ID is warranted"). Two changes forced a fresh pool before ADR 0013 existed: the epoch anchor
  fields and the House cut.

  Both dev and the VPS share one devnet program id today (docs/ops/environments.md), so a
  layout change that still needs a fresh pool breaks both at the same instant; run the whole
  thing back to back, not over two days.

  Pool ids are global rather than per authority: the PDA seed is the id alone, so a VPS pool and
  a dev pool can never share one. 1 through 6 are spent; the next two are 7 and 8.

  Build and deploy first (docs/ops/deploy.md has the full procedure, the rollback dump, and the
  ExtendProgram gotcha):

    scripts/deploy.sh dev

    1. Bootstrap the dev pool. Bump POOL_ID but leave ACCEPTED_MINT alone: bootstrap reuses a mint
       that already exists with 6 decimals and the authority as mint authority, so every wallet
       keeps its faucet balance. Principal does not carry over, because Player is a PDA of the
       pool and every depositor starts at zero.

         sed -i '' 's/^POOL_ID=.*/POOL_ID=7/' .env
         set -a; . ./.env; set +a
         pnpm --filter @hexvault/backend bootstrap \
           --epoch-anchor 2026-09-13T16:00:00Z --epoch-seconds 86400 \
           --round-seconds 30
         DATABASE_URL=postgresql://x pnpm --filter @hexvault/backend admin set-params --close-buffer 12

       bootstrap takes no --close-buffer and no --vrf-timeout: create_pool always gets the
       defaults from src/bootstrap/params.ts (close_buffer 5, vrf_timeout 180, min_deposit 1
       hexUSDC). Only set-params changes them, which is why 12 is a second command. --house-cut-bps 600

       600 bps is the default, so pass the flag only for a different rate. stdout is a pasteable
       KEY=value block and progress goes to stderr, so `bootstrap > pool.env` gives a clean file.
       Paste ACCEPTED_MINT back into .env if the block names a mint you did not already have.

       A new pool starts with the game and the jackpot both paused: deposits work, but the
       operator begins no epoch and opens no round. Pass --start to bootstrap for a dev pool
       that runs at once. Otherwise start each one on purpose, jackpot first so epoch 1 exists
       before the game looks for it:

         pnpm --filter @hexvault/backend admin start-jackpot
         pnpm --filter @hexvault/backend admin start-game

       Both are admin-only, so on mainnet each one is a Squads paste. pause-game and
       pause-jackpot undo them and either key can run them.

    2. Recreate the dev stack. Keep the database volume: every pool-scoped row carries its pool's
       address (ADR 0016), so the retired pool's rows stay beside the new one's as history, and
       Invite codes, Referral codes, Referrals and faucet claims carry over. The indexer starts
       the new pool's cursor empty and walks its history from the first signature.

         docker compose -f docker-compose.dev.yml up -d --build --force-recreate

       The container runs prisma migrate deploy before node starts, which is what adds the new
       columns. Confirm with curl localhost:8080/pool for the new poolId and curl
       localhost:8080/status for rpcOk true and a lastAction a few seconds old.

       `down -v` still works on a laptop when you want an empty database, and it deletes every
       invite and referral with it. Never run it on the VPS or mainnet.

    3. Repoint the dev frontend: VITE_POOL_ID=7 in apps/web/.env, plus VITE_PROGRAM_ID if the
       program id moved. Vite reloads on its own. A stale id reads an account that no longer
       exists and the screen sits empty.

    4. Sparring player, once per pool. Its Principal lived on the old pool, so the deposit has to
       happen again; the script reuses SPARRING_KEYPAIR from .env and only redoes what is missing.

         set -a; . ./.env; set +a; pnpm --filter @hexvault/backend sparring-setup

    5. Now the VPS, which has its own authority, mint and pool. .env.vps is the local mirror of
       the .env that lives on the box, and bootstrap runs from here against it:

         sed -i '' 's/^POOL_ID=.*/POOL_ID=8/' .env.vps
         set -a; . ./.env.vps; set +a
         pnpm --filter @hexvault/backend bootstrap \
           --epoch-anchor 2026-09-13T16:00:00Z --epoch-seconds 86400 \
           --round-seconds 30
         DATABASE_URL=postgresql://x pnpm --filter @hexvault/backend admin set-params --close-buffer 12
         pnpm --filter @hexvault/backend sparring-setup

       Open a new shell first. `set -a` on a second env file does not unset what the first one
       exported, so leftover dev values silently win wherever .env.vps happens to be missing a
       key, and the command runs against the wrong authority.

    6. On the box, set POOL_ID=8 in its .env, then pull and recreate. Compose hardcodes
       env_file: .env, so the file is named .env there whatever it is called in this repo.
       Keep the volume, for the same reason as step 2: the database holds every pool it has
       mirrored, and the invites and referrals in it exist nowhere else.

         sed -i 's/^POOL_ID=.*/POOL_ID=8/' .env
         git pull
         docker compose up -d --build --force-recreate

       Depositors in the retired pool get their Principal back through Shutdown and Emergency
       withdraw on that pool; nothing in this procedure moves it.

    7. Vercel: set VITE_POOL_ID to 8 on the project pointed at api-hexo.elvtd.io and redeploy.
       A Vercel env var only reaches the bundle on the next build, so a redeploy is required.

    8. Smoke it once a round has settled. The authority's Player account is the House:

         curl -s https://api-hexo.elvtd.io/rounds/<id> | jq '{pot, houseCut}'
         curl -s https://api-hexo.elvtd.io/players/<authority> | jq .entries

       houseCut is floor(pot × house_cut_bps ÷ 10000) and the House's entries rise by exactly
       that. A forfeited round reads houseCut 0 with the whole pot going to the House instead.

  The Sparring player

  The Sparring player is a backend-owned wallet that buys one Position in every Round, on all 36 tiles at one Ticket per tile
  (36 Tickets a Round), so a lone human is never playing against an empty board and no pot is forfeited to the House. It looks like any other wallet on screen and competes in the daily
  draw like any Player. It is not the House and never touches the House account.

  SPARRING_KEYPAIR is the base58 secret of that wallet, and SPARRING_ENABLED=true switches the player on. Both are needed: the flag is
  off by default, .env.example documents it as off, and no production env template sets it (ADR 0019). With the flag unset the backend
  boots exactly as before and nobody else is on the board, even when a keypair is still in the file.

  Set one up once per environment with the root .env exported first, the same way admin is run:

    set -a; . ./.env; set +a; pnpm --filter @hexvault/backend sparring-setup

  The script generates a keypair when SPARRING_KEYPAIR is empty and prints the SPARRING_KEYPAIR= line on stdout, so you can append it
  straight to .env. Everything else it prints goes to stderr. It then transfers 0.1 SOL from the authority wallet when the Sparring
  wallet holds under 0.05, mints 1000 hexUSDC to the Sparring wallet with the authority key, and deposits that 1000 as Principal
  signed by the Sparring keypair. The 0.1 SOL covers transaction fees and Position rent for weeks of hourly epochs, and Position rent
  comes back when the operator settles the Position.

  Every step checks the chain before it acts and says what it did or why it skipped, so re-running after a half-finished setup is
  safe. It never deposits a second time: Tickets reset to Principal at every new epoch, so the 1000 keeps funding play forever. Once
  the Principal is in place the script mints nothing either, because the deposit leaves the token account at zero and a balance check
  on its own would mint another 1000 on every run.

  Paste the printed line into .env and restart the backend to pick it up (up -d --force-recreate backend). The wallet is worth
  recording here, since the secret only lives in .env:

    local (pool 1): 8fiH2kWupGjj7MbScxXkbD6aaWpbLkAnvBqt26jc3A8B
    VPS (pools 2 and 3): 2phBznrAD5cHHQ1zq6z3Qf7dmHzrcuYsNtNPL9M8oT4B

  Frontend RPC endpoint and checking for a leaked key

  The browser reads chain data through VITE_PUBLIC_RPC_URL, a public endpoint that Vite inlines into the shipped bundle at build
  time, defaulting to devnet's public cluster URL when unset. Never set this to a keyed URL: whatever the variable holds ships in
  plaintext to every visitor, in the JS bundle and again in the wss:// URL the wallet layer derives from that same string. The
  backend's own RPC endpoint is a separate, server-only variable and never reaches the frontend build. Everything else the browser
  shows comes from the backend API, mostly one poll of GET /state; the wallet's own token balance is the only thing it still reads
  from the chain directly.

  Check a local build for a leaked key with the same scanner the web `check` script runs after every build
  (apps/web/scripts/check-bundle-keys.mjs; production-hardening ticket 07):

    pnpm --filter @hexvault/web build
    node apps/web/scripts/check-bundle-keys.mjs

  It exits 1 and names the file on a hit, and 0 with nothing on stdout past its own "no provider key found" line otherwise.
  Check a deployed site the same way, without a local build, by pulling down what the browser actually
  downloads:

    curl -s https://<deployed-host>/ | grep -oE '/assets/[^"]+\.js'
    curl -s https://<deployed-host><asset-path-from-above> | grep -E "api-key=|helius-rpc.com"

  Mainnet stack

  Mainnet runs as a second compose project on the same box, out of the same checkout and behind the same Traefik. The two stacks
  share nothing but the host: separate project name, separate containers, separate postgres volume and database, separate Traefik
  router, separate Helius key, separate Vercel project. docker-compose.yml is the same file for both, with three variables switching
  it over: COMPOSE_PROJECT_NAME (project, containers, volume), STACK_NAME (Traefik router and service names) and ENV_FILE (the
  environment handed to the backend container). Unset, they fall back to the devnet values, so every existing devnet command keeps
  working unchanged.

  All three live in .env.mainnet, and the command passes that file with --env-file. That flag is what makes them take effect:
  compose interpolates ${...} only from the shell and from the file --env-file names, never from the file in env_file:. Exporting
  the variables in the shell instead looks like it works and is a trap, because interpolation then falls back to .env for everything
  else and API_HOST resolves to the devnet hostname, pointing the mainnet router at the devnet API's host rule.

  Every mainnet compose command needs the same flag, or you are talking to the devnet stack:

    docker compose --env-file .env.mainnet up -d --build
    docker compose --env-file .env.mainnet logs -f backend
    docker compose --env-file .env.mainnet exec postgres psql -U hexvault -d hexvault_mainnet

  Check which stack you are about to hit with `docker compose --env-file .env.mainnet config | head -1`: it prints
  `name: hexvault-mainnet`. Traefik needs no configuration change; it picks the second router up from the container labels
  (hexvault-mainnet-api against the devnet stack's hexvault-api). It does need a DNS A record for API_HOST in place first, or the
  certresolver fails the challenge. Rolling back is `docker compose --env-file .env.mainnet down` on its own; it leaves the devnet
  stack running and the mainnet volume in place unless you add -v.

  The full first-deploy procedure (program, env file, compose, Traefik DNS, the Vercel project's VITE_* values, and the leaked-key
  check above against the mainnet host) is in docs/ops/deploy.md and docs/ops/environments.md; this stack-switching mechanism is the
  part that is easy to get wrong day to day.

  Admin actions through Squads

  How admin-gated commands sign, locally, through a Ledger, or by printing a base58 transaction for a Squads vault to import, is in
  docs/ops/deploy.md ("Admin signing"). The fund commands themselves (fund-jackpot, shutdown, emergency-crank, sweep-house)
  are in docs/ops/funds.md.

  Four more commands cover the rest of the Admin instructions. All four take the same local, Ledger or Squads signing as the others;
  set `ADMIN_ADDRESS` to print the transaction for Squads instead of sending it.

  - Bought tickets pause. Bootstrap sets it on mainnet, and `start-buy-tickets` is the only way to clear it. `pause-buy-tickets` sets
    it again. Both are Admin only.

      pnpm --filter @hexvault/backend admin start-buy-tickets

  - Venue parameters. Send only the flags you want to change; the rest stay as they are. Every value except `--min-venue-move` is
    in basis points, and `--min-venue-move` is raw atomic USDC. The program bounds each field and refuses a value outside its range.

      pnpm --filter @hexvault/backend admin set-venue-params --yield-fee-bps 1000 --idle-target-bps 1000

  - Treasury and Buyback reserve. Both must be token accounts of the pool's mint. `harvest` and `payout` pay to these addresses from
    the next call on.

      pnpm --filter @hexvault/backend admin set-treasury-accounts --treasury <TOKEN_ACCOUNT> --buyback-reserve <TOKEN_ACCOUNT>

  - Cover a deficit. The program does not gate this on the Admin, so any funded key can run it. The signer pays from its own USDC
    token account, and the program moves at most the deficit, so an amount above it is safe. Under a multisig the vault pays.

      pnpm --filter @hexvault/backend admin cover-deficit --amount 5000000

  One gotcha that lives here because it is not really about signing: set-operator rotates `Pool.operator` but leaves the House
  Player's own `owner` on the retired key, so a Prize the House wins still pays into that key's USDC associated token account. Keep
  the old operator's ATA open after every rotation; close it and a House win is unpayable until `payout_timeout` lets the epoch roll
  over.

  The Ops console

  The console is the web app's `/ops` page: http://localhost:5173/ops in dev, and the same path on the deployed site
  (apps/web/vercel.json rewrites it to ops.html, and the page is noindex). It reads `GET /ops/summary` and `GET /alerts`
  every 15 seconds. Connect a wallet to act. Without one the page still reads.

  The banner at the top answers whether anything needs a person.

    green    "Nothing needs you". No alert is firing and no action is due that the bot cannot be trusted with.
    amber    An action is due now, or a lesser alert fires. Each line names the button that clears it. Click the
             name and the page scrolls to the button, opening Advanced if it lives there.
    red      One of nine alerts fires: SOLVENCY_NEGATIVE, POOL_IMPAIRED, WITHDRAW_SHORTFALL, OPERATOR_STALE,
             OPERATOR_FAILING, RPC_DOWN, INDEXER_STALE, DRAWN_UNPAID, EPOCH_NO_PROGRESS.
    grey     A routine crank is due and the Operator will send it on its next tick. It does not count against green.
             Leave it alone. It turns amber once the Operator is stale or failing, or the condition outlasts
             ALERT_TICK_STALE_S.

  The banner takes the colour of its worst line. Every red and amber line links its playbook in docs/ops/incidents.md.
  If the backend could not read the chain, the banner says so in amber, because an empty list would read as green
  when it may only be missing items.

  The badge in the header says what the connected wallet can do on this pool.

    Admin              Signs every action itself, including starting a paused switch.
    Operator           Signs a pause of Pool, Game, Jackpot or Deployment. Cannot pause Bought tickets and cannot
                       start anything.
    Fast pause signer  A wallet on the backend's OPS_WALLETS list (comma separated public keys; empty or unset turns
                       the route off, and the page says "Fast pause is not enabled on this env"). Pauses the same
                       four switches by signing a message. The backend sends the pause with the Operator key.
    Viewer             Any other wallet. It can read everything and run the permissionless actions: the four routine
                       cranks, Fund jackpot, Cover deficit, Void round, Roll over epoch and Migrate, and Drain while a
                       venue proposal is open. The badge reads "Viewer, can run cranks".

  Each switch in the Pause block shows its state and one button, picked from the badge.

    1. Admin: the wallet signs the pause or the start.
    2. Operator: the wallet signs a pause, except Bought tickets.
    3. Fast pause signer: "Fast pause". Pool, Game, Jackpot and Deployment only.
    4. Anyone else: "Prepare for Squads". The page shows a base58 transaction with the Admin as signer, to import
       into Squads.

  Only the Admin restarts. A paused switch shows "Prepare for Squads" to every wallet except the Admin's, and the
  confirm box names the path and says so before anything is signed. Bought tickets has no Fast pause path.

  Under the Pause block sit the routine cranks: Deploy to venue, Recall, Harvest and Process withdraw. A button is lit
  only when the banner says it is due. Every disabled button says why underneath. Details (collapsed) holds the
  Pool, Venue, Yield and Rate chart panels. Advanced (collapsed) holds the rare actions:

    Set params, Set venue params   Admin, as a form that shows each field's change before it is sent. Signs, or
                                   prepares for Squads.
    Grant tickets                  Admin. Signs, or prepares for Squads.
    Fund jackpot                   Any wallet, from its own USDC.
    Cover deficit                  Any funded wallet. Clears Impaired once the deficit reaches zero.
    Void round, Roll over epoch    Permissionless once the program's timeout has passed. The page says "No stuck
                                   Round" or "No stuck epoch" until then.
    Venue switch                   The eight steps of "Changing a pool's venue" above, the current one marked. CLI
                                   steps show their command as text. Drain and Migrate are buttons in the steps.

  The header has two tools for debugging. "Show raw" puts the slot, lamport, basis point or PDA value beside each
  figure that the page shows in plain units, and the browser remembers the setting. "Copy JSON" puts the whole
  `/ops/summary` response on the clipboard, to paste into a chat.

  Eight commands never got a button and stay in the CLI: shutdown, sweep-house, emergency-crank, set-operator,
  propose-admin, accept-admin, set-treasury-accounts and create-invite. The venue switch also starts and cancels in
  the CLI, with propose-venue and cancel-venue. The footer of Advanced's Admin actions panel lists the same eight.

  Withdrawals the crank does not pay

  The operator pays a queued withdrawal on any of the program's three routes: the pool moved past the request's epoch,
  more than `epoch_seconds` passed since the request, or the pool is shut down. So a frozen epoch (jackpot paused, a
  stuck draw) no longer strands requests. While the pool is Impaired the program wants the owner's own signature and
  the operator sends nothing. Those exits stay off the crank, by decision. The owner pays their own withdrawal from
  their wallet, or Impaired clears first (Cover deficit under Advanced). docs/ops/incidents.md, "Venue loss", has the
  playbook. Process withdraw under Routine cranks pays the rest by hand.

  Launch week

  A new pool starts with the game and the jackpot both paused; start each on chain with the admin CLI's `pause-game`,
  `start-game`, `pause-jackpot` and `start-jackpot` (see "Standing up a fresh pool" above for the exact commands and who
  can sign them). `GET /state`'s `pool.gamePaused` and `pool.jackpotPaused` say which switch is on; check there rather
  than assuming a command landed.

  Vercel adds a second, independent cover: `VITE_GATE_GAME` and `VITE_GATE_JACKPOT` on the project's env vars. Set to
  `off`, a gate covers its feature with a same-sized "COMING SOON" card and the chain switch is not consulted. Unset, or
  set to anything else, the feature falls through to the chain switch's own copy: "GAME PAUSED", "STARTS SOON", "DRAW
  PAUSED". Both are Vite build-time variables, so a change only reaches the site on the next build.

  Launching a gated feature: start it on chain, confirm `/state` shows the switch off, then remove the gate on Vercel and
  redeploy. Chain first, so the card never comes off a feature that is still paused underneath; the other order swaps
  "Coming soon" for "Game paused" instead of a live board.

  `LAUNCH_AT` (apps/backend/.env) still holds the Operator's first `begin_epoch` back until that time, but the Game pause
  and Jackpot pause above cover a deposit-only week now; leave it unset.

  Depositors' yield accrues second by second from what the venue pays, with or without an Epoch, so a deposit-only week
  earns it. The prize share reaches the jackpot vault at the operator's pre-end harvest, which only runs while an Epoch is
  running. Nothing needs funding by hand.
