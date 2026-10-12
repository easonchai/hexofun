// A Privy session stored by another app id (the app switch to cmtl…) makes the
// SDK call logout on every token read, and the server 400s each one because the
// refresh token isn't ours. Dropping that session before Privy mounts ends the loop.
// Key and cookie names are @privy-io/react-auth 3.39.0's.
const TOKEN_KEYS = ["privy:token", "privy:pat"];
const KEYS = [...TOKEN_KEYS, "privy:refresh_token", "privy:id_token"];
export const COOKIES = ["privy-token", "privy-session", "privy-id-token"];

/** The app id inside a stored Privy JWT (a JSON string), or null if unreadable. */
function appIdOf(raw) {
  try {
    const body = JSON.parse(raw).split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const claims = JSON.parse(atob(body));
    return claims.aid ?? claims.aud ?? null;
  } catch {
    return null;
  }
}

/** Removes Privy's stored session when it belongs to another app id. True if it did. */
export function dropForeignSession(storage, appId) {
  const foreign = TOKEN_KEYS.some((k) => {
    const raw = storage.getItem(k);
    return raw !== null && appIdOf(raw) !== appId;
  });
  if (foreign) KEYS.forEach((k) => storage.removeItem(k));
  return foreign;
}
