// vitest  -> tests/*.test.ts        offline, no DOM, no network
// playwright -> tests/e2e/*.spec.mts  real browser, stubbed backend
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/e2e/**", "node_modules/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "json-summary", "lcov"],
      include: ["api/**", "lib/**", "lambda/**", "src/**", "scripts/**"],
      exclude: [
        "**/*.d.ts",
        "src/data/config.generated.ts",
        "tests/**",
      ],
      // Per-directory, not a single blended number: a blended floor would
      // be nearly meaningless here. src/ (~20%) is mostly covered by the
      // e2e suite instead of unit tests by design (real DOM behavior), and
      // scripts/ (~1.6%) is one-off operational tooling -- folding either
      // into one global threshold would mean a real lib/ or api/
      // regression barely moves a number already dragged down by files
      // that were never meant to hit high unit coverage. Set just below
      // the measured baseline (lib/ 63.8%, api/ 28.2%, 2026-10-12) so this
      // starts as a real regression floor, not a target to chase -- raise
      // it deliberately as coverage improves, don't let it drift down.
      thresholds: {
        "lib/**": {
          statements: 60,
          branches: 60,
          functions: 60,
          lines: 60,
        },
        "api/**": {
          statements: 25,
          branches: 25,
          functions: 25,
          lines: 25,
        },
      },
    },
  },
});
