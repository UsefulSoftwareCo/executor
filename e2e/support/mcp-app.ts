/** Synthetic app fixture deployed and removed through the running product's public API. */
import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { randomUUID } from "node:crypto";
import { Actors } from "./actors.ts";
import { Api, body } from "./api.ts";
import { App } from "./contracts.ts";
import { Evidence } from "./evidence.ts";

/** The receipt is absent from client prompts and tool schemas, so only a real invocation reveals it. */
export const deployMcpApp = Effect.gen(function* () {
  const api = yield* Api,
    actors = yield* Actors,
    evidence = yield* Evidence;
  const prefix = `/api/organizations/${actors.organization.id}`;
  const name = `MCP evidence ${randomUUID().slice(0, 8)}`,
    receipt = randomUUID();
  const response = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
    name,
    files: [
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
    ],
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
