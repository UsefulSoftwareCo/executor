/** Exercise the actual npm tarball from a clean consumer outside the workspace. Never publishes. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const artifacts = fileURLToPath(new URL("../../../.local/apps-package/", import.meta.url));
await mkdir(artifacts, { recursive: true });
const run = (command, args, cwd) =>
  execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const [packed] = JSON.parse(
  run("npm", ["pack", "./dist", "--json", "--pack-destination", artifacts], root),
);
const archive = join(artifacts, packed.filename);
const manifest = JSON.parse(await readFile(join(root, "dist/package.json"), "utf8"));
assert.equal(manifest.publishConfig.tag, "beta");
assert.match(manifest.version, /^0\.0\.\d+-beta\.\d+$/);
assert(!JSON.stringify(manifest).includes("workspace:"));
assert(
  packed.files.every(({ path }) => !path.startsWith("src/") && !path.includes("node_modules/")),
);
const consumer = await mkdtemp(join(tmpdir(), "apps-consumer-"));
try {
  await writeFile(
    join(consumer, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  );
  run(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--save-exact",
      archive,
      "typescript@5.9.3",
      "@types/node@26.6.1",
    ],
    consumer,
  );
  const example = `import assert from "node:assert/strict";
import { defineApp, object, query, string, defineDatabase, table } from "apps";
import { createAppHandler, hostContext } from "apps/host";
const greet = query({ input: object({ name: string() }) }, async (_ctx, input) => ({ message: "Hello " + input.name }));
const app = defineApp({ accounts: {} }, { queries: { greet } });
const handler = createAppHandler(app);
const response = await handler(new Request("https://fixture.test", { method: "POST", body: JSON.stringify({ operation: "call", tool: "queries.greet", input: { name: "Ada" } }) }), hostContext({}));
assert.equal(response.status, 200);
assert.deepEqual(await response.json(), { ok: true, value: { message: "Hello Ada" } });
assert(defineDatabase({ notes: table({ text: string() }) }));
`;
  await writeFile(join(consumer, "example.mjs"), example);
  run("node", ["example.mjs"], consumer);
  await writeFile(join(consumer, "root.ts"), example);
  run(
    "node",
    [
      "node_modules/typescript/bin/tsc",
      "--noEmit",
      "--strict",
      "--target",
      "ES2022",
      "--module",
      "NodeNext",
      "root.ts",
    ],
    consumer,
  );
  console.log("Root, host, schemas and storage run and typecheck without optional peers.");
  run(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "@types/react@19.2.0",
      "react@19.2.0",
      "graphql@16.11.0",
      "@modelcontextprotocol/sdk@1.30.0",
    ],
    consumer,
  );
  const imports = Object.keys(manifest.exports)
    .filter((key) => !key.endsWith(".json"))
    .map((key) => (key === "." ? "apps" : "apps" + key.slice(1)));
  await writeFile(
    join(consumer, "exports.mjs"),
    imports.map((specifier) => `await import(${JSON.stringify(specifier)});`).join("\n"),
  );
  run("node", ["exports.mjs"], consumer);
  await writeFile(
    join(consumer, "example.ts"),
    `import { defineApp, object, query, string, defineDatabase, table, type QueryContext } from "apps";
const requirements = { accounts: {}, database: defineDatabase({ notes: table({ text: string() }) }) };
const greet = query({ input: object({ name: string() }) }, async (_ctx: QueryContext<typeof requirements>, input) => {
  const name: string = input.name;
  // @ts-expect-error The published declarations must preserve input inference.
  const wrong: number = input.name;
  return { message: name };
});
export default defineApp(requirements, { queries: { greet } });
${imports.map((specifier, i) => `import type * as Api${i} from ${JSON.stringify(specifier)}; export type Export${i} = typeof Api${i};`).join("\n")}
`,
  );
  for (const mode of ["NodeNext", "Bundler"]) {
    run(
      "node",
      [
        "node_modules/typescript/bin/tsc",
        "--noEmit",
        "--strict",
        "--skipLibCheck",
        "false",
        "--target",
        "ES2022",
        "--module",
        mode === "NodeNext" ? "NodeNext" : "ESNext",
        "--moduleResolution",
        mode,
        "example.ts",
      ],
      consumer,
    );
  }
  console.log(
    `All ${imports.length} entry points import; strict NodeNext and Bundler consumers typecheck.`,
  );
  // Test the publish guard directly. This does not contact npm or publish.
  execFileSync("node", ["check-publish.mjs"], {
    cwd: join(root, "dist"),
    env: { ...process.env, npm_config_tag: "beta" },
  });
  assert.throws(() =>
    execFileSync("node", ["check-publish.mjs"], {
      cwd: join(root, "dist"),
      env: { ...process.env, npm_config_tag: "latest" },
      stdio: "pipe",
    }),
  );
  console.log(`Verified ${archive}; latest publishing is rejected. Nothing was published.`);
} finally {
  await rm(consumer, { recursive: true, force: true });
}
