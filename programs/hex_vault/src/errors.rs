use anchor_lang::prelude::*;

#[error_code]
pub enum HexVaultError {
    #[msg("arithmetic overflow")]
    ArithmeticOverflow,

    // Custody
    #[msg("the pool is paused")]
    PoolPaused,
    #[msg("deposit is below the pool minimum")]
    BelowMinimumDeposit,
    #[msg("amount must be greater than zero")]
    ZeroAmount,
    #[msg("principal is lower than the requested amount")]
    InsufficientPrincipal,
    #[msg("token account has the wrong mint")]
    MintMismatch,
    #[msg("parameter is outside its allowed range")]
    InvalidParameter,
    #[msg("the House cannot hold Principal")]
    HouseCannotDeposit,

    // Epochs
    #[msg("the current epoch has not ended yet")]
    EpochNotEnded,
    #[msg("epoch is not drawing")]
    EpochNotDrawing,
    #[msg("epoch has not been drawn")]
    EpochNotDrawn,

    // Randomness
    #[msg("randomness account does not match the request seed")]
    InvalidRandomnessAccount,
    #[msg("randomness is not yet fulfilled")]
    RandomnessNotFulfilled,
    #[msg("randomness sample fell in the rejected tail")]
    RandomnessRejection,
    #[msg("the randomness timeout has not elapsed")]
    VrfTimeoutNotElapsed,

    // Roles. Variants were appended in ticket order; audit-2026-10-09 02 removed the dead
    // ones and renumbered every code after them.
    #[msg("signer is not authorized for this instruction")]
    Unauthorized,
    #[msg("no admin handover is pending")]
    NoPendingAdmin,

    // Epoch-locked withdrawals and deployed principal. Appended too.
    #[msg("the principal vault cannot cover this payout yet")]
    InsufficientVaultLiquidity,
    #[msg("the withdrawal's epoch has not ended yet")]
    WithdrawalNotDue,
    #[msg("no withdrawal is pending for this player")]
    NothingPending,
    #[msg("the pull would leave the vault below its pending withdrawals")]
    BelowPendingWithdrawals,

    // Operator trust guards (ticket 10). Appended too.
    #[msg("randomness for this request has already been fulfilled")]
    RandomnessAlreadyFulfilled,
    #[msg("the accepted mint is not owned by the SPL Token program")]
    UnsupportedMint,
    #[msg("the payout timeout has not elapsed")]
    PayoutTimeoutNotElapsed,

    // Bought tickets (hexo-referrals ticket 03). Appended too.
    #[msg("the House cannot buy tickets")]
    HouseCannotBuyTickets,
    #[msg("this purchase would exceed today's cap of principal")]
    DailyBuyCapExceeded,

    // Shutdown (ops-and-envs ticket 02). Appended too.
    #[msg("the pool is shut down")]
    PoolShutDown,

    // emergency_withdraw (ops-and-envs ticket 03). Appended too.
    #[msg("the pool is not shut down")]
    PoolNotShutDown,
    #[msg("the House exits through sweep_house, not emergency_withdraw")]
    HouseCannotEmergencyWithdraw,
    #[msg("the principal vault cannot cover this payout")]
    InsufficientVault,

    // beta-launch-fixes ticket 03. Appended too.
    #[msg("an earlier epoch has not finished drawing yet")]
    PreviousEpochStillDrawing,
    #[msg("no epoch exists yet")]
    NoEpochYet,

    // Game pause and jackpot pause (game-jackpot-pause ticket 01). Appended too.
    #[msg("the jackpot is paused")]
    JackpotPaused,

    // Venue, sync and deploy (yield-claimer ticket 05). Appended too.
    #[msg("a venue account does not match the address pinned on the pool")]
    VenueMismatch,
    #[msg("the venue cannot return that much right now")]
    VenueIlliquid,
    #[msg("the amount is below the pool's minimum venue move")]
    VenueMoveTooSmall,
    #[msg("the amount is more than the idle USDC above the idle target")]
    DeployExceedsIdle,
    #[msg("deploying to the venue is paused")]
    DeployPaused,
    #[msg("the pool is impaired by a venue loss")]
    PoolImpaired,

    // Recall, harvest and treasury accounts (yield-claimer ticket 07). Appended too.
    #[msg("free idle USDC is already at or above the idle target")]
    RecallNotNeeded,
    #[msg("the amount would lift free idle USDC above the idle target")]
    RecallExceedsTarget,
    #[msg("the venue returned less USDC than was asked for")]
    VenueShortReturn,
    #[msg("no yield fee or prize share is owed")]
    NothingToHarvest,

    // Fenwick draw (yield-claimer ticket 08). Appended too.
    #[msg("the epoch is not readable in the Weight tree any more")]
    EpochNotReadable,
    #[msg("the epoch has not ended, or its draw was already requested")]
    EpochNotAwaitingDraw,

    // klend backing (yield-claimer ticket 12). Appended too.
    #[msg("the klend reserve is still stale after the refresh")]
    ReserveStale,
    #[msg("the reserve account is not a klend Reserve this program can read")]
    ReserveUnreadable,
    #[msg("a klend account does not match the reserve it belongs to")]
    KlendAccountMismatch,

    // Game rules (yield-claimer ticket 11). Appended too.
    #[msg("buying Tickets is paused")]
    BuyTicketsPaused,

    // Venue loss and safety switches (yield-claimer ticket 10). Appended too.
    #[msg("this deploy would take the pool past its share of the reserve's supply")]
    ReserveShareCapExceeded,
    #[msg("this deploy would leave the reserve under its minimum free liquidity")]
    ReserveLiquidityTooLow,
    #[msg("the pool has no venue deficit to cover")]
    NoDeficit,

    // Mainnet review fixes (tickets 02 and 04). Appended too.
    #[msg("the pool is impaired; the player's owner must sign this exit")]
    OwnerSignatureRequired,

    // venue-switch ticket 02. Appended too.
    #[msg("this build does not support that venue kind")]
    UnsupportedVenueKind,

    // venue-switch ticket 03. Appended too.
    #[msg("a venue change is proposed; deploys wait until it is cancelled or executed")]
    VenueProposalOpen,

    // venue-switch ticket 05. Appended too.
    #[msg("the venue proposal's lock has not elapsed")]
    VenueLockNotElapsed,
    #[msg("the old venue still holds more than the minimum venue move; drain it first")]
    VenuePositionNotEmpty,

    // venue-switch ticket 06, the kVault backing. Appended too.
    #[msg("the kVault state account is not a VaultState this program can read")]
    VaultStateUnreadable,
    #[msg("a kVault pin does not match the vault state")]
    VaultPinMismatch,
    #[msg("the kVault does not hold the pool's accepted mint")]
    VaultMintMismatch,
    #[msg("a kVault account does not match the vault state")]
    VaultAccountMismatch,
    #[msg("the kVault state account must be passed writable")]
    VaultStateNotWritable,

    // mainnet-readiness-fixes tickets 04 and 06. Appended too.
    #[msg("a klend venue must pin the klend program")]
    KlendProgramMismatch,
    #[msg("only the program's upgrade authority can create a pool")]
    NotUpgradeAuthority,

    // off-chain-tickets ticket 09, the snapshot commitment and the payout
    // proof. Appended too.
    #[msg("the snapshot is deeper than the program allows")]
    SnapshotDepthTooLarge,
    #[msg("the snapshot's leaf count is zero or more than 2^depth")]
    SnapshotLeafCountInvalid,
    #[msg("the snapshot root is all zeros")]
    SnapshotRootZero,
    #[msg("a leaf with no Tickets cannot win")]
    ZeroTicketLeaf,
    #[msg("the proof does not have one sibling per level")]
    ProofWrongLength,
    #[msg("the leaf index is past the snapshot's leaf count")]
    ProofIndexOutOfRange,
    #[msg("the proof does not reach the committed root")]
    ProofRootMismatch,
    #[msg("the proof's sums do not reach the committed Ticket total")]
    ProofSumMismatch,
    #[msg("the drawn target is outside the leaf's range")]
    ProofRangeMismatch,

    // audit-2026-10-09 ticket 01. Appended too.
    #[msg("the harvest needs a venue redeem under the pool's minimum venue move")]
    HarvestBelowMinimum,
}
