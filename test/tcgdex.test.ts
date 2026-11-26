import { describe, expect, it } from "vitest";

import { HttpError } from "../src/http.js";
import { cardNumber, mapCard, mapSet, TcgdexClient, type TcgdexCard, type TcgdexSet } from "../src/tcgdex.js";

const BASE = "https://tcgdex.test/v2/en";

const SV06: TcgdexSet = {
  id: "sv06",
  name: "Twilight Masquerade",
  serie: { id: "sv", name: "Scarlet & Violet" },
  tcgOnline: "TWM",
  releaseDate: "2024-05-24",
  cardCount: { total: 226, official: 167 },
  cards: [
    { id: "sv06-025", localId: "025", name: "Teal Mask Ogerpon ex" },
    { id: "sv06-144", localId: "144", name: "Caretaker" },
  ],
};

const SWSH1: TcgdexSet = {
  id: "swsh1",
  name: "Sword & Shield",
  serie: { id: "swsh", name: "Sword & Shield" },
  tcgOnline: "SSH",
  releaseDate: "2020-02-07",
  cardCount: { total: 216, official: 202 },
  cards: [{ id: "swsh1-178", localId: "178", name: "Professor's Research" }],
};

const OGERPON: TcgdexCard = {
  id: "sv06-025",
  localId: "025",
  name: "Teal Mask Ogerpon ex",
  image: "https://assets.tcgdex.net/en/sv/sv06/025",
  category: "Pokemon",
  rarity: "Double rare",
  set: { id: "sv06", name: "Twilight Masquerade", cardCount: { total: 226, official: 167 } },
  hp: 210,
  types: ["Grass"],
  stage: "Basic",
  suffix: "ex",
  abilities: [{ type: "Ability", name: "Teal Dance", effect: "Once during your turn, you may attach a Basic Grass Energy card from your hand to this Pokémon. If you do, draw a card." }],
  attacks: [{ cost: ["Grass", "Grass", "Grass"], name: "Myriad Leaf Shower", effect: "This attack does 30 more damage for each Energy attached to both Active Pokémon.", damage: "30+" }],
  weaknesses: [{ type: "Fire", value: "×2" }],
  retreat: 1,
  regulationMark: "H",
  legal: { standard: true, expanded: true },
  pricing: {
    tcgplayer: { updated: "2026-11-01T00:00:00.000Z", unit: "USD", holofoil: { lowPrice: 10, marketPrice: 12.5 } },
    cardmarket: { updated: "2026-11-01T00:00:00.000Z", unit: "EUR", avg: 11, trend: 10.2, "trend-holo": 14 },
  },
};

const CARETAKER: TcgdexCard = {
  id: "sv06-144",
  localId: "144",
  name: "Caretaker",
  category: "Trainer",
  rarity: "Uncommon",
  set: { id: "sv06", name: "Twilight Masquerade" },
  trainerType: "Supporter",
  effect: "Search your deck for a Stadium card, reveal it, and put it into your hand. Then, shuffle your deck. Draw 2 cards.",
  regulationMark: "H",
  legal: { standard: true, expanded: true },
};

const RESEARCH: TcgdexCard = {
  id: "swsh1-178",
  localId: "178",
  name: "Professor's Research",
  category: "Trainer",
  set: { id: "swsh1", name: "Sword & Shield" },
  trainerType: "Supporter",
  effect: "Discard your hand and draw 7 cards.",
  regulationMark: "D",
  legal: { standard: false, expanded: true },
};

function fakeApi() {
  const calls: string[] = [];
  const cards = new Map([OGERPON, CARETAKER, RESEARCH].map((c) => [c.id, c]));
  const sets = new Map([SV06, SWSH1].map((s) => [s.id, s]));
  const fetchJson = async (url: string): Promise<unknown> => {
    calls.push(url);
    const u = new URL(url);
    const path = u.pathname.replace("/v2/en", "");
    if (path === "/sets") return [...sets.values()].map(({ id, name, cardCount }) => ({ id, name, cardCount }));
    if (path.startsWith("/sets/")) {
      const set = sets.get(decodeURIComponent(path.slice("/sets/".length)));
      if (!set) throw new HttpError("HTTP 404", 404, url);
      return set;
    }
    if (path === "/cards") {
      const name = (u.searchParams.get("name") ?? "").toLowerCase();
      return [...cards.values()]
        .filter((c) => c.name.toLowerCase().includes(name))
        .map(({ id, localId, name: n }) => ({ id, localId, name: n }));
    }
    if (path.startsWith("/cards/")) {
      const card = cards.get(decodeURIComponent(path.slice("/cards/".length)));
      if (!card) throw new HttpError("HTTP 404", 404, url);
      return card;
    }
    throw new Error(`unexpected url ${url}`);
  };
  return { calls, fetchJson };
}

function client(api = fakeApi()) {
  return { api, c: new TcgdexClient({ baseUrl: BASE, cacheDir: null, fetchJson: api.fetchJson }) };
}

describe("mapCard", () => {
  it("maps a Pokémon ex into the pokemontcg.io shape", () => {
    const card = mapCard(OGERPON, mapSet(SV06));
    expect(card.supertype).toBe("Pokémon");
    expect(card.subtypes).toEqual(["Basic", "ex"]);
    expect(card.hp).toBe("210");
    expect(card.number).toBe("25");
    expect(card.set.ptcgoCode).toBe("TWM");
    expect(card.set.releaseDate).toBe("2024/05/24");
    expect(card.set.printedTotal).toBe(167);
    expect(card.abilities?.[0]).toEqual({ name: "Teal Dance", text: OGERPON.abilities![0].effect, type: "Ability" });
    expect(card.attacks?.[0].convertedEnergyCost).toBe(3);
    expect(card.attacks?.[0].damage).toBe("30+");
    expect(card.retreatCost).toEqual(["Colorless"]);
    expect(card.rules?.[0]).toMatch(/Pokémon ex rule/);
    expect(card.legalities).toEqual({ standard: "Legal", expanded: "Legal" });
    expect(card.images?.large).toBe("https://assets.tcgdex.net/en/sv/sv06/025/high.webp");
    expect(card.tcgplayer?.prices?.holofoil?.market).toBe(12.5);
    expect(card.cardmarket?.prices?.trendPrice).toBe(10.2);
    expect(card.cardmarket?.prices?.reverseHoloTrend).toBe(14);
  });

  it("maps trainers, tools, ACE SPECs, Mega ex and energy", () => {
    const caretaker = mapCard(CARETAKER);
    expect(caretaker.subtypes).toEqual(["Supporter"]);
    expect(caretaker.rules).toEqual([CARETAKER.effect]);

    const tool = mapCard({ ...CARETAKER, id: "x-1", name: "Maximum Belt", trainerType: "Tool", rarity: "ACE SPEC Rare" });
    expect(tool.subtypes).toEqual(["Pokémon Tool", "ACE SPEC"]);

    const mega = mapCard({ ...OGERPON, name: "Mega Venusaur ex", stage: "Stage2" });
    expect(mega.subtypes).toEqual(["Stage 2", "MEGA", "ex"]);
    expect(mega.rules?.[0]).toMatch(/3 Prize cards/);

    const energy = mapCard({ id: "sve-005", localId: "005", name: "Basic Psychic Energy", category: "Energy", energyType: "Basic", set: { id: "sve", name: "Energies" } });
    expect(energy.supertype).toBe("Energy");
    expect(energy.subtypes).toEqual(["Basic"]);
    expect(energy.number).toBe("5");
  });

  it("keeps non-numeric card numbers as they are", () => {
    expect(cardNumber("GG44")).toBe("GG44");
    expect(cardNumber("TG05")).toBe("TG05");
    expect(cardNumber(7)).toBe("7");
  });
});

describe("TcgdexClient", () => {
  it("lists sets with Live codes and printed totals", async () => {
    const { c } = client();
    const sets = await c.getAllSets();
    expect(sets.find((s) => s.id === "sv06")).toMatchObject({ ptcgoCode: "TWM", printedTotal: 167, series: "Scarlet & Violet" });
  });

  it("fetches one card by id and returns null for unknown ids", async () => {
    const { c } = client();
    expect((await c.getCardById("sv06-144"))?.name).toBe("Caretaker");
    expect(await c.getCardById("nope-1")).toBeNull();
  });

  it("resolves set + number queries from the set listing only", async () => {
    const { c, api } = client();
    const res = await c.searchCards("set.id:sv06 (number:25 OR number:144)");
    expect(res.cards.map((x) => x.id).sort()).toEqual(["sv06-025", "sv06-144"]);
    expect(api.calls.some((u) => u.includes("/cards?"))).toBe(false);
  });

  it("resolves Live set codes", async () => {
    const { c } = client();
    const res = await c.searchCards("set.ptcgoCode:TWM number:144");
    expect(res.cards.map((x) => x.name)).toEqual(["Caretaker"]);
  });

  it("searches by name through the API and refines locally", async () => {
    const { c, api } = client();
    const res = await c.searchCards('name:"Professor\'s Research"', { orderBy: "-set.releaseDate" });
    expect(res.cards.map((x) => x.id)).toEqual(["swsh1-178"]);
    expect(api.calls.some((u) => u.includes("/cards?name="))).toBe(true);
  });

  it("evaluates unscoped queries over the standard pool only", async () => {
    const { c } = client();
    const res = await c.searchCards("supertype:trainer subtypes:supporter rules:draw*");
    expect(res.cards.map((x) => x.id)).toEqual(["sv06-144"]); // Professor's Research is outside the pool
    expect(c.standardPoolSince(["H", "I", "J"])).toBe("2023-10-01");
  });

  it("paginates and reports the total", async () => {
    const { c } = client();
    const res = await c.searchCards("set.id:sv06", { pageSize: 1, orderBy: "number" });
    expect(res.totalCount).toBe(2);
    expect(res.cards.map((x) => x.id)).toEqual(["sv06-025"]);
    const page2 = await c.searchCards("set.id:sv06", { pageSize: 1, page: 2, orderBy: "number" });
    expect(page2.cards.map((x) => x.id)).toEqual(["sv06-144"]);
  });

  it("caches card documents across searches", async () => {
    const { c, api } = client();
    await c.searchCards("set.id:sv06");
    const before = api.calls.length;
    await c.searchCards("set.id:sv06 number:25");
    expect(api.calls.length).toBe(before);
  });

  it("turns syntax errors into readable tool errors", async () => {
    const { c } = client();
    await expect(c.searchCards('name:"oops')).rejects.toThrow(/could not parse query/);
  });
});
