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
    #[msg("entries are lower than the requested amount")]
    InsufficientEntries,
    #[msg("token account has the wrong mint")]
    MintMismatch,
    #[msg("token account is not owned by the pool authority")]
    NotAuthorityOwned,
    #[msg("parameter is outside its allowed range")]
    InvalidParameter,
    #[msg("the House cannot hold Principal")]
    HouseCannotDeposit,

    // Rounds
    #[msg("a round is already open for this pool")]
    RoundAlreadyOpen,
    #[msg("round is not open")]
    RoundNotOpen,
    #[msg("round is closed to new positions")]
    RoundClosed,
    #[msg("round has not ended yet")]
    RoundNotEnded,
    #[msg("round randomness has not been requested")]
    RoundNotRequested,
    #[msg("round is not settled")]
    RoundNotSettled,
    #[msg("round would end after the current epoch")]
    RoundOutsideEpoch,
    #[msg("round length does not match the pool's round_seconds")]
    InvalidRoundLength,
    #[msg("tile selection must be a non-empty mask over tiles 0..35")]
    InvalidTileSelection,
    #[msg("stake per tile must be at least one entry")]
    InvalidStake,

    // Epochs
    #[msg("the current epoch has not ended yet")]
    EpochNotEnded,
    #[msg("epoch is not accepting registrations")]
    EpochNotRegistering,
    #[msg("epoch is not drawing")]
    EpochNotDrawing,
    #[msg("epoch has not been drawn")]
    EpochNotDrawn,
    #[msg("only the epoch immediately before the current one may be registered")]
    NotPreviousEpoch,
    #[msg("player is already registered for this epoch")]
    AlreadyRegistered,
    #[msg("player's frozen weight belongs to a different epoch")]
    FrozenEpochMismatch,
    #[msg("player is not registered for this epoch")]
    NotRegistered,
    #[msg("the drawn target is outside this player's registered interval")]
    NotTheWinner,
    #[msg("no weight was registered for this epoch")]
    NothingRegistered,

    // Randomness
    #[msg("randomness account does not match the request seed")]
    InvalidRandomnessAccount,
    #[msg("randomness is not yet fulfilled")]
    RandomnessNotFulfilled,
    #[msg("randomness sample fell in the rejected tail")]
    RandomnessRejection,
    #[msg("the randomness timeout has not elapsed")]
    VrfTimeoutNotElapsed,

    // Roles. Appended, never inserted: every variant above keeps its code.
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
    #[msg("destination is not the admin's associated token account")]
    InvalidAdminTokenAccount,

    // Operator trust guards (ticket 10). Appended too.
    #[msg("randomness for this request has already been fulfilled")]
    RandomnessAlreadyFulfilled,
    #[msg("the registration window has not closed yet")]
    RegistrationWindowOpen,
    #[msg("the House cannot buy a position")]
    HouseCannotPlay,
    #[msg("the accepted mint is not owned by the SPL Token program")]
    UnsupportedMint,
    #[msg("the payout timeout has not elapsed")]
    PayoutTimeoutNotElapsed,

    // Bought tickets (hexo-referrals ticket 03). Appended too.
    #[msg("the House cannot buy tickets")]
    HouseCannotBuyTickets,
    #[msg("this purchase would exceed today's cap of principal")]
    DailyBuyCapExceeded,

    // Granted tickets (hexo-referrals ticket 04). Appended too.
    #[msg("the House cannot receive an operator grant")]
    HouseCannotBeGranted,
    #[msg("this grant would exceed the player's daily cap of principal")]
    DailyPlayerGrantCapExceeded,
    #[msg("this grant would exceed the pool's daily bonus cap")]
    DailyPoolGrantCapExceeded,

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

    // close_round (ops-and-envs ticket 05). Appended too.
    #[msg("the round still has unsettled positions")]
    RoundHasOpenPositions,

    // beta-launch-fixes ticket 03. Appended too.
    #[msg("an earlier epoch has not finished drawing yet")]
    PreviousEpochStillDrawing,
    #[msg("no epoch exists yet")]
    NoEpochYet,

    // Game pause and jackpot pause (game-jackpot-pause ticket 01). Appended too.
    #[msg("the game is paused")]
    GamePaused,
    #[msg("the jackpot is paused")]
    JackpotPaused,

    // Layout rewrite (yield-claimer ticket 04). Appended too.
    #[msg("payout is disabled until the Weight tree draw lands (yield-claimer ticket 08)")]
    DrawPendingWeightTree,
}
