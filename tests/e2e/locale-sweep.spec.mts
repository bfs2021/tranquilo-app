// One pass over the main screens in whichever language the project's
// browser asks for (see playwright.config.mts: one project per shipped
// locale). Catches what a per-component test can't: a new screen shipping
// raw keys or leftover English, and translations long enough to run off a
// phone screen.
import { expect, type Page, test } from "@playwright/test";
import { matchLocale } from "../../src/i18n/core.ts";
import { DICTIONARIES } from "../../src/i18n/dictionaries.ts";
import { en } from "../../src/i18n/en.ts";
import { DEFAULT_LOCALE, LOCALES } from "../../src/i18n/locales.ts";
import { localizedPagePath, TRANSLATED_PAGES } from "../../src/i18n/pages.ts";
import {
  gotoArtwork,
  gotoFeed,
  gotoStoryline,
  ITEMS,
  STORYLINES,
} from "./harness.mts";

const KEYS = Object.keys(en);

// English UI text that a non-English screen shouldn't still show: strings
// the locale actually translates, long enough not to collide with artwork
// titles, cut at placeholders since those are filled at runtime.
function leftoverEnglish(locale: string): string[] {
  if (locale === DEFAULT_LOCALE) return [];
  const translated = DICTIONARIES[locale as keyof typeof DICTIONARIES] as
    | Record<string, string | undefined>
    | undefined;
  return Object.entries(en as Record<string, string>)
    .filter(([key, text]) => translated?.[key] && translated[key] !== text)
    .flatMap(([, text]) => text.split(/\{\w+\}/))
    .map((fragment) => fragment.trim())
    .filter((fragment) => fragment.length >= 20);
}

function expectedLocale(browserLocale: string | undefined): string {
  const shipped = LOCALES.filter((l) => l.status === "shipped");
  return (
    matchLocale(browserLocale ? [browserLocale] : [], shipped) ?? DEFAULT_LOCALE
  );
}

async function checkScreen(page: Page, screen: string, locale: string) {
  await expect(page.locator("html"), screen).toHaveAttribute("lang", locale);

  const { text, attributes } = await page.evaluate(() => {
    const attrs = ["aria-label", "placeholder", "title", "alt"];
    const values: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>("*")) {
      for (const a of attrs) {
        const v = el.getAttribute(a);
        if (v) values.push(v);
      }
    }
    return { text: document.body.innerText, attributes: values.join("\n") };
  });
  const shown = `${text}\n${attributes}`;

  const rawKeys = KEYS.filter((key) => shown.includes(key));
  expect.soft(rawKeys, `${screen}: raw message keys on screen`).toEqual([]);

  const english = leftoverEnglish(locale).filter((s) => text.includes(s));
  expect
    .soft(english, `${screen}: English UI text in a ${locale} session`)
    .toEqual([]);

  // Text that spills out of its box or crosses the screen edge. Checked
  // per element rather than as page overflow, since an overlay clips its
  // own. Rows that scroll only sideways (chips, shelves) are exempt,
  // judged by their content rather than CSS: a vertical scroller reports
  // overflow-x auto too. Deliberate ellipsis truncation is exempt as well.
  const offscreen = await page.evaluate(() => {
    const scrolls = (v: string) => v === "auto" || v === "scroll";
    const inSidewaysRow = (el: Element): boolean => {
      for (let p = el.parentElement; p; p = p.parentElement) {
        if (
          scrolls(getComputedStyle(p).overflowX) &&
          p.scrollWidth > p.clientWidth + 1 &&
          p.scrollHeight <= p.clientHeight + 1
        )
          return true;
      }
      return false;
    };
    const out: string[] = [];
    for (const el of document.body.querySelectorAll<HTMLElement>("*")) {
      const ownText = Array.from(el.childNodes)
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => n.textContent || "")
        .join("")
        .trim();
      if (!ownText) continue;
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      if (r.width <= 1 || r.height <= 1 || cs.visibility === "hidden") continue;
      if (r.bottom < 0 || r.top > window.innerHeight) continue;
      if (inSidewaysRow(el)) continue;
      const spills =
        el.clientWidth > 0 &&
        el.scrollWidth > el.clientWidth + 1 &&
        cs.textOverflow !== "ellipsis";
      const offEdge = r.left < -1 || r.right > window.innerWidth + 1;
      if (spills || offEdge)
        out.push(`${el.tagName.toLowerCase()} "${ownText.slice(0, 40)}"`);
    }
    return out;
  });
  expect.soft(offscreen, `${screen}: text runs off a phone screen`).toEqual([]);
}

test.describe("every main screen, in the browser's language", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("the feed and its overlays", async ({ page }, testInfo) => {
    const locale = expectedLocale(testInfo.project.use.locale);

    await gotoFeed(page);
    await checkScreen(page, "feed", locale);

    await page.locator("#searchToggle").click();
    await expect(page.locator("#searchBar")).toBeVisible();
    await checkScreen(page, "search", locale);
  });

  test("an artwork's detail panel and full-screen view", async ({
    page,
  }, testInfo) => {
    const locale = expectedLocale(testInfo.project.use.locale);
    const item = ITEMS[0];
    const slide = await gotoArtwork(page, item.source || "met", item.id);

    await slide.locator(".art-title-btn").click();
    await expect(page.locator("#detailModal")).toHaveClass(/open/);
    await checkScreen(page, "detail panel", locale);
    await page.keyboard.press("Escape");
    await expect(page.locator("#detailModal")).not.toHaveClass(/open/);

    await slide.locator(".art-frame").click({ position: { x: 12, y: 12 } });
    await expect(page.locator("#lightbox")).toHaveClass(/open/);
    await checkScreen(page, "full-screen view", locale);
  });

  test("Discover", async ({ page }, testInfo) => {
    const locale = expectedLocale(testInfo.project.use.locale);
    await gotoFeed(page);
    await page.locator("#discoverToggle").click();
    await expect(page.locator("#shelvesMode")).toHaveClass(/open/);
    await checkScreen(page, "Discover", locale);
  });

  test("a storyline", async ({ page }, testInfo) => {
    const locale = expectedLocale(testInfo.project.use.locale);
    await gotoStoryline(page, STORYLINES[0].id);
    await checkScreen(page, "storyline", locale);
  });

  test("the static pages", async ({ page }, testInfo) => {
    const locale = expectedLocale(testInfo.project.use.locale);
    const files =
      locale === DEFAULT_LOCALE
        ? [...new Set(Object.values(TRANSLATED_PAGES).flat())]
        : (TRANSLATED_PAGES[locale] ?? []);
    for (const file of files) {
      await page.goto(localizedPagePath(locale, file));
      await checkScreen(page, file, locale);
    }
  });
});
