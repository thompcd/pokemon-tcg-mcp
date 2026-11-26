import os from "node:os";
import path from "node:path";

export const VERSION = "0.2.0";

export const USER_AGENT = `pokemon-tcg-mcp/${VERSION} (local MCP server; personal use)`;

export const TCGIO_API_BASE = "https://api.pokemontcg.io/v2";
export const TCGDEX_API_BASE = process.env.TCGDEX_API_BASE?.trim() || "https://api.tcgdex.net/v2/en";
export const LIMITLESS_BASE = "https://limitlesstcg.com";

export const REQUEST_TIMEOUT_MS = 10_000;

/** Cards and sets change rarely — cache for a day. */
export const CARD_TTL_MS = 24 * 60 * 60 * 1000;
/** Set listings (which cards a set holds) almost never change once released. */
export const SET_DETAIL_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Meta / deck data moves fast — cache for an hour. */
export const META_TTL_MS = 60 * 60 * 1000;

export function pokemonTcgApiKey(): string | undefined {
  const key = process.env.POKEMONTCG_API_KEY?.trim();
  return key ? key : undefined;
}

export type CardSourceName = "tcgdex" | "pokemontcgio";

/** CARD_SOURCE=tcgdex (default) or pokemontcgio (legacy, being retired). */
export function cardSourceName(): CardSourceName {
  const raw = process.env.CARD_SOURCE?.trim().toLowerCase();
  if (raw === "pokemontcgio" || raw === "pokemontcg.io" || raw === "tcgio") return "pokemontcgio";
  return "tcgdex";
}

/**
 * Where fetched card data is cached between runs. CARD_CACHE_DIR overrides;
 * "off" disables the disk cache (memory cache only).
 */
export function cardCacheDir(): string | null {
  const raw = process.env.CARD_CACHE_DIR?.trim();
  if (raw && raw.toLowerCase() === "off") return null;
  if (raw) return path.resolve(raw);
  return path.join(os.homedir(), ".cache", "pokemon-tcg-mcp");
}
