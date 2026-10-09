/** Account descriptions through the public account API and the MCP tool catalog agents search. */
import { expect, layer } from "@effect/vitest";
import { Effect, Redacted, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Api, body, type Session } from "../support/api.ts";
import { TestLive, withCase } from "../support/case.ts";
import { McpClient } from "../support/mcp-client.ts";
import { Target } from "../support/platform.ts";
import { createProfile, selectProfileAccounts } from "../support/profiles.ts";
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
      items: Schema.Array(Schema.Struct({ path: Schema.String, description: Schema.String })),
      namespaces: Schema.Array(
        Schema.Struct({
          path: Schema.String,
          profile: Schema.optional(Schema.String),
          accounts: Schema.optional(Schema.String),
        }),
      ),
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
export default defineApp({ accounts: { service } }, async () => ({ tools: router({
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

        // A description is set when the account is created and returned with its metadata.
        const created = yield* body(
          Account,
          yield* agent.send("POST", "/v1/accounts", {
            owner: "local",
            provider: app.requirements.accounts.service.provider,
            method: "key",
            label: "Work key",
            description: "Reads only;\n  use the sandbox account for writes.",
            fields: { token: "synthetic-description-token" },
          }),
        );
        accounts.push(created.id);
        expect(created.description).toBe("Reads only;\n  use the sandbox account for writes.");
        const undescribed = yield* body(
          Account,
          yield* agent.send("POST", "/v1/accounts", {
            owner: "local",
            provider: app.requirements.accounts.service.provider,
            method: "key",
            label: "Sandbox key",
            fields: { token: "synthetic-sandbox-token" },
          }),
        );
        accounts.push(undescribed.id);
        expect(undescribed.description).toBeNull();
        const listed = yield* body(
          Schema.Array(Account),
          yield* agent.send(
            "GET",
            `/v1/accounts?provider=${encodeURIComponent(app.requirements.accounts.service.provider)}`,
          ),
        );
        expect(listed.map(({ id, description }) => ({ id, description }))).toEqual(
          expect.arrayContaining([
            { id: created.id, description: "Reads only;\n  use the sandbox account for writes." },
            { id: undescribed.id, description: null },
          ]),
        );

        const profile = yield* createProfile(
          agent,
          `/v1/apps/${app.id}`,
          { owner: "local", subject: "local" },
          headers,
        );
        const selected = yield* selectProfileAccounts(
          agent,
          `/v1/apps/${app.id}`,
          profile.id,
          { service: created.id },
          headers,
        );
        expect(selected.status).toBe(200);

        // Agents read the selected account's label and description once, with the profile's
        // namespace, rather than with each of its tools.
        const client = yield* mcp.connect(target.apiKey, "local-account-descriptions");
        const searched = (step: string) =>
          client
            .use(step, (client, signal) =>
              client.callTool(
                {
                  name: "execute",
                  arguments: {
                    code: `return await tools.search({ query: "List described fixture records", namespace: ${JSON.stringify(app.slug)} });`,
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
                const item = execution.value.items.find((item) => item.path.endsWith(".records"));
                return {
                  description: item?.description,
                  namespace: execution.value.namespaces.find(
                    (namespace) => item !== undefined && item.path.startsWith(`${namespace.path}.`),
                  ),
                };
              }),
            );
        const described = yield* searched("Search with a described account");
        expect(described.description).toBe("List described fixture records");
        expect(described.namespace).toMatchObject({
          profile: "Work key",
          accounts: "Work key: Reads only; use the sandbox account for writes.",
        });

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
        expect((yield* searched("Search after renaming")).namespace).toMatchObject({
          profile: "Production key",
          accounts: "Production key: Reads only; use the sandbox account for writes.",
        });

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
        expect(plain.namespace?.profile).toBe("Production key");
        expect(plain.namespace).not.toHaveProperty("accounts");
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );
});
