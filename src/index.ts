#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import type { CardSource } from "./cardsource.js";
import { VERSION, cardCacheDir, cardSourceName, pokemonTcgApiKey } from "./config.js";
import { registerPrompts } from "./prompts.js";
import { SetResolver } from "./sets.js";
import { FsStorage, sessionsDir } from "./storage.js";
import { TcgdexClient } from "./tcgdex.js";
import { TcgIoClient } from "./tcgio.js";
import { registerTools } from "./tools.js";
import { registerBuildTools } from "./tools-build.js";
import { registerCollectionTools } from "./tools-collection.js";
import { registerScanTools } from "./tools-scan.js";
import { registerSessionTools } from "./tools-session.js";

async function main(): Promise<void> {
  const api: CardSource = cardSourceName() === "pokemontcgio" ? new TcgIoClient() : new TcgdexClient();
  const resolver = new SetResolver(api);
  const storage = new FsStorage(sessionsDir());

  const server = new McpServer({ name: "pokemon-tcg", version: VERSION });
  registerTools(server, api, resolver);
  registerCollectionTools(server, api, resolver);
  registerBuildTools(server, api, resolver);
  registerScanTools(server, api, resolver);
  registerSessionTools(server, storage);
  registerPrompts(server);

  // Warm the set-code mapping in the background; tools retry on demand if it fails.
  resolver.mapping().then(
    (m) => console.error(`[pokemon-tcg-mcp] set mapping ready (${m.size} PTCGO/Live codes)`),
    (err) => console.error(`[pokemon-tcg-mcp] set mapping warm-up failed (will retry on demand): ${err.message}`),
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  const detail =
    api instanceof TcgIoClient
      ? pokemonTcgApiKey()
        ? "pokemontcg.io, API key set"
        : "pokemontcg.io, no POKEMONTCG_API_KEY — lower rate limits"
      : `TCGdex, cache ${cardCacheDir() ?? "memory only"}`;
  console.error(`[pokemon-tcg-mcp] v${VERSION} ready on stdio (card data: ${detail})`);
}

main().catch((err) => {
  console.error(`[pokemon-tcg-mcp] fatal: ${err instanceof Error ? err.stack : err}`);
  process.exit(1);
});
