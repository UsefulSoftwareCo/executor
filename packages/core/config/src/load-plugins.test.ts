import { describe, it, expect, beforeAll, afterAll } from "@effect/vitest";
import * as fs from "node:fs";
import * as path from "node:path";

import type { AnyPlugin } from "@executor-js/sdk";
import { loadPluginsFromJsonc } from "./load-plugins";

// Fixtures are generated under
// packages/core/config/__test-fixtures__/tmp/node_modules. The tmp jsonc
// files live beside that directory, so Node's `require.resolve` walks up
// from each config file and lands on these package-shaped test fixtures.
const FIXTURES_ROOT = path.resolve(__dirname, "..", "__test-fixtures__");
const TMP_ROOT = path.join(FIXTURES_ROOT, "tmp");
const FIXTURE_PACKAGES_ROOT = path.join(TMP_ROOT, "node_modules", "@loader-fixture");

// Single typed boundary for the loader's runtime-erased `AnyPlugin[]`:
// fixture plugins are hand-rolled JS objects whose extra fields (id,
// packageName, __optionsReceived) only matter to these tests, not to the
// loader. Centralising the bridge here keeps every assertion in the
// suite working off a precise type instead of repeating cast noise.
interface FixturePlugin {
  readonly id: string;
  readonly packageName: string;
  readonly __optionsReceived: Record<string, unknown> | null;
}

const asFixturePlugins = (plugins: readonly AnyPlugin[] | null): readonly FixturePlugin[] => {
  // Fixture servers return shapes wider than AnyPlugin (they carry
  // __optionsReceived for test assertions); narrow once here.
  // oxlint-disable-next-line executor/no-double-cast
  return plugins as unknown as readonly FixturePlugin[];
};

const writeJsonc = (name: string, body: string): string => {
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, `${name}-`));
  const file = path.join(dir, "executor.jsonc");
  fs.writeFileSync(file, body);
  return file;
};

const writeFixturePackage = (name: string, server: string): void => {
  const packageName = `@loader-fixture/${name}`;
  const dir = path.join(FIXTURE_PACKAGES_ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify(
      {
        name: packageName,
        version: "0.0.0",
        private: true,
        type: "module",
        exports: {
          "./server": "./server.js",
        },
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(path.join(dir, "server.js"), server);
};

const writeFixturePackages = (): void => {
  writeFixturePackage(
    "plugin-alpha",
    `export default (options) => ({
  id: "alpha",
  packageName: "@loader-fixture/plugin-alpha",
  __optionsReceived: options ?? null,
});
`,
  );
  writeFixturePackage(
    "plugin-beta",
    `export default (options) => ({
  id: "beta",
  packageName: "@loader-fixture/plugin-beta",
  __optionsReceived: options ?? null,
});
`,
  );
  writeFixturePackage("plugin-bad", `export default { not: "a function" };\n`);
};

beforeAll(() => {
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  writeFixturePackages();
});

afterAll(() => {
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
});

describe("loadPluginsFromJsonc", () => {
  it("returns null when the jsonc file does not exist", async () => {
    const plugins = await loadPluginsFromJsonc({
      path: path.join(TMP_ROOT, "nonexistent-config.jsonc"),
    });
    expect(plugins).toBeNull();
  });

  it("returns null when the file has no `plugins` key", async () => {
    const file = writeJsonc("no-plugins-key", `{ "name": "demo" }`);
    const plugins = await loadPluginsFromJsonc({ path: file });
    expect(plugins).toBeNull();
  });

  it("returns null for an empty plugins array", async () => {
    const file = writeJsonc("empty-plugins", `{ "plugins": [] }`);
    const plugins = await loadPluginsFromJsonc({ path: file });
    expect(plugins).toBeNull();
  });

  it("throws on JSONC parse errors", async () => {
    const file = writeJsonc("parse-error", `{ "plugins": [`);
    await expect(loadPluginsFromJsonc({ path: file })).rejects.toThrow(/failed to parse/i);
  });

  it("throws with a helpful message when the package can't be resolved", async () => {
    const file = writeJsonc(
      "unresolved",
      `{
        "plugins": [
          { "package": "@loader-fixture/does-not-exist" }
        ]
      }`,
    );
    await expect(loadPluginsFromJsonc({ path: file })).rejects.toThrow(
      /cannot resolve "@loader-fixture\/does-not-exist\/server"/,
    );
  });

  it("throws when the resolved module has no callable factory", async () => {
    const file = writeJsonc(
      "no-factory",
      `{
        "plugins": [
          { "package": "@loader-fixture/plugin-bad" }
        ]
      }`,
    );
    await expect(loadPluginsFromJsonc({ path: file })).rejects.toThrow(
      /did not export a default[\s\S]*definePlugin/,
    );
  });

  it("loads a plugin and exposes the package's id + packageName", async () => {
    const file = writeJsonc(
      "happy-path",
      `{
        "plugins": [
          { "package": "@loader-fixture/plugin-alpha" }
        ]
      }`,
    );
    const plugins = asFixturePlugins(await loadPluginsFromJsonc({ path: file }));
    expect(plugins).toHaveLength(1);
    expect(plugins[0]!.id).toBe("alpha");
    expect(plugins[0]!.packageName).toBe("@loader-fixture/plugin-alpha");
  });

  it("forwards merged deps + options to the factory; entry options win on conflict", async () => {
    const file = writeJsonc(
      "merge-options",
      `{
        "plugins": [
          {
            "package": "@loader-fixture/plugin-alpha",
            "options": { "from": "options", "shared": "options-wins" }
          }
        ]
      }`,
    );
    const plugins = asFixturePlugins(
      await loadPluginsFromJsonc({
        path: file,
        deps: { from: "deps", shared: "deps-loses", onlyDep: 42 },
      }),
    );
    expect(plugins[0]!.__optionsReceived).toEqual({
      from: "options",
      shared: "options-wins",
      onlyDep: 42,
    });
  });

  it("calls the factory with deps only when no options are declared", async () => {
    const file = writeJsonc(
      "deps-only",
      `{
        "plugins": [
          { "package": "@loader-fixture/plugin-alpha" }
        ]
      }`,
    );
    const plugins = asFixturePlugins(
      await loadPluginsFromJsonc({
        path: file,
        deps: { configFile: "stub-sink" },
      }),
    );
    expect(plugins[0]!.__optionsReceived).toEqual({ configFile: "stub-sink" });
  });

  it("loads multiple plugins in declared order", async () => {
    const file = writeJsonc(
      "ordered",
      `{
        "plugins": [
          { "package": "@loader-fixture/plugin-beta" },
          { "package": "@loader-fixture/plugin-alpha" }
        ]
      }`,
    );
    const plugins = asFixturePlugins(await loadPluginsFromJsonc({ path: file }));
    expect(plugins.map((p) => p.id)).toEqual(["beta", "alpha"]);
  });

  it("accepts line and block comments (jsonc semantics)", async () => {
    const file = writeJsonc(
      "jsonc-syntax",
      `{
        // pick the alpha fixture
        "plugins": [
          /* one entry */
          { "package": "@loader-fixture/plugin-alpha" }
        ]
      }`,
    );
    const plugins = await loadPluginsFromJsonc({ path: file });
    expect(plugins).toHaveLength(1);
  });
});
