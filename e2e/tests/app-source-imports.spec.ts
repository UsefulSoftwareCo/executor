/** Source that strict TypeScript accepts also deploys: NodeNext imports and npm package subpaths. */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { Evidence } from "../support/evidence.ts";
import { withApps, mcpSdkVersion } from "../support/apps-release.ts";

// NodeNext requires `.js` specifiers for TypeScript sources, from the server and the UI alike.
const files = [
  {
    path: "package.json",
    content: JSON.stringify({
      dependencies: withApps({ "@modelcontextprotocol/sdk": mcpSdkVersion }),
    }),
  },
  {
    path: "index.ts",
    content: `import { defineApp, object, query, router, string } from "apps";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { greeting } from "./lib/greeting.js";
export default defineApp({ accounts: {} }, {
  tools: router({
    greet: query({ input: object({ name: string() }) }, async (_ctx, input) => greeting(input.name)),
    client: query({ input: object({}) }, async () => {
      const client = new Client({ name: "fixture", version: "1.0.0" });
      const transport = new StreamableHTTPClientTransport(new URL("https://mcp.example.invalid/mcp"));
      return { client: client instanceof Client, transport: typeof transport.start };
    }),
  }),
});`,
  },
  {
    path: "lib/greeting.ts",
    content: `import { salutation } from "../provider.js";
export const greeting = (name: string) => \`\${salutation}, \${name}\`;`,
  },
  { path: "provider.ts", content: `export const salutation = "Hello";` },
  {
    path: "ui/index.html",
    content:
      '<!doctype html><html><body><p role="status"></p><script type="module" src="./main.ts"></script></body></html>',
  },
  {
    path: "ui/main.ts",
    content: `import { label } from "./label.js";
document.querySelector("[role=status]")!.textContent = label;`,
  },
  { path: "ui/label.ts", content: `export const label = "Ready";` },
];

layer(HostedLive, { excludeTestServices: true })("App source imports", (it) => {
  it.effect(scenarios.appSourceImports.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          evidence = yield* Evidence;
        const prefix = `/api/organizations/${actors.organization.id}/apps`;
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/deploy`, {
          name: `Source imports ${randomUUID().slice(0, 8)}`,
          files,
        });
        yield* evidence.json("deploy.json", deployed.body);
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const app = yield* body(App, deployed);
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/${app.id}`).pipe(Effect.orDie),
        );
        const call = (tool: string, input: object) =>
          api.request(actors.owner, "POST", `${prefix}/${app.id}/tools/call`, {
            tool,
            kind: "query",
            input,
          });

        // `./lib/greeting.js` and its `../provider.js` load the TypeScript files.
        expect(yield* body(Schema.String, yield* call("greet", { name: "Ada" }))).toBe(
          "Hello, Ada",
        );
        // Package subpath imports load those modules, not the package's main entry.
        expect(
          yield* body(
            Schema.Struct({ client: Schema.Boolean, transport: Schema.String }),
            yield* call("client", {}),
          ),
        ).toEqual({ client: true, transport: "function" });
      }),
    ),
  );
});
