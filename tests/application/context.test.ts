import assert from "node:assert/strict";
import test from "node:test";
import { createContext } from "../../src/application/context.js";
import { testDatabase } from "../helpers/sqlite.js";
import type { Env } from "../../src/runtime/bindings.js";

test("separate contexts keep their injected API transport isolated", async () => {
  const database = testDatabase();
  const gameId = "018d937f-07fc-72ed-8517-d8e24cb1eb22";
  const env = {
    DB: database.db,
    ITAD_API_KEY: "fixture",
    TELEGRAM_BOT_TOKEN: "fixture",
  } as Env;
  const callsA: string[] = [],
    callsB: string[] = [];
  const transport =
    (label: string, calls: string[]): typeof fetch =>
    async () => {
      calls.push(label);
      return new Response(
        JSON.stringify([
          { id: gameId, title: label, slug: label, type: "game" },
        ]),
      );
    };
  try {
    const a = createContext(env, { fetcher: transport("A", callsA) });
    const b = createContext(env, { fetcher: transport("B", callsB) });
    assert.equal((await a.itad.searchGames("example"))[0].title, "A");
    assert.equal((await b.itad.searchGames("example"))[0].title, "B");
    assert.deepEqual(callsA, ["A"]);
    assert.deepEqual(callsB, ["B"]);
  } finally {
    database.close();
  }
});
