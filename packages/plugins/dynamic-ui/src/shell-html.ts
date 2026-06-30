let shellHtmlCache: string | undefined;

export const loadDynamicUiShellHtml = async (): Promise<string> => {
  if (shellHtmlCache) return shellHtmlCache;

  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: optional prebuilt shell asset is loaded from local filesystem when present
  try {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const candidates = [
      // `bun build --compile` can't bundle this runtime `fs.readFile`, so the
      // binary build (apps/cli/src/build.ts) copies `mcp-app.html` next to the
      // executable. We find it via `process.execPath`, the same colocation
      // trick native-bindings.ts uses for `libsql.node` / `keyring.node`.
      path.join(path.dirname(process.execPath), "mcp-app.html"),
      // Dev / package-resolved (`bun run`, vitest): the package's own dist.
      path.join(import.meta.dirname, "../dist/mcp-app.html"),
      path.join(import.meta.dirname, "../../dist/mcp-app.html"),
    ];

    for (const candidate of candidates) {
      // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: try each possible emitted shell path before falling back
      try {
        shellHtmlCache = await fs.readFile(candidate, "utf-8");
        return shellHtmlCache;
      } catch {
        // Try the next candidate path.
      }
    }
  } catch {
    // Fall through to the development fallback below.
  }

  shellHtmlCache =
    "<!doctype html><html><body><p>Shell not built. Run: bun run --cwd packages/plugins/dynamic-ui build:shell</p></body></html>";
  return shellHtmlCache;
};
