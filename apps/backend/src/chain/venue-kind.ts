// `Pool.venue_kind` (programs/hex_vault/src/constants.rs `venue_kind`): which
// backing the four pinned venue keys point at. 2 is reserved for the kVault
// backing (venue-switch ticket 06).
export const VENUE_KIND = { klend: 0, stub: 1 } as const;
export type VenueKindName = keyof typeof VENUE_KIND;

/** `constants::VENUE_LOCK_SECONDS`: how long a venue proposal stands before the
 *  migration may run. A program constant, so the API mirrors it, not reads it. */
export const VENUE_LOCK_SECONDS = 48n * 60n * 60n;
