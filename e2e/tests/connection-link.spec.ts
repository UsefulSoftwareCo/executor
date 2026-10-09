/** An agent can hand the user the sign-in link again from a connection it already requested. */
import { expect, layer } from "@effect/vitest";
import { Effect, Redacted, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { App } from "../support/contracts.ts";
import { Evidence } from "../support/evidence.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { McpClient } from "../support/mcp-client.ts";
import { managementApp } from "../support/management-app.ts";
import { createProfile } from "../support/profiles.ts";
import { appsManifest } from "../support/apps-release.ts";
import { Target } from "../support/platform.ts";
import { FixtureActors, fixtureRequest } from "../sdk/fixtures.ts";
import { scenarios } from "../test-plan.ts";

const Token = Schema.Struct({ key: Schema.RedactedFromValue(Schema.String), id: Schema.String });
const Connection = Schema.Struct({
  id: Schema.String,
  url: Schema.String,
  state: Schema.Struct({ status: Schema.String }),
});
const Requested = Schema.Struct({
  status: Schema.Literal("completed"),
  execution: Schema.Struct({
    ok: Schema.Literal(true),
    value: Schema.Struct({ connect: Connection, read: Connection }),
  }),
});
const Account = Schema.Struct({ id: Schema.String });
const Refused = Schema.Struct({
  status: Schema.Literal("completed"),
  execution: Schema.Struct({
    ok: Schema.Literal(false),
    error: Schema.Struct({
      message: Schema.String,
      response: Schema.Struct({
        status: Schema.Literal(422),
        code: Schema.String,
        message: Schema.String,
        recovery: Schema.Struct({ action: Schema.String, instructions: Schema.String }),
      }),
    }),
  }),
});
/** One secrets provider; its display name is part of the provider's identity. */
const files = (name: string) => [
  {
    path: "index.ts",
    content: `
import { defineApp, defineProvider, object, router, secrets, string } from "apps";
const service = defineProvider({ name: ${JSON.stringify(name)}, auth: {
  key: secrets({ label: "API key", fields: object({ token: string() }) })
} });
export default defineApp({ accounts: { service } }, async () => ({ tools: router({}) }));
`,
  },
  appsManifest,
];

layer(HostedLive, { excludeTestServices: true })("Connection link", (it) => {
  it.effect(scenarios.connectionLinkReadAgain.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          evidence = yield* Evidence,
          mcp = yield* McpClient,
          target = yield* Target;
        const organization = actors.organization.id;
        const prefix = `/api/organizations/${organization}`;
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `Link ${randomUUID().slice(0, 8)}`,
          files: files("Link fixture"),
        });
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const app = yield* body(App, deployed);
        const profile = yield* createProfile(actors.owner, `${prefix}/apps/${app.id}`);
        const accounts: string[] = [];
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            for (const account of accounts)
              yield* api.request(actors.owner, "DELETE", `${prefix}/accounts/${account}`);
            yield* api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`);
          }).pipe(Effect.orDie),
        );

        const issued = yield* api.request(actors.owner, "POST", "/api/auth/api-key/create", {
          name: "Connection link",
        });
        expect(issued.status).toBe(200);
        const token = yield* body(Token, issued);
        yield* Effect.addFinalizer(() =>
          api
            .request(actors.owner, "POST", "/api/auth/api-key/delete", { keyId: token.id })
            .pipe(Effect.orDie),
        );
        const management = yield* managementApp(actors.owner);
        const client = yield* mcp.connect(token.key, "connection-link", { organization });
        const executor = `const executor = tools.executor.profiles[${JSON.stringify(management.profile.id)}];`;

        /** Request a link as the code-mode skill says, then read the request back as an agent would. */
        const run = (step: string, account?: string) =>
          client
            .use(step, (client, signal) =>
              client.callTool(
                {
                  name: "execute",
                  arguments: {
                    code: `${executor}
const connect = await executor.accounts.connect(${JSON.stringify({
                      path: { organization, app: app.id },
                      body: {
                        requirement: "service",
                        profile: profile.id,
                        ...(account === undefined ? {} : { account }),
                      },
                    })});
const read = await executor.accounts.connection({ path: { organization: ${JSON.stringify(organization)}, connection: connect.id } });
return { connect, read };`,
                  },
                },
                undefined,
                { signal },
              ),
            )
            .pipe(
              Effect.tap((result) => evidence.json(`${step}.json`, result.structuredContent)),
              Effect.map((result) => result.structuredContent),
            );
        const request = (step: string, account?: string) =>
          run(step, account).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Requested)),
            Effect.map((result) => result.execution.value),
          );
        const expectLink = (connection: typeof Connection.Type) =>
          expect(new URL(connection.url).pathname).toBe(
            `/org/${actors.organization.slug}/connections/${connection.id}`,
          );

        // Reading a pending request returns the link the user still has to open.
        const added = yield* request("connect-new-account");
        expectLink(added.connect);
        expect(added.read.id).toBe(added.connect.id);
        expect(added.read.url).toBe(added.connect.url);
        expect(added.read.state.status).toBe("pending");

        const account = yield* body(
          Account,
          yield* api.request(
            actors.owner,
            "POST",
            `${prefix}/connections/${added.read.id}/submit`,
            {
              method: "key",
              fields: { token: "synthetic-link-token" },
            },
          ),
        );
        accounts.push(account.id);

        // Reconnecting the saved account goes through the same request and returns its own link.
        const reconnected = yield* request("reconnect-account", account.id);
        expect(reconnected.connect.id).not.toBe(added.connect.id);
        expectLink(reconnected.connect);
        expect(reconnected.read.url).toBe(reconnected.connect.url);
        expect(reconnected.read.state.status).toBe("pending");

        // Renaming the provider makes a new provider for the slot. Reconnecting the saved account
        // says it no longer fits the slot, instead of claiming the account is gone.
        const renamed = yield* api.request(
          actors.owner,
          "POST",
          `${prefix}/apps/${app.id}/deploy`,
          {
            files: files("Renamed link fixture"),
          },
        );
        expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
        const refused = yield* run("reconnect-after-rename", account.id).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Refused)),
        );
        const error = refused.execution.error;
        expect(error.response.code).toBe("AccountSelectionInvalid");
        // The agent reads why the account no longer fits and that it must connect a new one,
        // not the generic advice to review the profile's choices.
        expect(error.response.message).toContain("different provider definition");
        expect(error.response.message).not.toBe(
          "The selected accounts do not match this app’s requirements.",
        );
        expect(error.response.recovery.action).toBe(
          "Open Accounts and connect a new account for this requirement.",
        );
        expect(error.response.recovery.instructions).toContain("without `account`");
        expect(error.message).toContain("different provider definition");

        // Following that recovery requests a new account for the renamed provider.
        const replacement = yield* request("connect-after-rename");
        expectLink(replacement.connect);
        expect(replacement.read.url).toBe(replacement.connect.url);

        // An admin of another organization can read neither the request nor its link. Self-host
        // permits one organization, so only Cloud has a real other organization.
        if (target.metadata.target === "cloud") {
          const fixtures = target.fixtures;
          if (fixtures === undefined) return yield* Effect.die("Cloud runs own a fixture control");
          const id = randomUUID().replaceAll("-", "");
          yield* Effect.addFinalizer(() =>
            fixtureRequest(fixtures, "/remove", { id }).pipe(Effect.orDie),
          );
          const outside = yield* fixtureRequest(fixtures, "/actors", {
            id,
            label: "Connection link outsider",
          }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(FixtureActors)));
          expect(outside.organization.id).not.toBe(organization);
          const outsider = yield* api.session(Redacted.make(outside.actors.admin.cookies));
          expect((yield* api.request(outsider, "POST", "/api/onboarding/prepare")).status).toBe(
            200,
          );
          expect(
            (yield* api.request(
              outsider,
              "GET",
              `/api/organizations/${outside.organization.id}/access`,
            )).status,
          ).toBe(200);
          for (const [path, status] of [
            [`${prefix}/connections/${replacement.connect.id}`, 403],
            [
              `/api/organizations/${outside.organization.id}/connections/${replacement.connect.id}`,
              404,
            ],
          ] as const) {
            const read = yield* api.request(outsider, "GET", path);
            expect(read.status, path).toBe(status);
            expect(JSON.stringify(read.body)).not.toContain(replacement.connect.url);
          }
        }
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );
});
