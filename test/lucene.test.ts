import { describe, expect, it } from "vitest";

import { LuceneSyntaxError, matches, parse, scopeOf, sortBy, valuesAt } from "../src/lucene.js";
import { buildEffectQuery, buildQuery, standardClause, textContainsClause } from "../src/qbuilder.js";
import type { Card } from "../src/types.js";

const SET = { id: "sv06", name: "Twilight Masquerade", ptcgoCode: "TWM", releaseDate: "2024/05/24", total: 226 };

const caretaker: Card = {
  id: "sv06-144",
  name: "Caretaker",
  supertype: "Trainer",
  subtypes: ["Supporter"],
  rules: ["Search your deck for a Stadium card, reveal it, and put it into your hand. Then, shuffle your deck. Draw 2 cards."],
  regulationMark: "H",
  number: "144",
  set: SET,
};

const ogerpon: Card = {
  id: "sv06-25",
  name: "Teal Mask Ogerpon ex",
  supertype: "Pokémon",
  subtypes: ["Basic", "ex"],
  hp: "210",
  types: ["Grass"],
  abilities: [{ name: "Teal Dance", text: "Once during your turn, you may attach a Basic {G} Energy card from your hand to this Pokémon. If you do, draw a card.", type: "Ability" }],
  attacks: [{ name: "Myriad Leaf Shower", cost: ["Grass", "Grass", "Grass"], damage: "30+", text: "This attack does 30 more damage for each Energy attached to both Active Pokémon." }],
  regulationMark: "H",
  number: "25",
  set: SET,
};

const psychicEnergy: Card = {
  id: "sve-5",
  name: "Basic Psychic Energy",
  supertype: "Energy",
  subtypes: ["Basic"],
  number: "5",
  set: { id: "sve", name: "Scarlet & Violet Energies", releaseDate: "2023/03/31" },
};

const oldCard: Card = { ...caretaker, id: "old-1", name: "Professor's Research", regulationMark: "D", set: { ...SET, id: "swsh1", releaseDate: "2020/02/07" } };

const q = (query: string, card: Card) => matches(card, parse(query));

describe("parse", () => {
  it("accepts an empty query as match-all", () => {
    expect(parse("")).toEqual({ kind: "all" });
  });

  it("rejects malformed queries with a syntax error", () => {
    expect(() => parse('name:"unterminated')).toThrow(LuceneSyntaxError);
    expect(() => parse("(name:a")).toThrow(LuceneSyntaxError);
    expect(() => parse("hp:[a TO b]")).toThrow(LuceneSyntaxError);
  });
});

describe("matches", () => {
  it("is case- and accent-insensitive on keyword fields", () => {
    expect(q("supertype:pokemon", ogerpon)).toBe(true);
    expect(q("supertype:trainer", ogerpon)).toBe(false);
    expect(q("subtypes:supporter", caretaker)).toBe(true);
    expect(q('subtypes:"ACE SPEC"', caretaker)).toBe(false);
  });

  it("matches names by word runs and wildcards", () => {
    expect(q("name:ogerpon", ogerpon)).toBe(true);
    expect(q('name:"Teal Mask Ogerpon ex"', ogerpon)).toBe(true);
    expect(q('name:"Mask Teal"', ogerpon)).toBe(false);
    expect(q("name:oger*", ogerpon)).toBe(true);
    expect(q("name:*erpon", ogerpon)).toBe(true);
    expect(q("ogerpon", ogerpon)).toBe(true); // bare word searches the name
  });

  it("walks nested array paths", () => {
    expect(valuesAt(ogerpon, "attacks.text")).toHaveLength(1);
    expect(q('abilities.text:"draw a card"', ogerpon)).toBe(true);
    expect(q("attacks.text:damage", ogerpon)).toBe(true);
    expect(q("attacks.cost:grass", ogerpon)).toBe(true);
    expect(q("set.id:sv06", ogerpon)).toBe(true);
    expect(q("set.ptcgoCode:twm", ogerpon)).toBe(true);
  });

  it("handles boolean operators, negation and grouping", () => {
    expect(q("supertype:trainer OR supertype:energy", caretaker)).toBe(true);
    expect(q("supertype:trainer AND subtypes:item", caretaker)).toBe(false);
    expect(q("-subtypes:item", caretaker)).toBe(true);
    expect(q("NOT subtypes:supporter", caretaker)).toBe(false);
    expect(q("subtypes:(item OR supporter)", caretaker)).toBe(true);
    expect(q("(name:caretaker OR name:iono) regulationMark:H", caretaker)).toBe(true);
  });

  it("supports numeric ranges", () => {
    expect(q("hp:[200 TO *]", ogerpon)).toBe(true);
    expect(q("hp:[100 TO 200]", ogerpon)).toBe(false);
    expect(q("hp:{200 TO 210]", ogerpon)).toBe(true);
    expect(q("hp:[200 TO 210}", ogerpon)).toBe(false);
  });

  it("evaluates every query shape qbuilder produces", () => {
    const marks = ["H", "I", "J"];
    expect(matches(caretaker, parse(standardClause(marks)))).toBe(true);
    expect(matches(psychicEnergy, parse(standardClause(marks)))).toBe(true);
    expect(matches(oldCard, parse(standardClause(marks)))).toBe(false);
    expect(matches(caretaker, parse(textContainsClause("Draw 2 cards")))).toBe(true);
    expect(matches(caretaker, parse(buildEffectQuery(["stadium", "shuffl"])))).toBe(true);
    const built = buildQuery({ query: "Caretaker", supertype: "trainer", subtypes: ["Supporter"], standardLegalOnly: true, legalMarks: marks });
    expect(matches(caretaker, parse(built))).toBe(true);
    expect(matches(oldCard, parse(built))).toBe(false);
    expect(matches(caretaker, parse("supertype:trainer subtypes:supporter rules:draw*"))).toBe(true);
    expect(matches(psychicEnergy, parse('supertype:energy subtypes:basic name:Psychic'))).toBe(true);
  });
});

describe("scopeOf", () => {
  it("prefers ids, then sets, then names", () => {
    expect(scopeOf(parse("set.id:sv06 (number:25 OR number:144)"))).toEqual({ kind: "sets", values: ["sv06"] });
    expect(scopeOf(parse("(set.id:sv06 OR set.id:sv07) name:x"))).toEqual({ kind: "sets", values: ["sv06", "sv07"] });
    expect(scopeOf(parse('name:"Teal Mask Ogerpon ex"'))).toEqual({
      kind: "names",
      values: [{ value: "Teal Mask Ogerpon ex", phrase: true }],
    });
    expect(scopeOf(parse("id:sv06-25"))).toEqual({ kind: "ids", values: ["sv06-25"] });
    expect(scopeOf(parse("set.ptcgoCode:TWM"))).toEqual({ kind: "setCodes", values: ["TWM"] });
  });

  it("gives no scope when a branch or negation could match anything", () => {
    expect(scopeOf(parse("name:a OR supertype:trainer")).kind).toBe("none");
    expect(scopeOf(parse("-name:caretaker")).kind).toBe("none");
    expect(scopeOf(parse(textContainsClause("draw"))).kind).toBe("none");
  });
});

describe("sortBy", () => {
  it("sorts by dotted paths, descending with '-', missing values last", () => {
    const sorted = sortBy([oldCard, psychicEnergy, caretaker], "-set.releaseDate");
    expect(sorted.map((c) => c.id)).toEqual(["sv06-144", "sve-5", "old-1"]);
    const byNumber = sortBy([caretaker, ogerpon], "number");
    expect(byNumber.map((c) => c.number)).toEqual(["25", "144"]);
    const missing = sortBy([psychicEnergy, ogerpon], "-hp");
    expect(missing[0].id).toBe("sv06-25");
  });
});
