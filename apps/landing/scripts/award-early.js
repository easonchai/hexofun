// One-off: bonus points for every waitlist row from before Privy sign-in went
// live on prod (PR #23, merged 2026-10-05 10:14:35 +0800). A row with no
// privy_did can only have come from the old email form, which covers signups
// made while that deploy was still building. Every row ranks, so an award
// shows on the board straight away, signed in or not.
// Safe to rerun: the unique key on (waitlist_id, kind, ref) drops repeats.
//
//   DATABASE_URL=... node scripts/award-early.js           # counts only
//   DATABASE_URL=... node scripts/award-early.js --apply
import { sql } from "../api/_lib.js";
import { POINTS } from "../api/_points.js";

const CUTOFF = "2026-10-05T02:14:35Z";

const [counts] = await sql`
  select
    count(*)::int as eligible,
    (count(*) filter (where w.privy_did is not null))::int as signed_in,
    count(p.id)::int as already_awarded
  from waitlist w
  left join waitlist_points p on p.waitlist_id = w.id and p.kind = 'early'
  where w.created_at < ${CUTOFF}::timestamptz or w.privy_did is null
`;
console.log(counts);

if (process.argv.includes("--apply")) {
  const rows = await sql`
    insert into waitlist_points (waitlist_id, kind, ref, points)
    select id, 'early', '', ${POINTS.early}::int from waitlist
    where created_at < ${CUTOFF}::timestamptz or privy_did is null
    on conflict (waitlist_id, kind, ref) do nothing
    returning id
  `;
  console.log(`awarded ${rows.length} rows`);
} else {
  console.log("dry run, pass --apply to write");
}
