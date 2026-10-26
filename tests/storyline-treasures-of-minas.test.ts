// sql/052_storylines_seed_treasures_of_minas.sql against real Postgres
// (PGlite): the storyline row and its items' storyline_ids.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getStoryline } from "../lib/storylines.ts";
import { makeSql } from "./helpers/pg.ts";

const ID = "treasures-of-minas";
const SEED = readFileSync(
  join(
    import.meta.dirname,
    "..",
    "sql",
    "052_storylines_seed_treasures_of_minas.sql",
  ),
  "utf8",
);

let sql: any;

async function seed() {
  await sql.$db.exec(SEED);
}

beforeAll(async () => {
  sql = await makeSql([
    "001_items_schema.sql",
    "019_storylines.sql",
    "049_translations.sql",
  ]);
  await seed();
  const [row] = await sql.query("SELECT items FROM storylines WHERE id = $1", [
    ID,
  ]);
  for (const chapter of row.items) {
    const nativeId = String(chapter.id);
    await sql.query(
      "INSERT INTO items (id, source, native_id, title) VALUES ($1, 'tainacan', $2, $2)",
      [`tainacan:${nativeId}`, nativeId],
    );
  }
  await seed();
  await seed();
});

afterAll(async () => {
  if (sql) await sql.$close();
});

describe("Treasures of Minas storyline seed", () => {
  it("is a sourced narrative storyline whose cover is one of its chapters", async () => {
    const storyline = await getStoryline(sql, ID);
    expect(storyline.tier).toBe("narrative");
    expect(storyline.source_note?.length).toBeGreaterThan(0);
    const ids = storyline.items.map((c: any) => String(c.id));
    expect(ids).toContain(String(storyline.cover_item_id));
    expect(new Set(ids).size).toBe(ids.length);
    storyline.items.forEach((c: any, i: number) => {
      expect(c.position).toBe(i + 1);
      expect(c.chapter_caption.trim()).not.toBe("");
    });
  });

  it("tags every chapter's item exactly once, however often it runs", async () => {
    const rows = await sql.query(
      "SELECT native_id, storyline_ids FROM items ORDER BY native_id",
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.storyline_ids).toEqual([ID]);
    }
  });

  it("leaves translations to the review pipeline", async () => {
    const rows = await sql.query(
      "SELECT count(*)::int AS n FROM translations WHERE entity_id = $1",
      [ID],
    );
    expect(rows[0].n).toBe(0);
  });
});
