import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const fixtureDir = dirname(fileURLToPath(import.meta.url));

const run = (cwd: string, args: readonly string[], stdin?: string): string => {
  const proc = Bun.spawnSync({
    cmd: ["git", ...args],
    cwd,
    stdin: stdin ? new TextEncoder().encode(stdin) : undefined,
  });
  if (!proc.success) {
    throw new Error(
      `git ${args.join(" ")} failed\n${proc.stderr.toString()}\n${proc.stdout.toString()}`,
    );
  }
  return proc.stdout.toString().trim();
};

const write = async (root: string, path: string, body: string) => {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), body);
};

const packageJson = JSON.stringify({ dependencies: { effect: "4.0.0-beta.59", zod: "4.3.6" } });
const executorJson = JSON.stringify({ description: "Custom tools e2e fixture" });

const echoTool = `import { z } from "zod";
import { defineTool, integration } from "executor:app";

export default defineTool({
  description: "Echo a message through a projected app connection.",
  integrations: { apps: integration("repo") },
  input: z.object({ message: z.string() }),
  output: {
    type: "object",
    properties: { message: { type: "string" }, version: { type: "string" } },
    required: ["message", "version"],
  },
  annotations: { readOnly: true },
  async handler(input) {
    return { message: input.message, version: "v1" };
  },
});
`;

const staticTool = `import { defineTool } from "executor:app";

export default defineTool({
  description: "Return a static fixture marker.",
  input: { type: "object", properties: {} },
  output: {
    type: "object",
    properties: { ok: { type: "boolean" } },
    required: ["ok"],
  },
  annotations: { readOnly: true },
  async handler() {
    return { ok: true };
  },
});
`;

const effectTool = `import { Effect } from "effect";
import { defineTool } from "executor:app";

export default defineTool({
  description: "Return a marker produced through Effect.",
  input: { type: "object", properties: {} },
  output: {
    type: "object",
    properties: { ok: { type: "boolean" }, dependency: { type: "string" } },
    required: ["ok", "dependency"],
  },
  annotations: { readOnly: true },
  async handler() {
    return Effect.runSync(Effect.succeed({ ok: true, dependency: "effect" }));
  },
});
`;

const extraTool = `import { defineTool } from "executor:app";

export default defineTool({
  description: "Return a second static fixture marker.",
  input: { type: "object", properties: {} },
  output: {
    type: "object",
    properties: { added: { type: "boolean" } },
    required: ["added"],
  },
  annotations: { readOnly: true },
  async handler() {
    return { added: true };
  },
});
`;

const badCollectTool = `import { defineTool } from "executor:app";

const input = { type: "object", properties: {} };

export default {
  "bad-collect": defineTool({
    description: "Trigger a collect-stage fixture failure.",
    input,
    async handler() {
      return { ok: true };
    },
  }),
};
`;

const commit = (root: string, message: string): string => {
  run(root, ["add", "."]);
  run(root, ["commit", "-q", "-m", message]);
  return run(root, ["rev-parse", "HEAD"]);
};

const pack = async (root: string, sha: string, name: string) => {
  const proc = Bun.spawnSync({
    cmd: ["git", "pack-objects", "--stdout", "--revs"],
    cwd: root,
    stdin: new TextEncoder().encode(`${sha}\n`),
  });
  if (!proc.success) throw new Error(`git pack-objects failed: ${proc.stderr.toString()}`);
  await writeFile(join(fixtureDir, name), proc.stdout);
};

const root = await mkdtemp(join(tmpdir(), "custom-tools-git-"));
try {
  run(root, ["init", "-q"]);
  run(root, ["config", "user.name", "Fixture Generator"]);
  run(root, ["config", "user.email", "fixture@example.test"]);

  await write(root, "executor.json", executorJson);
  await write(root, "package.json", packageJson);
  await write(root, "bun.lock", "");
  await write(root, "tools/echo-tool.ts", echoTool);
  await write(root, "tools/static-tool.ts", staticTool);
  await write(root, "tools/effect-tool.ts", effectTool);
  const sha1 = commit(root, "custom tools v1");

  await write(root, "tools/extra-tool.ts", extraTool);
  const sha2 = commit(root, "custom tools v2");

  await write(root, "tools/bad-collect.ts", badCollectTool);
  const sha3 = commit(root, "custom tools v3");

  await writeFile(join(fixtureDir, "custom-tools-shas.txt"), `${sha1}\n${sha2}\n${sha3}\n`);
  await pack(root, sha1, "custom-tools-v1.pack");
  await pack(root, sha2, "custom-tools-v2.pack");
  await pack(root, sha3, "custom-tools-v3.pack");
} finally {
  await rm(root, { recursive: true, force: true });
}
