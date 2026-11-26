/**
 * The card-data backend every tool talks to. Callers express searches as
 * pokemontcg.io-style Lucene `q` strings (see qbuilder.ts) and receive cards
 * in the pokemontcg.io `Card` shape (types.ts). Two implementations exist:
 *
 * - TcgdexClient (default): free, keyless TCGdex API. Queries are evaluated
 *   locally (lucene.ts) over a card index loaded from TCGdex on demand.
 * - TcgIoClient (legacy): the pokemontcg.io v2 API, which its owners are
 *   retiring in favour of the paid Scrydex API. Select with
 *   CARD_SOURCE=pokemontcgio while it still answers.
 */
import type { Card, SetInfo } from "./types.js";

export interface SearchResult {
  cards: Card[];
  totalCount: number;
  /** Page size used — if totalCount exceeds it, results were truncated. */
  pageSize: number;
}

export interface SearchOptions {
  pageSize?: number;
  /** Comma-separated fields, `-` prefix for descending, e.g. "-set.releaseDate". */
  orderBy?: string;
  page?: number;
}

export interface CardSource {
  /** Human-readable name of the backend, used in tool output. */
  readonly label: string;
  searchCards(q: string, opts?: SearchOptions): Promise<SearchResult>;
  /** Fetch a single card by this source's id. Returns null when unknown. */
  getCardById(id: string): Promise<Card | null>;
  getAllSets(): Promise<SetInfo[]>;
}
