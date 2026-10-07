// `Pool.venue_kind` (programs/hex_vault/src/constants.rs `venue_kind`): which
// backing the four pinned venue keys point at. 2 is reserved for the kVault
// backing (venue-switch ticket 06).
export const VENUE_KIND = { klend: 0, stub: 1 } as const;
export type VenueKindName = keyof typeof VENUE_KIND;
