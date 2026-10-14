/** Account descriptions through the public account API and the MCP tool catalog agents search. */
import { expect, layer } from "@effect/vitest";
import { Effect, Redacted, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Api, body, type Session } from "../support/api.ts";
import { TestLive, withCase } from "../support/case.ts";
import { McpClient } from "../support/mcp-client.ts";
import { Target } from "../support/platform.ts";
import { connectLocalAccount } from "../support/app-accounts.ts";
import { localLinks } from "../support/local-links.ts";
import { scenarios } from "../test-plan.ts";
import { appsManifest } from "../support/apps-release.ts";

const Deployed = Schema.Struct({
  app: Schema.Struct({
    id: Schema.String,
    slug: Schema.String,
    requirements: Schema.Struct({
      accounts: Schema.Struct({ service: Schema.Struct({ provider: Schema.String }) }),
    }),
  }),
});
const Account = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  description: Schema.NullOr(Schema.String),
});
const Executed = Schema.Struct({
  execution: Schema.Struct({
    ok: Schema.Literal(true),
    value: Schema.Struct({
      found: Schema.Struct({
        items: Schema.Array(Schema.Struct({ path: Schema.String, description: Schema.String })),
        namespaces: Schema.Array(
          Schema.Struct({ path: Schema.String, accounts: Schema.optional(Schema.String) }),
        ),
      }),
      described: Schema.Struct({
        items: Schema.Array(Schema.Struct({ path: Schema.String, signature: Schema.String })),
      }),
    }),
  }),
});

layer(TestLive, { excludeTestServices: true })("Local account descriptions", (it) => {
  it.effect(scenarios.localAccountDescriptions.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          target = yield* Target,
          mcp = yield* McpClient,
          session = yield* api.session();
        const headers = { authorization: `Bearer ${Redacted.value(target.apiKey)}` };
        const agent: Session = {
          ...session,
          send: (method, path, data, extra = {}) => {
            const { origin: _origin, ...rest } = extra;
            return session.send(method, path, data, { ...rest, ...headers });
          },
        };
        const deployed = yield* body(
          Deployed,
          yield* agent.send("POST", "/v1/apps/deploy", {
            owner: "local",
            name: `Described ${randomUUID().slice(0, 8)}`,
            files: [
              {
                path: "index.ts",
                content: `
import { defineApp, defineProvider, object, query, router, secrets, string } from "apps";
const service = defineProvider({ name: "Described fixture", auth: {
  key: secrets({ label: "API key", fields: object({ token: string() }) })
} });
export default defineApp({ user: { accounts: { service } } }, async () => ({ tools: router({
  records: query({ input: object({}), description: "List described fixture records" }, async () => []),
}) }));
`,
              },
              appsManifest,
            ],
          }),
        );
        const { app } = deployed;
        const accounts: string[] = [];
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            expect((yield* agent.send("DELETE", `/v1/apps/${app.id}`)).status).toBe(200);
            for (const account of accounts)
              expect((yield* agent.send("DELETE", `/v1/accounts/${account}`)).status).toBe(200);
          }).pipe(Effect.orDie),
        );

        // Connecting from the app links the account, replacing the one linked before; both stay
        // saved. Work key, connected last, is the one the app uses.
        const connect = (label: string, token: string) =>
          connectLocalAccount(
            agent,
            {
              app: app.id,
              requirement: "service",
              method: "key",
              label,
              fields: { token },
            },
            headers,
          ).pipe(Effect.tap((account) => Effect.sync(() => accounts.push(account.id))));
        const undescribed = yield* connect("Sandbox key", "synthetic-sandbox-token");
        expect(undescribed.description).toBeNull();
        const connected = yield* connect("Work key", "synthetic-description-token");
        expect(connected.description).toBeNull();
        expect(yield* localLinks(agent, app.id)).toEqual([connected.id]);

        // A description is returned with the account's metadata once set.
        const created = yield* body(
          Account,
          yield* agent.send("PATCH", `/v1/accounts/${connected.id}`, {
            description: "Reads only;\n  use the sandbox account for writes.",
          }),
        );
        expect(created).toEqual({
          id: connected.id,
          label: "Work key",
          description: "Reads only;\n  use the sandbox account for writes.",
        });
        const listed = yield* body(
          Schema.Array(Account),
          yield* agent.send(
            "GET",
            `/v1/accounts?owner=local&provider=${encodeURIComponent(app.requirements.accounts.service.provider)}`,
          ),
        );
        expect(listed.map(({ id, description }) => ({ id, description }))).toEqual(
          expect.arrayContaining([
            { id: created.id, description: "Reads only;\n  use the sandbox account for writes." },
            { id: undescribed.id, description: null },
          ]),
        );

        // Agents read the linked account's ID, label and description once, with the app's
        // namespace. Calls cannot choose accounts, so signatures name none; the saved account
        // the app does not use is not listed.
        const client = yield* mcp.connect(target.apiKey, "local-account-descriptions");
        const searched = (step: string) =>
          client
            .use(step, (client, signal) =>
              client.callTool(
                {
                  name: "execute",
                  arguments: {
                    code: `const found = await tools.search({ query: "List described fixture records", namespace: ${JSON.stringify(app.slug)} });
return { found, described: await tools.search.describe({ paths: found.items.map((item) => item.path) }) };`,
                  },
                },
                undefined,
                { signal },
              ),
            )
            .pipe(
              Effect.flatMap((result) =>
                Schema.decodeUnknownEffect(Executed)(result.structuredContent),
              ),
              Effect.map(({ execution }) => {
                const { found, described } = execution.value;
                const item = found.items.find((item) => item.path.endsWith(".records"));
                return {
                  description: item?.description,
                  signature: described.items.find((described) => described.path === item?.path)
                    ?.signature,
                  namespace: found.namespaces.find(
                    (namespace) => item !== undefined && item.path.startsWith(`${namespace.path}.`),
                  ),
                };
              }),
            );
        const described = yield* searched("Search with a described account");
        expect(described.description).toBe("List described fixture records");
        expect(described.namespace?.accounts).toBe(
          `service: ${created.id} (Work key: Reads only; use the sandbox account for writes.)`,
        );
        expect(described.signature).toBeDefined();
        for (const absent of [created.id, undescribed.id, "$accounts"])
          expect(described.signature).not.toContain(absent);

        // Renaming keeps the description; the agent reads the new label with it.
        const renamed = yield* body(
          Account,
          yield* agent.send("PATCH", `/v1/accounts/${created.id}`, { label: "Production key" }),
        );
        expect(renamed).toEqual({
          id: created.id,
          label: "Production key",
          description: "Reads only;\n  use the sandbox account for writes.",
        });
        const renamedTool = yield* searched("Search after renaming");
        expect(renamedTool.namespace?.accounts).toBe(
          `service: ${created.id} (Production key: Reads only; use the sandbox account for writes.)`,
        );

        // A null description removes it; the label stays and agents see no description.
        const cleared = yield* body(
          Account,
          yield* agent.send("PATCH", `/v1/accounts/${created.id}`, { description: null }),
        );
        expect(cleared).toEqual({ id: created.id, label: "Production key", description: null });
        const read = yield* body(Account, yield* agent.send("GET", `/v1/accounts/${created.id}`));
        expect(read.description).toBeNull();
        const plain = yield* searched("Search after clearing the description");
        expect(plain.description).toBe("List described fixture records");
        expect(plain.namespace?.accounts).toBe(`service: ${created.id} (Production key)`);
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );
});
