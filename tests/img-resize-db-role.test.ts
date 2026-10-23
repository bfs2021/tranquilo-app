// sql/048_img_resize_role.sql: the image resize function's database role
// can do exactly what its code paths need, and cannot touch the catalogue.
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeSql } from "./helpers/pg.ts";

vi.mock("../lib/sentry.ts", () => ({ Sentry: {}, reportError: vi.fn() }));

const { lookupOriginUrl } = await import("../lib/img-transform.ts");
const admission = await import("../lib/img-admission.ts");
const guard = await import("../lib/img-fetch-guard.ts");
const store = await import("../lib/img-store.ts");
const { acquireVisitorToken } = await import(
  "../lib/img-visitor-rate-limit.ts"
);

const SCHEMA = [
  "001_items_schema.sql",
  "003_items_harmonization.sql",
  "010_img_fetch_state.sql",
  "011_img_cache_entries.sql",
  "012_host_fetch_state.sql",
  "013_img_shed_stats.sql",
  "025_img_cache_native_id.sql",
  "026_img_object_keys.sql",
  "035_visitor_rate_state.sql",
];

const EXPECTED: Record<string, string[]> = {
  items: ["SELECT"],
  img_cache_entries: ["SELECT", "INSERT", "UPDATE"],
  img_fetch_claims: ["SELECT", "INSERT", "UPDATE", "DELETE"],
  source_fetch_state: ["SELECT", "UPDATE"],
  host_fetch_state: ["SELECT", "INSERT", "UPDATE"],
  img_cache_stats: ["SELECT", "INSERT", "UPDATE"],
  img_shed_stats: ["SELECT", "INSERT", "UPDATE"],
  visitor_fetch_state: ["SELECT", "INSERT", "UPDATE"],
};
const ALL = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE"];

let sql: any;
afterEach(async () => {
  if (sql) await sql.$close();
  sql = null;
});

async function withRole() {
  sql = await makeSql(SCHEMA);
  await sql.$db.exec("CREATE ROLE img_resize NOLOGIN");
  await sql.$db.exec(
    (await import("node:fs")).readFileSync(
      new URL("../sql/048_img_resize_role.sql", import.meta.url),
      "utf8",
    ),
  );
}

describe("048_img_resize_role.sql", () => {
  it("applies cleanly where the role does not exist", async () => {
    sql = await makeSql([...SCHEMA, "048_img_resize_role.sql"]);
    const rows = await sql.query(
      "SELECT 1 FROM pg_roles WHERE rolname = 'img_resize'",
    );
    expect(rows).toEqual([]);
  });

  it("grants exactly the privileges the function uses", async () => {
    await withRole();
    for (const [table, granted] of Object.entries(EXPECTED)) {
      for (const privilege of ALL) {
        const [row] = await sql.query(
          "SELECT has_table_privilege('img_resize', $1, $2) AS ok",
          [table, privilege],
        );
        expect(row.ok, `${privilege} on ${table}`).toBe(
          granted.includes(privilege),
        );
      }
    }
  });

  it("is re-runnable", async () => {
    await withRole();
    await expect(
      sql.$db.exec(
        (await import("node:fs")).readFileSync(
          new URL("../sql/048_img_resize_role.sql", import.meta.url),
          "utf8",
        ),
      ),
    ).resolves.not.toThrow();
  });

  it("lets the miss path's own calls write their bookkeeping", async () => {
    await withRole();
    await sql.$db.exec("SET ROLE img_resize");
    const key = "met:1:display";

    await admission.noteRequest(sql, key, "met", "display", "1");
    expect((await guard.acquireFetchToken(sql, "met")).reason).toBe("ok");
    expect(
      (await guard.acquireHostToken(sql, "images.metmuseum.org", "met"))
        .allowed,
    ).toBe(true);
    expect(await guard.claimFetch(sql, key)).toBe(true);
    await guard.recordOriginOutcome(sql, "met", 200, true);
    await guard.recordHostOutcome(sql, "images.metmuseum.org", 200, true);
    await guard.bumpStat(sql, "met", "display", "misses");
    await guard.bumpShedReason(sql, "met", "display", "in-flight");
    expect(await store.recordObject(sql, key, "img-cache/k", "h", 10)).toBe(
      true,
    );
    await guard.releaseFetch(sql, key);
    expect((await acquireVisitorToken(sql, "203.0.113.7")).reason).toBe("ok");
    expect(
      store.resolveHit(await store.touchAndResolve(sql, key), {
        enabled: true,
        cdnBaseUrl: "https://cdn.example",
      }).from,
    ).toBe("cdn");

    await sql.$db.exec("RESET ROLE");
    const count = async (q: string) => Number((await sql.query(q))[0].n);
    expect(
      await count(
        "SELECT count(*) AS n FROM img_cache_entries WHERE object_key = 'img-cache/k'",
      ),
    ).toBe(1);
    expect(await count("SELECT count(*) AS n FROM img_fetch_claims")).toBe(0);
    expect(await count("SELECT count(*) AS n FROM img_cache_stats")).toBe(1);
    expect(await count("SELECT count(*) AS n FROM img_shed_stats")).toBe(1);
    expect(await count("SELECT count(*) AS n FROM host_fetch_state")).toBe(1);
    expect(await count("SELECT count(*) AS n FROM visitor_fetch_state")).toBe(
      1,
    );
  });

  it("can read a live item's origin but not change the catalogue", async () => {
    await withRole();
    await sql.query(
      "INSERT INTO items (id, source, native_id, title, category, img) " +
        "VALUES ('met:1', 'met', '1', 'T', 'Painting', 'https://images.metmuseum.org/1.jpg')",
    );
    await sql.$db.exec("SET ROLE img_resize");
    await expect(lookupOriginUrl(sql, "met", "1", "display")).resolves.toBe(
      "https://images.metmuseum.org/1.jpg",
    );
    await expect(
      sql.query("UPDATE items SET title = 'x' WHERE id = 'met:1'"),
    ).rejects.toThrow(/permission denied/);
  });
});
