/** The only place a point value lives. An award stores the value at write
 *  time, so a change applies to new awards. `referral` goes to the
 *  referrer, `referred` to the invitee, `early` to signups from before Privy
 *  sign-in (scripts/award-early.js). */
export const POINTS = { x_connect: 10, referred: 10, referral: 40, early: 5 };

/** `check`: `oauth` is granted by its own flow, `honor` and `form` by the
 *  claim route. Honor quests need X connected. A `proof` quest's claim carries the link to
 *  the member's post, stored on the award row for a manual check. A `form`
 *  quest's claim carries `answers`, checked against `ABOUT` and stored on the
 *  award row. A member is verified once they have X and
 *  the follow quest; the referral payout reads `FOLLOW`. */
export const FOLLOW = "x_follow";
export const LIKE_REPOST = "x_like_repost";
export const ABOUT_YOU = "about_you";

/** The "Tell us about you" form. It rides on the quest as `form`, so the
 *  page renders the options and limit the claim route checks. */
export const ABOUT = {
  experience: ["< 1 Year", "1-3 Years", "3-5 Years", "> 5 Years"],
  maxLength: 150,
};

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
  { id: ABOUT_YOU, title: "Tell us about you", points: 5, check: "form", form: ABOUT },
];
