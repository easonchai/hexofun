// `Pool.venue_kind` (programs/hex_vault/src/constants.rs `venue_kind`): which
// backing the four pinned venue keys point at, and so what each of them means.
//
//   kind    klendProgram   klendMarket    klendReserve   klendCtoken
//   klend   klend program  lending market the reserve    the pool's cToken account
//   stub    hex_vault      the pool PDA   stub reserve   stub vault (localnet only)
//   kvault  kVault program vault state    shares mint    the pool's shares account
//
// The field names are the ones on chain and in the IDL; renaming them would
// break every client.
export const VENUE_KIND = { klend: 0, stub: 1, kvault: 2 } as const;
export type VenueKindName = keyof typeof VENUE_KIND;
