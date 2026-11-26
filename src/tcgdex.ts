/**
 * Card source backed by the free, keyless TCGdex REST API
 * (https://api.tcgdex.net/v2/en). TCGdex's own filters can't express the
 * rules-text and boolean queries the tools need, and its list endpoint only
 * returns card briefs, so this client:
 *
 * 1. works out which slice of the data a query needs (lucene.ts scopeOf):
 *    specific ids, specific sets, a name search, or else the standard pool
 *    (every set released inside the current regulation-mark window);
 * 2. loads that slice — set listings and full card documents — through an
 *    in-memory cache backed by a disk cache (CARD_CACHE_DIR), so the first
 *    standard-pool query is slow and later ones are local;
 * 3. maps each TCGdex card into the pokemontcg.io `Card` shape the rest of the
 *    server was written against, and evaluates the Lucene query locally.
 *
 * Card ids are TCGdex ids ("sv01-001"), not pokemontcg.io ids ("sv1-1").
 */
import { TtlLruCache } from "./cache.js";
import type { CardSource, SearchOptions, SearchResult } from "./cardsource.js";
import { CARD_TTL_MS, SET_DETAIL_TTL_MS, TCGDEX_API_BASE, cardCacheDir } from "./config.js";
import { DiskCache } from "./diskcache.js";
import { HttpError, httpGetJson } from "./http.js";
import { currentLegalMarks, yearOfMark } from "./legality.js";
import { LuceneSyntaxError, matches, parse, scopeOf, sortBy, type Scope } from "./lucene.js";
import type { Card, SetInfo, TcgPlayerPriceBlock } from "./types.js";

// ---------------------------------------------------------------- TCGdex shapes

export interface TcgdexCardBrief {
  id: string;
  localId: string | number;
  name: string;
  image?: string;
}

export interface TcgdexSetBrief {
  id: string;
  name: string;
  logo?: string;
  symbol?: string;
  cardCount?: { total?: number; official?: number };
}

export interface TcgdexSet extends TcgdexSetBrief {
  serie?: { id: string; name: string };
  tcgOnline?: string | null;
  releaseDate?: string;
  legal?: { standard?: boolean; expanded?: boolean };
  cards?: TcgdexCardBrief[];
}

interface TcgdexPriceVariant {
  lowPrice?: number;
  midPrice?: number;
  highPrice?: number;
  marketPrice?: number;
  directLowPrice?: number;
}

export interface TcgdexCard {
  id: string;
  localId: string | number;
  name: string;
  image?: string;
  category: string;
  illustrator?: string;
  rarity?: string;
  set: TcgdexSetBrief;
  hp?: number;
  types?: string[];
  evolveFrom?: string;
  stage?: string;
  suffix?: string;
  abilities?: { type?: string; name: string; effect: string }[];
  attacks?: { cost?: string[]; name: string; effect?: string; damage?: number | string }[];
  weaknesses?: { type: string; value?: string }[];
  resistances?: { type: string; value?: string }[];
  retreat?: number;
  effect?: string;
  trainerType?: string;
  energyType?: string;
  regulationMark?: string;
  legal?: { standard?: boolean; expanded?: boolean };
  pricing?: {
    tcgplayer?: { updated?: string | number; unit?: string } & Record<string, unknown>;
    cardmarket?: { updated?: string | number; unit?: string } & Record<string, unknown>;
  };
}

// ---------------------------------------------------------------- mapping

const EX_RULE = "Pokémon ex rule: When your Pokémon ex is Knocked Out, your opponent takes 2 Prize cards.";
const MEGA_EX_RULE =
  "Mega Evolution ex rule: When your Mega Evolution Pokémon ex is Knocked Out, your opponent takes 3 Prize cards.";

/** "2023-03-31" → "2023/03/31", the format the tools (and pokemontcg.io) use. */
export function toSlashDate(date: string | undefined): string | undefined {
  return date ? date.replace(/-/g, "/") : undefined;
}

/** Numbers as pokemontcg.io stores them: purely numeric ids lose leading zeros ("029" → "29"). */
export function cardNumber(localId: string | number): string {
  const s = String(localId);
  return /^\d+$/.test(s) ? String(Number(s)) : s;
}

export function mapSet(set: TcgdexSet): SetInfo {
  return {
    id: set.id,
    name: set.name,
    series: set.serie?.name,
    ptcgoCode: set.tcgOnline ?? undefined,
    releaseDate: toSlashDate(set.releaseDate),
    total: set.cardCount?.total,
    printedTotal: set.cardCount?.official,
  };
}

function pokemonSubtypes(card: TcgdexCard): string[] {
  const out: string[] = [];
  if (card.stage) out.push(card.stage.replace(/^Stage\s?(\d)$/i, "Stage $1"));
  const isMega = /^Mega\s/i.test(card.name);
  if (isMega) out.push("MEGA");
  if (card.suffix) out.push(card.suffix);
  else if (/\sex$/.test(card.name)) out.push("ex");
  else if (/\s(V|VMAX|VSTAR|GX|EX)$/.test(card.name)) out.push(card.name.split(" ").pop()!);
  return [...new Set(out)];
}

function trainerSubtypes(card: TcgdexCard): string[] {
  const out: string[] = [];
  if (card.trainerType) out.push(/^tool$/i.test(card.trainerType) ? "Pokémon Tool" : card.trainerType);
  return out;
}

function isAceSpecCard(card: TcgdexCard): boolean {
  return /ace\s*spec/i.test(card.rarity ?? "");
}

function mapTcgplayer(raw: NonNullable<TcgdexCard["pricing"]>["tcgplayer"]): Card["tcgplayer"] {
  if (!raw) return undefined;
  const prices: Record<string, TcgPlayerPriceBlock> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === "updated" || key === "unit" || !value || typeof value !== "object") continue;
    const v = value as TcgdexPriceVariant;
    // "reverse-holofoil" → "reverseHolofoil", "1st-edition-holofoil" → "1stEditionHolofoil"
    const name = key === "reverse" ? "reverseHolofoil" : key.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
    prices[name] = { low: v.lowPrice, mid: v.midPrice, high: v.highPrice, market: v.marketPrice, directLow: v.directLowPrice };
  }
  if (Object.keys(prices).length === 0) return undefined;
  return { updatedAt: raw.updated === undefined ? undefined : String(raw.updated), prices };
}

function mapCardmarket(raw: NonNullable<TcgdexCard["pricing"]>["cardmarket"]): Card["cardmarket"] {
  if (!raw) return undefined;
  const num = (key: string) => (typeof raw[key] === "number" ? (raw[key] as number) : undefined);
  const prices = {
    trendPrice: num("trend"),
    averageSellPrice: num("avg"),
    lowPrice: num("low"),
    avg1: num("avg1"),
    avg7: num("avg7"),
    avg30: num("avg30"),
    reverseHoloTrend: num("trend-holo"),
    reverseHoloSell: num("avg-holo"),
    reverseHoloLow: num("low-holo"),
    reverseHoloAvg1: num("avg1-holo"),
    reverseHoloAvg7: num("avg7-holo"),
    reverseHoloAvg30: num("avg30-holo"),
  };
  if (Object.values(prices).every((v) => v === undefined)) return undefined;
  return { updatedAt: raw.updated === undefined ? undefined : String(raw.updated), prices };
}

/** TCGdex card → the pokemontcg.io-shaped `Card` every tool expects. */
export function mapCard(card: TcgdexCard, setInfo?: SetInfo): Card {
  const category = card.category?.toLowerCase();
  const supertype = category === "pokemon" ? "Pokémon" : category === "trainer" ? "Trainer" : "Energy";

  let subtypes: string[];
  const rules: string[] = [];
  if (supertype === "Pokémon") {
    subtypes = pokemonSubtypes(card);
    if (subtypes.includes("ex")) rules.push(subtypes.includes("MEGA") ? MEGA_EX_RULE : EX_RULE);
  } else if (supertype === "Trainer") {
    subtypes = trainerSubtypes(card);
    if (card.effect) rules.push(card.effect);
  } else {
    subtypes = card.energyType ? [card.energyType] : [];
    if (card.effect) rules.push(card.effect);
  }
  if (isAceSpecCard(card)) subtypes.push("ACE SPEC");

  const set: SetInfo = setInfo
    ? { ...setInfo }
    : {
        id: card.set.id,
        name: card.set.name,
        total: card.set.cardCount?.total,
        printedTotal: card.set.cardCount?.official,
      };

  const legalities: Record<string, string> = {};
  if (card.legal?.standard) legalities.standard = "Legal";
  if (card.legal?.expanded) legalities.expanded = "Legal";

  return {
    id: card.id,
    name: card.name,
    supertype,
    subtypes,
    hp: card.hp === undefined ? undefined : String(card.hp),
    types: card.types,
    evolvesFrom: card.evolveFrom,
    abilities: card.abilities?.map((a) => ({ name: a.name, text: a.effect, type: a.type })),
    attacks: card.attacks?.map((a) => ({
      name: a.name,
      cost: a.cost ?? [],
      convertedEnergyCost: (a.cost ?? []).length,
      damage: a.damage === undefined || a.damage === "" ? undefined : String(a.damage),
      text: a.effect,
    })),
    weaknesses: card.weaknesses?.map((w) => ({ type: w.type, value: w.value ?? "" })),
    resistances: card.resistances?.map((r) => ({ type: r.type, value: r.value ?? "" })),
    retreatCost: card.retreat ? Array.from({ length: card.retreat }, () => "Colorless") : undefined,
    rules: rules.length > 0 ? rules : undefined,
    regulationMark: card.regulationMark,
    number: cardNumber(card.localId),
    rarity: card.rarity,
    set,
    legalities: Object.keys(legalities).length > 0 ? legalities : undefined,
    images: card.image ? { small: `${card.image}/low.webp`, large: `${card.image}/high.webp` } : undefined,
    tcgplayer: mapTcgplayer(card.pricing?.tcgplayer),
    cardmarket: mapCardmarket(card.pricing?.cardmarket),
  };
}

// ---------------------------------------------------------------- client

export type FetchJson = (url: string) => Promise<unknown>;

export interface TcgdexClientOptions {
  baseUrl?: string;
  /** null disables the disk cache. */
  cacheDir?: string | null;
  fetchJson?: FetchJson;
  /** Parallel card-detail requests. */
  concurrency?: number;
  /** Max cards fetched in full for one name search (newest sets first). */
  nameFetchCap?: number;
}

const DEFAULT_PAGE_SIZE = 250;

async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

export class TcgdexClient implements CardSource {
  readonly label = "TCGdex";
  private base: string;
  private mem = new TtlLruCache(20_000);
  private disk: DiskCache | null;
  private fetchJson: FetchJson;
  private concurrency: number;
  private nameFetchCap: number;

  constructor(opts: TcgdexClientOptions = {}) {
    this.base = (opts.baseUrl ?? TCGDEX_API_BASE).replace(/\/+$/, "");
    const dir = opts.cacheDir === undefined ? cardCacheDir() : opts.cacheDir;
    this.disk = dir ? new DiskCache(dir) : null;
    this.fetchJson = opts.fetchJson ?? ((url) => httpGetJson<unknown>(url));
    this.concurrency = opts.concurrency ?? 8;
    this.nameFetchCap = opts.nameFetchCap ?? 120;
  }

  /** Memory cache in front of the disk cache in front of the network. */
  private cached<V>(key: string, ttlMs: number, loader: () => Promise<V>): Promise<V> {
    return this.mem.getOrLoad(key, ttlMs, () => (this.disk ? this.disk.getOrLoad(key, ttlMs, loader) : loader()));
  }

  private url(path: string, params?: Record<string, string>): string {
    const qs = params ? `?${new URLSearchParams(params).toString()}` : "";
    return `${this.base}${path}${qs}`;
  }

  // -------------------------------------------------------------- sets

  private setDetail(id: string): Promise<TcgdexSet | null> {
    return this.cached(`tcgdex:set:${id}`, SET_DETAIL_TTL_MS, async () => {
      try {
        return (await this.fetchJson(this.url(`/sets/${encodeURIComponent(id)}`))) as TcgdexSet;
      } catch (err) {
        if (err instanceof HttpError && err.status === 404) return null;
        throw err;
      }
    });
  }

  /** Every set, in full (release date, Live code, card list). */
  private allSetDetails(): Promise<TcgdexSet[]> {
    return this.mem.getOrLoad("tcgdex:sets:details", CARD_TTL_MS, async () => {
      const briefs = await this.cached("tcgdex:sets", CARD_TTL_MS, async () => {
        const body = await this.fetchJson(this.url("/sets"));
        return (Array.isArray(body) ? body : []) as TcgdexSetBrief[];
      });
      const details = await mapLimited(briefs, this.concurrency, (b) => this.setDetail(b.id));
      return details.filter((d): d is TcgdexSet => d !== null);
    });
  }

  async getAllSets(): Promise<SetInfo[]> {
    return (await this.allSetDetails()).map(mapSet);
  }

  private async setInfoById(): Promise<Map<string, SetInfo>> {
    return new Map((await this.getAllSets()).map((s) => [s.id, s]));
  }

  // -------------------------------------------------------------- cards

  private rawCard(id: string): Promise<TcgdexCard | null> {
    return this.cached(`tcgdex:card:${id}`, CARD_TTL_MS, async () => {
      try {
        return (await this.fetchJson(this.url(`/cards/${encodeURIComponent(id)}`))) as TcgdexCard;
      } catch (err) {
        if (err instanceof HttpError && err.status === 404) return null;
        throw err;
      }
    });
  }

  private async cardsById(ids: string[]): Promise<Card[]> {
    const sets = await this.setInfoById();
    const raws = await mapLimited([...new Set(ids)], this.concurrency, (id) => this.rawCard(id));
    return raws.filter((r): r is TcgdexCard => r !== null).map((r) => mapCard(r, sets.get(r.set.id)));
  }

  async getCardById(id: string): Promise<Card | null> {
    const [card] = await this.cardsById([id]);
    return card ?? null;
  }

  private async cardsOfSets(setIds: string[]): Promise<Card[]> {
    const wanted = new Set(setIds.map((s) => s.toLowerCase()));
    const details = await this.allSetDetails();
    const ids = details
      .filter((s) => wanted.has(s.id.toLowerCase()))
      .flatMap((s) => (s.cards ?? []).map((c) => c.id));
    return this.cardsById(ids);
  }

  private async setIdsForCodes(codes: string[]): Promise<string[]> {
    const wanted = new Set(codes.map((c) => c.toUpperCase()));
    return (await this.getAllSets()).filter((s) => s.ptcgoCode && wanted.has(s.ptcgoCode.toUpperCase())).map((s) => s.id);
  }

  /**
   * Name search: TCGdex's default name filter is a case-insensitive
   * "contains", a superset of what the Lucene term means, so we search on the
   * longest literal fragment and let the local evaluator refine. Briefs are
   * ordered newest set first and capped before fetching full documents.
   */
  private async cardsByNames(names: { value: string }[]): Promise<Card[]> {
    const fragments = [
      ...new Set(
        names
          .map((n) => n.value.split("*").sort((a, b) => b.length - a.length)[0]?.trim() ?? "")
          .filter((f) => f.length > 0),
      ),
    ];
    const releaseOf = new Map((await this.allSetDetails()).map((s) => [s.id, s.releaseDate ?? ""]));
    const briefLists = await mapLimited(fragments, 4, (fragment) =>
      this.cached(`tcgdex:name:${fragment.toLowerCase()}`, CARD_TTL_MS, async () => {
        const body = await this.fetchJson(this.url("/cards", { name: fragment }));
        return (Array.isArray(body) ? body : []) as TcgdexCardBrief[];
      }),
    );
    const briefs = [...new Map(briefLists.flat().map((b) => [b.id, b])).values()];
    const setOf = (cardId: string) => cardId.slice(0, cardId.lastIndexOf("-"));
    briefs.sort((a, b) => (releaseOf.get(setOf(b.id)) ?? "").localeCompare(releaseOf.get(setOf(a.id)) ?? ""));
    return this.cardsById(briefs.slice(0, this.nameFetchCap * Math.max(1, fragments.length)).map((b) => b.id));
  }

  /** Earliest release date (YYYY-MM-DD) of a set that can hold standard-legal cards. */
  standardPoolSince(marks: string[] = currentLegalMarks()): string {
    const override = process.env.STANDARD_POOL_SINCE?.trim();
    if (override && /^\d{4}-\d{2}-\d{2}$/.test(override)) return override;
    const oldest = [...marks].sort()[0] ?? "G";
    // Marks start appearing on promos a few months before the first main set.
    return `${yearOfMark(oldest) - 1}-10-01`;
  }

  /** Every card from every set released inside the current regulation-mark window. */
  private async standardPool(): Promise<Card[]> {
    const since = this.standardPoolSince();
    const details = await this.allSetDetails();
    const setIds = details.filter((s) => (s.releaseDate ?? "") >= since).map((s) => s.id);
    return this.cardsOfSets(setIds);
  }

  private async poolFor(scope: Scope): Promise<Card[]> {
    switch (scope.kind) {
      case "ids":
        return this.cardsById(scope.values);
      case "sets":
        return this.cardsOfSets(scope.values);
      case "setCodes":
        return this.cardsOfSets(await this.setIdsForCodes(scope.values));
      case "names":
        return this.cardsByNames(scope.values);
      case "none":
        return this.standardPool();
    }
  }

  async searchCards(q: string, opts: SearchOptions = {}): Promise<SearchResult> {
    let ast;
    try {
      ast = parse(q);
    } catch (err) {
      if (err instanceof LuceneSyntaxError) throw new Error(`could not parse query "${q}": ${err.message}`);
      throw err;
    }
    const pool = await this.poolFor(scopeOf(ast));
    const seen = new Set<string>();
    const hits = pool.filter((c) => {
      if (seen.has(c.id) || !matches(c, ast)) return false;
      seen.add(c.id);
      return true;
    });
    const sorted = sortBy(hits, opts.orderBy);
    const pageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE;
    const page = Math.max(1, opts.page ?? 1);
    return {
      cards: sorted.slice((page - 1) * pageSize, page * pageSize),
      totalCount: sorted.length,
      pageSize,
    };
  }
}
