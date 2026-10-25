// Prints, per non-English locale, how much catalogue content is translated
// and actually served, broken down by entity and field. Read-only. See
// lib/translation-coverage.ts for what each column means.
//
// Run:  bun run translations:coverage
// (needs DATABASE_URL, e.g. from .env.local)
import { getSql } from "../lib/db.ts";
import { LIVE_ITEMS_WHERE } from "../lib/items-sql.ts";
import {
  type CoverageTranslation,
  coverageReport,
  type SourceField,
} from "../lib/translation-coverage.ts";
import { ITEM_FIELDS } from "../lib/translations.ts";
import { DEFAULT_LOCALE, LOCALES } from "../src/i18n/locales.ts";

const sql = getSql();
if (!sql) throw new Error("DATABASE_URL is not set");

const sources: SourceField[] = [];

const items = (await sql.query(
  `SELECT id, ${ITEM_FIELDS.join(", ")} FROM items ${LIVE_ITEMS_WHERE}`,
)) as Array<Record<string, unknown> & { id: string }>;
for (const item of items) {
  for (const field of ITEM_FIELDS) {
    const text = item[field];
    // Non-string fields (tags) can't be served translated yet.
    if (typeof text === "string") {
      sources.push({ entityType: "item", entityId: item.id, field, text });
    }
  }
}

const storylines = (await sql.query(
  "SELECT id, title, intro_caption, items FROM storylines",
)) as Array<{
  id: string;
  title: string | null;
  intro_caption: string | null;
  items: Array<{ id: string; chapter_caption?: string | null }> | null;
}>;
for (const s of storylines) {
  const add = (field: string, text: string | null | undefined) => {
    if (text)
      sources.push({ entityType: "storyline", entityId: s.id, field, text });
  };
  add("title", s.title);
  add("intro_caption", s.intro_caption);
  for (const chapter of s.items ?? []) {
    add(`chapter_caption:${chapter.id}`, chapter.chapter_caption);
  }
}

const shelves = (await sql.query("SELECT id, title FROM shelves")) as Array<{
  id: string;
  title: string | null;
}>;
for (const s of shelves) {
  if (s.title) {
    sources.push({
      entityType: "shelf",
      entityId: s.id,
      field: "title",
      text: s.title,
    });
  }
}

const translations = (await sql.query(
  `SELECT entity_type, entity_id, locale, field, text, origin, review_status, source_hash
   FROM translations`,
)) as CoverageTranslation[];

const locales = LOCALES.filter((l) => l.code !== DEFAULT_LOCALE).map(
  (l) => l.code,
);
const report = coverageReport(sources, translations, locales);

const columns = [
  "locale",
  "entityType",
  "field",
  "total",
  "served",
  "stale",
  "machine",
  "held",
  "pending",
  "missing",
] as const;
const rows = report.map((line) => columns.map((c) => String(line[c])));
const widths = columns.map((c, i) =>
  Math.max(c.length, ...rows.map((r) => r[i].length)),
);
const format = (cells: readonly string[]) =>
  cells.map((cell, i) => cell.padEnd(widths[i])).join("  ");

console.log(
  `${items.length} live items, ${storylines.length} storylines, ${shelves.length} shelves; ${translations.length} translation rows\n`,
);
console.log(format(columns));
for (const r of rows) console.log(format(r));
