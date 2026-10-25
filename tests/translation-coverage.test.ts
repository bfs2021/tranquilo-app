import { describe, expect, it } from "vitest";
import {
  type CoverageTranslation,
  coverageReport,
  type SourceField,
} from "../lib/translation-coverage";
import { sourceHash } from "../lib/translations";

const source = (
  entityId: string,
  field: string,
  text: string,
  entityType: SourceField["entityType"] = "item",
): SourceField => ({ entityType, entityId, field, text });

const row = (
  over: Partial<CoverageTranslation> & { entity_id: string; field: string },
): CoverageTranslation => ({
  entity_type: "item",
  locale: "pt-BR",
  text: "tradução",
  origin: "human",
  review_status: "approved",
  source_hash: null,
  ...over,
});

function only(report: ReturnType<typeof coverageReport>, field = "title") {
  const line = report.find((l) => l.field === field);
  if (!line) throw new Error(`no line for ${field}`);
  return line;
}

describe("coverageReport", () => {
  it("counts a current, approved human translation as served", () => {
    const report = coverageReport(
      [source("met:1", "title", "Wheat Field")],
      [
        row({
          entity_id: "met:1",
          field: "title",
          source_hash: sourceHash("Wheat Field"),
        }),
      ],
      ["pt-BR"],
    );
    expect(only(report)).toMatchObject({
      locale: "pt-BR",
      entityType: "item",
      total: 1,
      served: 1,
      missing: 0,
    });
  });

  it("counts an approved translation of old wording as stale, not served", () => {
    const report = coverageReport(
      [source("met:1", "title", "Wheat Field with Cypresses")],
      [
        row({
          entity_id: "met:1",
          field: "title",
          source_hash: sourceHash("Wheat Field"),
        }),
      ],
      ["pt-BR"],
    );
    expect(only(report)).toMatchObject({ served: 0, stale: 1 });
  });

  it("keeps machine translations apart, since they aren't served yet", () => {
    const report = coverageReport(
      [source("met:1", "title", "Wheat Field")],
      [
        row({
          entity_id: "met:1",
          field: "title",
          origin: "machine",
          source_hash: sourceHash("Wheat Field"),
        }),
      ],
      ["pt-BR"],
    );
    expect(only(report)).toMatchObject({ served: 0, machine: 1 });
  });

  it("counts held, pending and untranslated fields separately", () => {
    const report = coverageReport(
      [
        source("met:1", "title", "A"),
        source("met:2", "title", "B"),
        source("met:3", "title", "C"),
      ],
      [
        row({ entity_id: "met:1", field: "title", review_status: "held" }),
        row({ entity_id: "met:2", field: "title", review_status: "pending" }),
      ],
      ["pt-BR"],
    );
    expect(only(report)).toMatchObject({
      total: 3,
      held: 1,
      pending: 1,
      missing: 1,
    });
  });

  it("files each field under exactly one status", () => {
    const report = coverageReport(
      [source("met:1", "title", "A")],
      [
        row({
          entity_id: "met:1",
          field: "title",
          source_hash: sourceHash("A"),
        }),
        row({
          entity_id: "met:1",
          field: "title",
          origin: "machine",
          review_status: "pending",
          source_hash: sourceHash("A"),
        }),
      ],
      ["pt-BR"],
    );
    const line = only(report);
    expect(
      line.served +
        line.stale +
        line.machine +
        line.held +
        line.pending +
        line.missing,
    ).toBe(line.total);
    expect(line.served).toBe(1);
  });

  it("ignores another locale's rows and empty source text", () => {
    const report = coverageReport(
      [source("met:1", "title", "A"), source("met:2", "title", "")],
      [
        row({
          entity_id: "met:1",
          field: "title",
          locale: "es",
          source_hash: sourceHash("A"),
        }),
      ],
      ["pt-BR"],
    );
    expect(only(report)).toMatchObject({ total: 1, served: 0, missing: 1 });
  });

  it("reports one line per locale, entity type and field", () => {
    const report = coverageReport(
      [
        source("met:1", "title", "A"),
        source("s1", "title", "Story", "storyline"),
        source("s1", "intro_caption", "Once", "storyline"),
      ],
      [],
      ["pt-BR", "es"],
    );
    expect(report.map((l) => `${l.locale} ${l.entityType} ${l.field}`)).toEqual(
      [
        "pt-BR item title",
        "pt-BR storyline intro_caption",
        "pt-BR storyline title",
        "es item title",
        "es storyline intro_caption",
        "es storyline title",
      ],
    );
  });
});
