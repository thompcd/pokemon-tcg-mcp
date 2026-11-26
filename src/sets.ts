import type { CardSource } from "./cardsource.js";
import type { SetInfo } from "./types.js";

/**
 * Maps TCG Live / PTCGO set codes (PBL, POR, TWM, …) to card-source sets by
 * matching the `ptcgoCode` field of /sets. Built lazily on first use and
 * cached (the underlying /sets call is cached for 24h). A code can map to
 * multiple sets (e.g. CRZ covers Crown Zenith and its Galarian Gallery) —
 * card numbers disambiguate because subsets use distinct numbering (GG44…).
 */
export class SetResolver {
  constructor(private api: CardSource) {}

  /**
   * Rebuilt from the cached /sets response on every call — the underlying
   * fetch is TTL-cached (24h) with in-flight dedup, so this stays cheap while
   * still picking up new sets when the cache expires on a long-running server.
   */
  async mapping(): Promise<Map<string, SetInfo[]>> {
    const sets = await this.api.getAllSets();
    const map = new Map<string, SetInfo[]>();
    const add = (code: string, set: SetInfo) => {
      const key = code.toUpperCase();
      const list = map.get(key) ?? [];
      if (!list.some((s) => s.id === set.id)) list.push(set);
      map.set(key, list);
    };
    for (const set of sets) {
      if (set.ptcgoCode) add(set.ptcgoCode, set);
    }
    // Fill gaps in the source's Live codes: SET_CODE_OVERRIDES="PBL=me05,POR=me04".
    const byId = new Map(sets.map((s) => [s.id.toLowerCase(), s]));
    for (const [code, setId] of parseSetCodeOverrides(process.env.SET_CODE_OVERRIDES)) {
      const set = byId.get(setId.toLowerCase());
      if (set) add(code, { ...set, ptcgoCode: set.ptcgoCode ?? code.toUpperCase() });
    }
    for (const list of map.values()) {
      list.sort((a, b) => (b.total ?? 0) - (a.total ?? 0)); // main set before subsets
    }
    return map;
  }

  /** Sets matching a Live/PTCGO code, or [] if unknown. */
  async lookup(code: string): Promise<SetInfo[]> {
    return (await this.mapping()).get(code.toUpperCase()) ?? [];
  }

  /**
   * Reverse lookup set.id → Live code (first code wins), for printings whose
   * embedded ptcgoCode is missing (a known API data gap for PAL, SVE, …).
   */
  async reverseMapping(): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    for (const [code, sets] of await this.mapping()) {
      for (const s of sets) if (!map.has(s.id)) map.set(s.id, code);
    }
    return map;
  }
}

/** "PBL=me05, POR=me04" → [["PBL","me05"],["POR","me04"]]; malformed pairs are skipped. */
export function parseSetCodeOverrides(raw: string | undefined): [string, string][] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((pair) => pair.split("=").map((p) => p.trim()))
    .filter((p): p is [string, string] => p.length === 2 && /^[A-Za-z0-9]{2,5}$/.test(p[0]) && p[1].length > 0);
}
