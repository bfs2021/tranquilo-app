// The image proxy identifies itself to source institutions. It
// previously sent no headers at all, anonymous on every cache miss in
// production -- one institution returned a 429 to a single lightbox request.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as identity from "../lib/source-identity.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("the identity string", () => {
  it("names the product, a URL and an email", () => {
    // An operator who wants us to stop needs a way to say so; an
    // unidentified request can only be throttled or blocked.
    expect(identity.USER_AGENT).toContain("Tranquilo/1.0");
    expect(identity.USER_AGENT).toContain("https://tranquilo.art");
    expect(identity.USER_AGENT).toContain("hello@tranquilo.art");
  });

  it("does NOT pretend to be a browser", () => {
    // A Mozilla/5.0 lead reads as evasive: claiming to be a browser while
    // being a batch process.
    expect(identity.USER_AGENT).not.toMatch(/Mozilla/);
    expect(identity.USER_AGENT).not.toMatch(/HeadlessChrome/);
  });

  it("does not claim a runtime it isn't using", () => {
    expect(identity.USER_AGENT).not.toContain("python-urllib");
  });

  it("gives Wikimedia the fuller string their policy asks for", () => {
    // Their policy welcomes purpose alongside contact.
    expect(identity.WIKIMEDIA_USER_AGENT).toContain("art catalogue");
    expect(identity.WIKIMEDIA_USER_AGENT.length).toBeGreaterThan(
      identity.USER_AGENT.length,
    );
  });

  it("stays in step with the Python module it duplicates", () => {
    // No shared module, no build step, and now separate repos, so this
    // reads as last-known-synced values updated by hand.
    const PYTHON_IDENTITY = {
      PRODUCT: "Tranquilo",
      VERSION: "1.0",
      CONTACT_URL: "https://tranquilo.art",
      CONTACT_EMAIL: "hello@tranquilo.art",
    };
    for (const [name, value] of Object.entries(PYTHON_IDENTITY)) {
      expect(
        (identity as Record<string, unknown>)[name],
        `${name} differs between the JS and Python identity modules`,
      ).toBe(value);
    }
  });
});

describe("imageFetchHeaders", () => {
  it("always sends a User-Agent and an Accept", () => {
    const h = identity.imageFetchHeaders("met");
    expect(h["User-Agent"]).toBe(identity.USER_AGENT);
    // Some institutional WAFs read a missing Accept as a scraper.
    expect(h.Accept).toContain("image/");
  });

  it("switches to the Wikimedia string for commons", () => {
    expect(identity.imageFetchHeaders("commons")["User-Agent"]).toBe(
      identity.WIKIMEDIA_USER_AGENT,
    );
  });

  it("falls back to the base identity for an unknown source", () => {
    expect(identity.imageFetchHeaders("some-new-museum")["User-Agent"]).toBe(
      identity.USER_AGENT,
    );
    expect(identity.imageFetchHeaders(undefined)["User-Agent"]).toBe(
      identity.USER_AGENT,
    );
  });
});

describe("the proxy actually uses it", () => {
  const proxy = readFileSync(
    path.join(__dirname, "../lib/img-transform.ts"),
    "utf8",
  );

  it("passes headers on the origin fetch", () => {
    expect(proxy).toMatch(/headers:\s*identity\.imageFetchHeaders\(source\)/);
    // Checked by pulling the call itself rather than pattern-matching the
    // whole file, since a loose negative regex would match the corrected
    // code too.
    const call = proxy.slice(
      proxy.indexOf("await fetch(url"),
      proxy.indexOf("await fetch(url") + 220,
    );
    expect(call, "the origin fetch sends no headers").toContain("headers:");
  });

  it("defines fetchOrigin exactly once", () => {
    // It was defined twice, identically -- harmless by luck, but the next
    // edit could have changed the dead copy.
    expect(proxy.match(/async function fetchOrigin\s*\(/g)).toHaveLength(1);
  });
});
