// Local relay between Surfpool and its mainnet datasource, started by
// `scripts/surf.sh up`. Surfpool 1.6.0 freezes for 30s on a sendTransaction
// whose account fetch picks a pooled datasource connection owned by the HTTP
// worker that sendTransaction is blocking, so the request is never written
// (solana-foundation/surfpool#847, fixed by PR #849). Answering every request
// with `Connection: close` keeps Surfpool's pool empty, so each fetch opens a
// fresh connection on the thread doing it. Drop this relay once Surfpool ships
// #849. Upstream it also opens a fresh connection per request, gives up after
// 8s and retries once, and it keeps the keyed URL out of Surfpool's logs.
//
//   node tests/fork/relay.mjs <port>     upstream from HEXVAULT_FORK_DATASOURCE
//
// Everything Surfpool forwards is a read (account fetches, getProgramAccounts),
// so a retry is safe.

import http from "node:http";
import https from "node:https";

const TIMEOUT_MS = 8000;

const port = Number(process.argv[2]);
const source = process.env.HEXVAULT_FORK_DATASOURCE;
if (!Number.isInteger(port) || !source) {
  console.error("usage: HEXVAULT_FORK_DATASOURCE=<url> node tests/fork/relay.mjs <port>");
  process.exit(1);
}
const upstream = new URL(source);
const client = upstream.protocol === "https:" ? https : http;

/** One attempt on a new connection (agent: false), body read in full. */
function forward(body) {
  return new Promise((resolve, reject) => {
    const req = client.request(
      upstream,
      {
        method: "POST",
        agent: false,
        headers: { "content-type": "application/json", "content-length": body.length },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode, type: res.headers["content-type"], body: Buffer.concat(chunks) }),
        );
        res.on("error", reject);
        // A no-op once "end" has resolved.
        res.on("close", () => reject(new Error("upstream closed mid-response")));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

const retryable = (status) => status === 429 || status >= 500;

async function relay(body, label) {
  for (let attempt = 1; ; attempt++) {
    try {
      const out = await forward(body);
      if (attempt === 1 && retryable(out.status)) {
        console.error(`relay: ${label} got HTTP ${out.status}, retrying`);
        continue;
      }
      return out;
    } catch (err) {
      // err.code / err.name only: no message, which could carry the URL.
      const reason = err.code ?? err.name;
      if (attempt === 1) {
        console.error(`relay: ${label} failed (${reason}), retrying`);
        continue;
      }
      console.error(`relay: ${label} failed again (${reason})`);
      return { status: 502, type: "text/plain", body: Buffer.from(`relay: upstream ${reason}`) };
    }
  }
}

function methodOf(body) {
  try {
    const rpc = JSON.parse(body);
    return Array.isArray(rpc) ? `batch of ${rpc.length}` : String(rpc.method);
  } catch {
    return "unparsable request";
  }
}

const server = http.createServer((req, res) => {
  // surf.sh probes with a GET to see the relay is up.
  if (req.method !== "POST") {
    res.writeHead(405).end();
    return;
  }
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", async () => {
    const body = Buffer.concat(chunks);
    const out = await relay(body, methodOf(body));
    // Never let Surfpool pool this connection: see the header.
    res.writeHead(out.status, { "content-type": out.type ?? "application/json", connection: "close" }).end(out.body);
  });
});
server.listen(port, "127.0.0.1", () => console.error(`relay: 127.0.0.1:${port} -> ${upstream.host}`));
