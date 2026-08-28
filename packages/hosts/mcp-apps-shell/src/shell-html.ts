import { MCP_APPS_SHELL_STABLE_ASSET_PATH } from "./shell-asset-path";

let shellHtmlCache: string | undefined;

/**
 * The self-contained shell HTML served as the MCP-Apps `ui://` resource, read
 * from the local filesystem.
 *
 * Hosts inject this through `SharedMcpServerConfig.loadAppShellHtml` rather
 * than the MCP host package importing it directly: the shell drags React,
 * Recharts and Tailwind into whatever graph imports it, and the MCP host also
 * runs on Workers where none of that belongs.
 *
 * This loader is for hosts WITH a filesystem: the local CLI/desktop binary
 * (shell copied next to the executable by `apps/cli/src/build.ts`), dev runs
 * from the repo, and the self-host image (the stable-named copy its SPA build
 * emits into `dist/assets/`). Workers hosts use `makeAssetsShellHtmlLoader`
 * from `@executor-js/mcp-apps-shell/worker` instead — `fs.readFile` can never
 * succeed there.
 *
 * A missing shell REJECTS, deliberately. This used to degrade to a "Shell not
 * built" placeholder, which is the worst possible failure mode: the resource
 * read succeeds, the client loads an inert document that never starts the
 * MCP-Apps handshake, and every artifact spins on its loading state forever
 * with no error anywhere in the chain — which is exactly how production
 * served the placeholder unnoticed. A rejected read surfaces as a JSON-RPC
 * error naming the missing file and the command that produces it.
 */
export const loadMcpAppsShellHtml = async (): Promise<string> => {
  if (shellHtmlCache) return shellHtmlCache;

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
    // The self-host runtime image. Its server is bundled to
    // `apps/host-selfhost/dist-server/serve.js`, and the sibling `dist/` is
    // the SPA build, whose `mcpAppsShellAsset` emits the stable-named copy of
    // the shell into `dist/assets/`. The package-dist candidates above can't
    // hit there — the image carries no `packages/` tree at all.
    path.join(import.meta.dirname, "../dist", MCP_APPS_SHELL_STABLE_ASSET_PATH),
  ];

  for (const candidate of candidates) {
    // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: try each possible emitted shell path before failing
    try {
      shellHtmlCache = await fs.readFile(candidate, "utf-8");
      return shellHtmlCache;
    } catch {
      // Try the next candidate path.
    }
  }

  // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: a host without the built shell must fail the resource read loudly; a placeholder document hangs every MCP-Apps client silently
  throw new Error(
    "MCP-Apps shell document not found. Tried:\n" +
      candidates.map((candidate) => `  ${candidate}`).join("\n") +
      "\nBuild it with: bun run --cwd packages/hosts/mcp-apps-shell build:shell",
  );
};
