/** Synthetic app fixture deployed and removed through the running product's public API. */
import { expect } from "@effect/vitest";
import { Effect, Redacted, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Actors } from "./actors.ts";
import { Api, body } from "./api.ts";
import { App } from "./contracts.ts";
import { Evidence } from "./evidence.ts";
import { Target } from "./platform.ts";

/** The receipt is absent from client prompts and tool schemas, so only a real invocation reveals it. */
const mcpAppFiles = (name: string, receipt: string) => [
  {
    path: "skills/echo/SKILL.md",
    content:
      "---\nname: echo\ndescription: Echo a message through this app.\nallowed-tools: mutations.echo\n---\nRead [examples](references/examples.md).\n",
  },
  {
    path: "skills/echo/references/examples.md",
    content: "Call mutations.echo with a message.",
  },
  {
    path: "index.ts",
    content: `
import { mutation, defineApp, object, string } from "apps";
export default defineApp({ accounts: {} }, async () => ({  mutations: {
  echo: mutation({ description: ${JSON.stringify(`Echo from ${name}`)}, input: object({ message: string() })},
    async (_, input) => ({ message: input.message, receipt: ${JSON.stringify(receipt)} }))
} }));
`,
  },
];

/** Hosted apps belong to the synthetic organization. */
export const deployMcpApp = Effect.gen(function* () {
  const api = yield* Api,
    actors = yield* Actors,
    evidence = yield* Evidence;
  const prefix = `/api/organizations/${actors.organization.id}`;
  const name = `MCP evidence ${randomUUID().slice(0, 8)}`,
    receipt = randomUUID();
  const response = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
    name,
    files: mcpAppFiles(name, receipt),
  });
  yield* evidence.json("deployment.json", response);
  expect(response.status).toBe(200);
  const app = yield* body(App, response);
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      const removed = yield* api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`);
      yield* evidence.json("app-cleanup.json", { status: removed.status });
      expect(removed.status).toBe(200);
    }).pipe(Effect.orDie),
  );
  return { app, name, receipt };
});

/** Local has one operator, so the same app is deployed with the target's API key. */
export const deployLocalMcpApp = Effect.gen(function* () {
  const api = yield* Api,
    target = yield* Target,
    evidence = yield* Evidence,
    session = yield* api.session();
  const headers = { authorization: `Bearer ${Redacted.value(target.apiKey)}` };
  const name = `MCP evidence ${randomUUID().slice(0, 8)}`,
    receipt = randomUUID();
  const response = yield* session.send(
    "POST",
    "/v1/apps/deploy",
    { owner: "local", name, files: mcpAppFiles(name, receipt) },
    headers,
  );
  yield* evidence.json("deployment.json", response);
  expect(response.status).toBe(200);
  const { app } = yield* body(Schema.Struct({ app: App }), response);
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      const removed = yield* session.send("DELETE", `/v1/apps/${app.id}`, undefined, headers);
      yield* evidence.json("app-cleanup.json", { status: removed.status });
      expect(removed.status).toBe(200);
    }).pipe(Effect.orDie),
  );
  return { app, name, receipt };
});
