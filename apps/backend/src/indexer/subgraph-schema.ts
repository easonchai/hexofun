// Solami ticket 05: lists the live subgraph's query root fields and their
// arguments, so the dialect in subgraph.ts's constant block can be checked in
// one command. Reads SUBGRAPH_URL and SUBGRAPH_API_KEY from the shell and
// never prints the key:
//   set -a; . ./.env.solami; set +a
//   SUBGRAPH_URL=https://api.solami.dev/index/hexo/graphql SUBGRAPH_API_KEY="$SOLAMI_API_KEY" \
//     pnpm --filter @hexvault/backend subgraph:schema
import { DEFAULT_RPC_TIMEOUT_MS } from "../config/env";
import { SCHEMA_QUERY, SubgraphClient } from "./subgraph";

async function main(): Promise<void> {
  const url = process.env.SUBGRAPH_URL;
  const apiKey = process.env.SUBGRAPH_API_KEY;
  if (!url || !apiKey) throw new Error("set SUBGRAPH_URL and SUBGRAPH_API_KEY");
  const data = await new SubgraphClient(url, apiKey, DEFAULT_RPC_TIMEOUT_MS).query(SCHEMA_QUERY);
  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
}

main().catch((error: unknown) => {
  // The client has already scrubbed the URL and key from its errors.
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
