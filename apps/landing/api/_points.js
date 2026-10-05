/** The only place a point value lives. An award stores the value at write
 *  time, so a change applies to new awards. `referral` goes to the
 *  referrer, `referred` to the invitee. */
export const POINTS = { x_connect: 10, referred: 10, referral: 40 };

/** `check`: `oauth` is granted by its own flow, `honor` by the claim route.
 *  Honor quests need X connected. A `proof` quest's claim carries the link to
 *  the member's post, stored on the award row for a manual check. A member is verified once they have X and
 *  the follow quest; the referral payout reads `FOLLOW`. */
export const FOLLOW = "x_follow";
export const LIKE_REPOST = "x_like_repost";

export const QUESTS = [
  { id: "x_connect", title: "Connect X", url: "/api/x/start", points: POINTS.x_connect, check: "oauth" },
  { id: FOLLOW, title: "Follow @Hexofun on X", url: "https://x.com/Hexofun", points: 10, check: "honor" },
  {
    id: LIKE_REPOST,
    title: "Like + QRT the waitlist post",
    url: "https://x.com/Hexofun/status/2104929707770921450",
    points: 20,
    check: "honor",
    proof: true,
  },
];
