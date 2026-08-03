import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@effect/vitest";

/**
 * The shell's theme must BE executor's theme.
 *
 * Artifacts render inside the console, so a shell that themes itself
 * independently is immediately visible as "not this product" — which is exactly
 * what the stock shadcn palette it shipped before did (a teal `--primary` in a
 * strictly grayscale app). The values therefore come from
 * `packages/react/src/styles/globals.css`, the app's own source of truth, which
 * `design.md` serializes.
 *
 * They are COPIED rather than imported, and this test is the price of that copy.
 * Importing is not available: the shell's stylesheet is compiled twice — once by
 * `vite.config.shell.ts`, and again in-browser by `@tailwindcss/browser` inside
 * the sandboxed frame, where a cross-package `@import` has no resolver and no
 * filesystem. So the copy is deliberate, and this pin makes the drift loud:
 * change a token in the app and this fails until the shell matches.
 *
 * Only the shared semantic tokens are pinned. The shell has no sidebar, and the
 * app has no chart palette or artifact container, so neither side is forced to
 * carry the other's surface.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const shellCss = readFileSync(path.join(here, "theme.css"), "utf-8");
const shellGlobalsCss = readFileSync(path.join(here, "globals.css"), "utf-8");
const appCss = readFileSync(path.join(here, "../../../../react/src/styles/globals.css"), "utf-8");

/** The tokens both stylesheets define, and that a model's UI actually renders
 *  against. `sidebar-*` and `scrollbar-*` are app chrome the shell has none of. */
const SHARED_TOKENS = [
  "background",
  "foreground",
  "card",
  "card-foreground",
  "popover",
  "popover-foreground",
  "primary",
  "primary-foreground",
  "secondary",
  "secondary-foreground",
  "muted",
  "muted-foreground",
  "accent",
  "accent-foreground",
  "destructive",
  "border",
  "input",
  "ring",
  "radius",
] as const;

/** The declarations inside the block a selector opens, by brace matching —
 *  `:root` and `.dark` both appear more than once across the media query, and a
 *  regex to the next `}` would stop at the first nested rule. */
const blockAfter = (css: string, from: number): string => {
  const open = css.indexOf("{", from);
  if (open === -1) return "";
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === "{") depth += 1;
    else if (css[i] === "}") {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  return "";
};

/** Every `--token: value` in the FIRST top-level block for `selector`, ignoring
 *  ones nested in a media query (which restate the same values). */
const tokensIn = (css: string, selector: string): Map<string, string> => {
  // A top-level occurrence is one at the start of a line with no leading
  // indentation — the media-query copies are indented.
  const match = new RegExp(`^${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{`, "m").exec(
    css,
  );
  const block = match ? blockAfter(css, match.index) : "";
  const tokens = new Map<string, string>();
  for (const declaration of block.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) {
    const name = declaration[1];
    const value = declaration[2];
    if (name && value) tokens.set(name, value.trim());
  }
  return tokens;
};

describe("shell theme tokens", () => {
  it("match the app's light theme", () => {
    const shell = tokensIn(shellCss, ":root");
    const app = tokensIn(appCss, ":root");
    for (const token of SHARED_TOKENS) {
      expect(shell.get(token), `--${token} (light)`).toBe(app.get(token));
    }
  });

  it("match the app's dark theme", () => {
    const shell = tokensIn(shellCss, ".dark");
    const app = tokensIn(appCss, ".dark");
    for (const token of SHARED_TOKENS) {
      if (token === "radius") continue; // declared once, on :root
      expect(shell.get(token), `--${token} (dark)`).toBe(app.get(token));
    }
  });

  it("keeps the shell's dark class and prefers-color-scheme block in agreement", () => {
    const darkClass = tokensIn(shellCss, ".dark");
    // The media-query copy is indented, so `tokensIn` skips it; find it directly.
    const media = /@media \(prefers-color-scheme: dark\) \{\s*:root \{([\s\S]*?)\n {2}\}/.exec(
      shellCss,
    );
    expect(media, "shell declares a prefers-color-scheme dark block").not.toBeNull();
    const mediaTokens = new Map<string, string>();
    for (const declaration of (media?.[1] ?? "").matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) {
      const name = declaration[1];
      const value = declaration[2];
      if (name && value) mediaTokens.set(name, value.trim());
    }
    for (const [name, value] of mediaTokens) {
      expect(darkClass.get(name), `--${name}`).toBe(value);
    }
  });

  it("carries an ordered eight-slot chart palette in both themes", () => {
    const light = tokensIn(shellCss, ":root");
    const dark = tokensIn(shellCss, ".dark");
    for (let slot = 1; slot <= 8; slot += 1) {
      expect(light.get(`chart-${slot}`), `--chart-${slot} (light)`).toMatch(/^#[0-9a-f]{6}$/);
      expect(dark.get(`chart-${slot}`), `--chart-${slot} (dark)`).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("holds the chart palette to the system's restraint", () => {
    // No neon. A saturated series color competes with the numbers it labels and
    // reads as a different product; the ceiling here is what keeps "muted" from
    // drifting back to a stock fully-saturated ramp on the next edit. HSL
    // saturation, because that is the axis "muted" actually names — for
    // reference, the palette tops out around 0.54 where a typical vivid chart
    // ramp sits between 0.68 and 1.0.
    const saturation = (hex: string): number => {
      const [r, g, b] = [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16) / 255);
      const max = Math.max(r!, g!, b!);
      const min = Math.min(r!, g!, b!);
      const lightness = (max + min) / 2;
      if (max === min) return 0;
      return lightness > 0.5 ? (max - min) / (2 - max - min) : (max - min) / (max + min);
    };

    for (const selector of [":root", ".dark"]) {
      const tokens = tokensIn(shellCss, selector);
      for (let slot = 1; slot <= 8; slot += 1) {
        const value = tokens.get(`chart-${slot}`) ?? "";
        expect(saturation(value), `--chart-${slot} in ${selector} is desaturated`).toBeLessThan(
          0.6,
        );
      }
    }
  });

  it("leads the palette with a neutral, so a single-series chart stays grayscale", () => {
    for (const selector of [":root", ".dark"]) {
      const value = tokensIn(shellCss, selector).get("chart-1") ?? "";
      const [r, g, b] = [1, 3, 5].map((at) => Number.parseInt(value.slice(at, at + 2), 16));
      expect(Math.max(r!, g!, b!) - Math.min(r!, g!, b!), `--chart-1 in ${selector}`).toBe(0);
    }
  });

  it("sets Geist as the shell's own type, from inlined faces", () => {
    expect(shellCss).toMatch(/--font-sans:\s*"Geist"/);
    expect(shellCss).toMatch(/--font-mono:\s*"Geist Mono"/);
    // Referenced as a local asset: a remote URL would be blocked by the inner
    // frame's `font-src data:` and silently fall back to system-ui.
    expect(shellGlobalsCss).toMatch(/url\("\.\/fonts\/geist-sans\.woff2"\)/);
    expect(shellGlobalsCss).toMatch(/url\("\.\/fonts\/geist-mono\.woff2"\)/);
    expect(shellGlobalsCss).not.toMatch(/fonts\.googleapis\.com|fonts\.gstatic\.com/);
  });

  // The theme is SHIPPED to the inner frame as source, so anything the frame's
  // Tailwind compiler cannot resolve has to stay out of it. `@font-face` is the
  // trap: its `url()` is rewritten to a `data:` URL by the build, and the frame
  // has neither a bundler nor a filesystem to do that with — so the faces live
  // in `globals.css` and only the tokens travel.
  it("keeps build-resolved CSS out of the shared theme source", () => {
    // Comments are stripped first: this file's own header explains the rule by
    // naming the at-rules it forbids, which would otherwise match.
    const declarations = shellCss.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(declarations).not.toMatch(/@font-face/);
    expect(declarations).not.toMatch(/@source/);
    expect(declarations).not.toMatch(/url\(/);
    expect(shellGlobalsCss).toMatch(/@import "\.\/theme\.css"/);
  });
});
