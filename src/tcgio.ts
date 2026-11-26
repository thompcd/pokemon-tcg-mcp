import { TtlLruCache } from "./cache.js";
import { CARD_TTL_MS, TCGIO_API_BASE, pokemonTcgApiKey } from "./config.js";
import { HttpError, httpGetJson } from "./http.js";
import type { CardSource, SearchOptions, SearchResult } from "./cardsource.js";
import type { Card, SetInfo } from "./types.js";

export type { SearchResult } from "./cardsource.js";

interface ListResponse<T> {
  data?: T[];
  totalCount?: number;
}

/** Fields that keep search payloads small but still let us format results fully. */
export const CARD_SELECT = [
  "id", "name", "supertype", "subtypes", "hp", "types", "evolvesFrom",
  "abilities", "attacks", "weaknesses", "resistances", "retreatCost", "rules",
  "regulationMark", "number", "rarity", "set", "legalities", "images",
  "tcgplayer", "cardmarket",
].join(",");

/**
 * Legacy pokemontcg.io v2 backend. pokemontcg.io is being retired in favour of
 * the paid Scrydex API; kept behind CARD_SOURCE=pokemontcgio while it answers.
 */
export class TcgIoClient implements CardSource {
  readonly label = "pokemontcg.io";
  private cache = new TtlLruCache(400);
  private apiKey = pokemonTcgApiKey();

  private headers(): Record<string, string> {
    return this.apiKey ? { "X-Api-Key": this.apiKey } : {};
  }

  async searchCards(
    q: string,
    opts: SearchOptions = {},
  ): Promise<SearchResult> {
    const pageSize = opts.pageSize ?? 250;
    const params = new URLSearchParams({ q, pageSize: String(pageSize), select: CARD_SELECT });
    if (opts.orderBy) params.set("orderBy", opts.orderBy);
    if (opts.page) params.set("page", String(opts.page));
    const url = `${TCGIO_API_BASE}/cards?${params.toString()}`;
    return this.cache.getOrLoad(url, CARD_TTL_MS, async () => {
      const body = await httpGetJson<ListResponse<Card>>(url, this.headers());
      return { cards: body.data ?? [], totalCount: body.totalCount ?? body.data?.length ?? 0, pageSize };
    });
  }

  /** Fetch a single card by pokemontcg.io id. Returns null on 404. */
  async getCardById(id: string): Promise<Card | null> {
    const url = `${TCGIO_API_BASE}/cards/${encodeURIComponent(id)}`;
    return this.cache.getOrLoad(url, CARD_TTL_MS, async () => {
      try {
        const body = await httpGetJson<{ data?: Card }>(url, this.headers());
        return body.data ?? null;
      } catch (err) {
        if (err instanceof HttpError && err.status === 404) return null;
        throw err;
      }
    });
  }

  /** All sets, paginated defensively (currently a single page of ~175). */
  async getAllSets(): Promise<SetInfo[]> {
    return this.cache.getOrLoad("sets:all", CARD_TTL_MS, async () => {
      const sets: SetInfo[] = [];
      for (let page = 1; page <= 5; page++) {
        const params = new URLSearchParams({
          page: String(page),
          pageSize: "250",
          select: "id,name,series,ptcgoCode,releaseDate,total,printedTotal",
        });
        const body = await httpGetJson<ListResponse<SetInfo>>(
          `${TCGIO_API_BASE}/sets?${params.toString()}`,
          this.headers(),
        );
        const batch = body.data ?? [];
        sets.push(...batch);
        if (batch.length < 250) break;
      }
      return sets;
    });
  }
}
