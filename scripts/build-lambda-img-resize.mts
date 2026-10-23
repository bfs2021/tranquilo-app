// Bundles lambda/img-resize/handler.ts into build/lambda-img-resize.zip for
// a Node.js arm64 Lambda. Upload the zip to S3 and point the
// lambda/img-resize/template.yaml stack's CodeKey at it.
//
// sharp stays external: its native binary must be the linux-arm64 build,
// not the one installed for this machine.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, "build", "lambda-img-resize");
const ZIP_PATH = path.join(ROOT, "build", "lambda-img-resize.zip");

function sharpVersion(): string {
  const pkg = JSON.parse(
    fs.readFileSync(
      path.join(ROOT, "node_modules", "sharp", "package.json"),
      "utf8",
    ),
  );
  return pkg.version;
}

function run(cmd: string, args: string[], cwd: string) {
  execFileSync(cmd, args, { cwd, stdio: "inherit" });
}

fs.rmSync(OUT_DIR, { recursive: true, force: true });
fs.rmSync(ZIP_PATH, { force: true });
fs.mkdirSync(OUT_DIR, { recursive: true });

run("bun", ["run", "generate-config"], ROOT);

run(
  "bun",
  [
    "build",
    path.join(ROOT, "lambda", "img-resize", "handler.ts"),
    "--outdir",
    OUT_DIR,
    "--entry-naming",
    "index.mjs",
    "--target=node",
    "--format=esm",
    "--external=sharp",
    "--sourcemap=linked",
  ],
  ROOT,
);

fs.writeFileSync(
  path.join(OUT_DIR, "package.json"),
  `${JSON.stringify(
    {
      name: "lambda-img-resize",
      private: true,
      type: "module",
      dependencies: { sharp: sharpVersion() },
    },
    null,
    2,
  )}\n`,
);
run(
  "bun",
  ["install", "--production", "--os=linux", "--cpu=arm64", "--no-save"],
  OUT_DIR,
);

if (!fs.existsSync(path.join(OUT_DIR, "index.mjs"))) {
  console.error(`missing ${OUT_DIR}/index.mjs: the bundle was not written`);
  process.exit(1);
}

const linuxBinary = path.join(
  OUT_DIR,
  "node_modules",
  "@img",
  "sharp-linux-arm64",
);
if (!fs.existsSync(linuxBinary)) {
  console.error(`missing ${linuxBinary}: sharp would fail to load on Lambda`);
  process.exit(1);
}

run("zip", ["-qr", ZIP_PATH, "."], OUT_DIR);
const mb = (fs.statSync(ZIP_PATH).size / 1024 / 1024).toFixed(1);
console.log(`wrote ${path.relative(ROOT, ZIP_PATH)} (${mb} MB)`);
