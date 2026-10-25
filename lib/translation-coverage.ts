// How much catalogue content each locale can actually show. "Served" uses
// the serving code's own rule (pickTranslation), so this report and
// api/items.ts can't disagree about what a visitor sees. Pure: the
// database reads live in scripts/translation_coverage.mts.
import {
  pickTranslation,
  sourceHash,
  type TranslationRow,
} from "./translations.ts";

export type EntityType = "item" | "storyline" | "shelf";

export interface SourceField {
  entityType: EntityType;
  entityId: string;
  field: string;
  text: string;
}

export interface CoverageTranslation extends TranslationRow {
  entity_type: EntityType;
  review_status: "pending" | "approved" | "held";
}

export interface CoverageLine {
  locale: string;
  entityType: EntityType;
  field: string;
  total: number;
  served: number;
  stale: number;
  machine: number;
  held: number;
  pending: number;
  missing: number;
}

type Status = "served" | "stale" | "machine" | "held" | "pending" | "missing";

function statusOf(
  rows: readonly CoverageTranslation[],
  field: SourceField,
  locale: string,
): Status {
  if (rows.length === 0) return "missing";
  const approved = rows.filter((r) => r.review_status === "approved");
  if (pickTranslation(approved, field.field, [locale], field.text)) {
    return "served";
  }
  const hash = sourceHash(field.text);
  const approvedServable = approved.filter((r) => r.origin !== "machine");
  if (approvedServable.some((r) => r.source_hash !== hash)) return "stale";
  if (approved.some((r) => r.origin === "machine")) return "machine";
  if (rows.some((r) => r.review_status === "held")) return "held";
  return "pending";
}

export function coverageReport(
  sources: readonly SourceField[],
  translations: readonly CoverageTranslation[],
  locales: readonly string[],
): CoverageLine[] {
  const rowsFor = new Map<string, CoverageTranslation[]>();
  for (const r of translations) {
    const key = `${r.locale}|${r.entity_type}|${r.entity_id}|${r.field}`;
    rowsFor.set(key, [...(rowsFor.get(key) ?? []), r]);
  }

  const lines = new Map<string, CoverageLine>();
  for (const locale of locales) {
    for (const source of sources) {
      if (!source.text) continue;
      // Chapter captions are one field per chapter; report them together.
      const field = source.field.split(":")[0];
      const lineKey = `${locale}|${source.entityType}|${field}`;
      let line = lines.get(lineKey);
      if (!line) {
        line = {
          locale,
          entityType: source.entityType,
          field,
          total: 0,
          served: 0,
          stale: 0,
          machine: 0,
          held: 0,
          pending: 0,
          missing: 0,
        };
        lines.set(lineKey, line);
      }
      const rows =
        rowsFor.get(
          `${locale}|${source.entityType}|${source.entityId}|${source.field}`,
        ) ?? [];
      line.total += 1;
      line[statusOf(rows, source, locale)] += 1;
    }
  }

  const order = (l: CoverageLine) =>
    `${locales.indexOf(l.locale)}|${l.entityType}|${l.field}`;
  return [...lines.values()].sort((a, b) => order(a).localeCompare(order(b)));
}
