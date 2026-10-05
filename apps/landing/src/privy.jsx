// Privy for a page without React. Bundled by build.js into /privy/, which the
// page imports lazily: `const { login, logout } = await import("/privy/privy.js")`.
// The app id is the apps/web one, inlined at build time from PRIVY_APP_ID.
import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { getIdentityToken, PrivyProvider, useLogin, usePrivy } from "@privy-io/react-auth";

const METHODS = ["email", "google"];

let ready;
const privy = new Promise((resolve) => (ready = resolve));
// The latest render's Privy state, read at call time rather than captured.
const live = {};
// [resolve, reject] for the login in flight.
let pending = null;
// Google login leaves the page and comes back, so no login() call is waiting
// by then. That sign-in, or a Privy session the page has no cookie for, goes
// to the onSignIn handler instead, held here until the page sets one.
let onSignIn = null;
let unclaimed = null;

async function token() {
  const t = await getIdentityToken();
  // Null means identity tokens are off in the Privy dashboard.
  if (!t) throw new Error("Privy returned no identity token");
  return t;
}

function Bridge() {
  const { ready: privyReady, authenticated, logout } = usePrivy();
  const { login } = useLogin({
    onError: (code) => {
      pending?.[1](Object.assign(new Error(`Privy login: ${code}`), { code }));
      pending = null;
    },
  });
  Object.assign(live, { authenticated, login, logout });
  if (privyReady) ready();

  // One place for every way of becoming authenticated: the modal, a return
  // from Google, or a session from an earlier visit.
  useEffect(() => {
    if (!authenticated) return;
    const t = token();
    if (pending) {
      t.then(...pending);
      pending = null;
    } else if (onSignIn) {
      onSignIn(t);
    } else {
      unclaimed = t;
    }
  }, [authenticated]);
  return null;
}

const el = document.createElement("div");
document.body.appendChild(el);
createRoot(el).render(
  <PrivyProvider
    appId={PRIVY_APP_ID}
    config={{
      loginMethods: METHODS,
      appearance: { theme: "#0E1B2B", accentColor: "#B6FF3B", walletChainType: "solana-only" },
      embeddedWallets: {
        showWalletUIs: false,
        solana: { createOnLogin: "users-without-wallets" },
      },
    }}
  >
    <Bridge />
  </PrivyProvider>,
);

/** Resolves with a Privy identity token, opening the login modal if needed. */
export const login = () =>
  privy.then(() =>
    // A Privy session from an earlier visit skips the modal.
    live.authenticated
      ? token()
      : new Promise((resolve, reject) => {
          pending = [resolve, reject];
          live.login({ loginMethods: METHODS });
        }),
  );

/** `fn(tokenPromise)` runs for a sign-in nobody called login() for. */
export function signedIn(fn) {
  onSignIn = fn;
  if (unclaimed) fn(unclaimed);
  unclaimed = null;
}

export const logout = () => privy.then(() => live.logout());
