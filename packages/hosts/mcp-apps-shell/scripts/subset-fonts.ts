/**
 * Re-subset the vendored Geist / Geist Mono woff2 files from the published
 * `geist` package.
 *
 * The shell inlines these as `data:` URLs (the inner frame's CSP is
 * `font-src data:`), so their size lands directly in the single-file shell
 * document — hence subsetting rather than shipping the full faces. Run this
 * only to pick up a new upstream Geist release; the output is committed.
 *
 * Needs `uv` (fontTools is fetched on demand, nothing is installed globally).
 */

import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const GEIST_VERSION = "1.7.2";

/** Latin-1 plus the punctuation, arrows and symbols dashboards actually render
 *  (deltas, bullets, ellipses, currency). Anything outside this falls back to
 *  the system stack, which is the right trade for a 4.5 MB inlined document. */
const UNICODES = [
  "U+0000-00FF",
  "U+0131",
  "U+0152-0153",
  "U+02BB-02BC",
  "U+02C6",
  "U+02DA",
  "U+02DC",
  "U+2000-206F",
  "U+2074",
  "U+20AC",
  "U+2122",
  "U+2190",
  "U+2191",
  "U+2192",
  "U+2193",
  "U+2212",
  "U+2215",
  "U+2022",
  "U+25CF",
  "U+FEFF",
  "U+FFFD",
].join(",");

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fontsDir = path.join(packageRoot, "src/shell/fonts");
const workDir = path.join(packageRoot, ".fonts-work");

const run = async (cmd: string[], cwd: string): Promise<void> => {
  const proc = Bun.spawn(cmd, { cwd, stdout: "inherit", stderr: "inherit" });
  const code = await proc.exited;
  if (code !== 0) {
    // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: a build script reports failure by exiting non-zero
    throw new Error(`${cmd.join(" ")} exited ${code}`);
  }
};

await rm(workDir, { recursive: true, force: true });
await mkdir(workDir, { recursive: true });
await mkdir(fontsDir, { recursive: true });

await run(
  ["sh", "-c", `curl -sL https://registry.npmjs.org/geist/-/geist-${GEIST_VERSION}.tgz | tar xz`],
  workDir,
);

const subset = (source: string, output: string): Promise<void> =>
  run(
    [
      "uv",
      "run",
      "--quiet",
      "--with",
      "fonttools[woff]",
      "--with",
      "brotli",
      "pyftsubset",
      path.join(workDir, "package/dist/fonts", source),
      "--flavor=woff2",
      "--layout-features=kern,liga,calt,tnum",
      `--unicodes=${UNICODES}`,
      `--output-file=${path.join(fontsDir, output)}`,
    ],
    workDir,
  );

await subset("geist-sans/Geist-Variable.woff2", "geist-sans.woff2");
await subset("geist-mono/GeistMono-Variable.woff2", "geist-mono.woff2");

await rm(workDir, { recursive: true, force: true });

for (const file of ["geist-sans.woff2", "geist-mono.woff2"]) {
  const size = (await Bun.file(path.join(fontsDir, file)).arrayBuffer()).byteLength;
  console.log(`${file}: ${(size / 1024).toFixed(1)} kB`);
}
