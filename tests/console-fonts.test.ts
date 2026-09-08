import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@effect/vitest";

// The console must paint without reaching any third-party host. A self-hosted
// deployment behind a restrictive network once sat blank until a synchronous
// Google Fonts stylesheet timed out, even though the app itself was healthy.
// The faces are vendored next to the shared stylesheet and declared once for every
// host; the entry documents carry no font links at all.

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const stylesDir = path.join(repoRoot, "packages/react/src/styles");
const globalsCss = readFileSync(path.join(stylesDir, "globals.css"), "utf-8");

const entryDocuments = [
  "apps/host-selfhost/web/index.html",
  "apps/host-cloudflare/web/index.html",
  "apps/cloud/src/routes/__root.tsx",
  "apps/desktop/src/renderer/index.html",
  "packages/app/index.html",
  "packages/onboarding-demo/index.html",
];

describe("console fonts", () => {
  it("declares Geist and Geist Mono from vendored files with swap display", () => {
    expect(globalsCss).toMatch(
      /@font-face\s*\{[^}]*font-family:\s*"Geist";[^}]*url\("\.\/fonts\/geist-sans\.woff2"\)[^}]*font-display:\s*swap;/,
    );
    expect(globalsCss).toMatch(
      /@font-face\s*\{[^}]*font-family:\s*"Geist Mono";[^}]*url\("\.\/fonts\/geist-mono\.woff2"\)[^}]*font-display:\s*swap;/,
    );
    for (const file of ["geist-sans.woff2", "geist-mono.woff2"]) {
      expect(readFileSync(path.join(stylesDir, "fonts", file)).byteLength, file).toBeGreaterThan(0);
    }
  });

  it("keeps every entry document free of third-party font hosts", () => {
    for (const relative of entryDocuments) {
      const source = readFileSync(path.join(repoRoot, relative), "utf-8");
      expect(source, relative).not.toMatch(/fonts\.googleapis\.com|fonts\.gstatic\.com/);
    }
  });
});
