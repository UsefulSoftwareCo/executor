/**
 * An event carries data from the accounts its invocation used, so a subscriber receives it only
 * if they may use every one of them. Here an app shared with everyone emits from the owner's
 * personal account: the owner's subscription receives it, a member's does not. A grant limited
 * to some profiles also receives only occurrences whose accounts those profiles select.
 */
import { createProfile } from "../support/profiles.ts";
import { expect, layer } from "@effect/vitest";
import { Effect, Redacted, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Api, body } from "../support/api.ts";
import { Actors } from "../support/actors.ts";
import { Browser } from "../support/browser.ts";
import { McpOAuth } from "../support/mcp-oauth.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App, Resource } from "../support/contracts.ts";
import { appsManifest } from "../support/apps-release.ts";
import { Granted, eventFixtures, secrets } from "../support/events.ts";

const files = [
  {
    path: "index.ts",
    content: `import { defineApp, defineProvider, event, secrets, object, string, mutation, router,
  type MutationContext } from "apps";
const service = defineProvider({ name: "Mailbox fixture", auth: {
  key: secrets({ label: "Key", fields: object({ token: string() }) })
} });
const mailReceived = event({ description: "A message arrived in the mailbox.", payload: object({ subject: string() }) });
const requirements = { accounts: { service }, events: { "mail.received": mailReceived } };
const receive = mutation({ input: object({ id: string() }) },
  async (ctx: MutationContext<typeof requirements>, { id }) => {
    ctx.events.emit("mail.received", { subject: "Private subject" }, { id });
    return "emitted";
  });
export default defineApp(requirements, { tools: router({ receive }) });
`,
  },
  appsManifest,
];

layer(HostedLive, { excludeTestServices: true })("MCP event accounts", (it) => {
  it.effect(
    scenarios.mcpEventAccounts.title,
    (context) =>
      withHostedCase(
        context,
        Effect.gen(function* () {
          const api = yield* Api,
            actors = yield* Actors,
            browser = yield* Browser,
            oauth = yield* McpOAuth;
          const { prefix, suffix, callbackUrl, awaitDeliveries, events, rpcAs, ok, createKey } =
            yield* eventFixtures;
          const created: { app?: string; profile?: string; account?: string } = {};
          yield* Effect.addFinalizer(() =>
            Effect.gen(function* () {
              if (created.profile)
                yield* api.request(
                  actors.owner,
                  "DELETE",
                  `${prefix}/apps/${created.app}/profiles/${created.profile}`,
                );
              if (created.app)
                yield* api.request(actors.owner, "DELETE", `${prefix}/apps/${created.app}`);
              if (created.account)
                yield* api.request(actors.owner, "DELETE", `${prefix}/accounts/${created.account}`);
            }).pipe(Effect.orDie),
          );
          const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
            name: `Mailbox events ${suffix}`,
            files,
          });
          expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
          const app = yield* body(App, deployed);
          created.app = app.id;
          const path = `${prefix}/apps/${app.id}`;
          // Everyone may use the app; the account stays the owner's own.
          const access = yield* body(
            Schema.Struct({ revision: Schema.String }),
            yield* api.request(actors.owner, "GET", `${path}/access`),
          );
          expect(
            (yield* api.request(actors.owner, "PATCH", `${path}/access`, {
              revision: access.revision,
              audience: { kind: "everyone" },
            })).status,
          ).toBe(200);
          const profile = yield* createProfile(actors.owner, path);
          created.profile = profile.id;
          const connection = yield* api.request(actors.owner, "POST", `${path}/connections`, {
            requirement: "service",
            profile: profile.id,
          });
          expect(connection.status).toBe(200);
          const saved = yield* api.request(
            actors.owner,
            "POST",
            `${prefix}/connections/${(yield* body(Resource, connection)).id}/submit`,
            {
              method: "key",
              label: `Owner mailbox ${suffix}`,
              fields: { token: "synthetic-mail" },
            },
          );
          expect(saved.status).toBe(200);
          created.account = (yield* body(Resource, saved)).id;

          const name = `${app.slug}.mail.received`;
          const subscribe = (key: Parameters<typeof rpcAs>[0], variant: string) =>
            rpcAs(key, "events/subscribe", {
              name,
              arguments: {},
              delivery: {
                mode: "webhook",
                url: `${callbackUrl}?variant=${variant}`,
                secret: secrets[0],
              },
            }).pipe(Effect.flatMap((value) => ok(Granted, value)));
          const ownerKey = yield* createKey(`Mailbox owner ${suffix}`);
          const memberKey = yield* body(
            Schema.Struct({ id: Schema.String, key: Schema.RedactedFromValue(Schema.String) }),
            yield* api.request(actors.member, "POST", "/api/auth/api-key/create", {
              name: `Mailbox member ${suffix}`,
            }),
          );
          yield* Effect.addFinalizer(() =>
            api
              .request(actors.member, "POST", "/api/auth/api-key/delete", { keyId: memberKey.id })
              .pipe(Effect.ignore),
          );
          // Both may subscribe: each may use the app.
          const owner = yield* subscribe(ownerKey.key, "owner");
          const member = yield* subscribe(memberKey.key, "member");

          const id = randomUUID();
          const emitted = yield* api.request(actors.owner, "POST", `${path}/tools/call`, {
            profile: profile.id,
            tool: "receive",
            kind: "mutation",
            input: { id },
          });
          expect(emitted.status, JSON.stringify(emitted.body)).toBe(200);
          // The owner's delivery marks when the member's would have arrived.
          const delivered = yield* awaitDeliveries((all) =>
            events(all).some(
              (delivery) => delivery.id === id && delivery.subscription === owner.id,
            ),
          );
          expect(
            events(delivered).filter(
              (delivery) => delivery.id === id && delivery.subscription === member.id,
            ),
          ).toHaveLength(0);

          // OAuth grants limited to some of the app's profiles: the profile that selects the
          // owner's account receives its occurrences; the account-free target does not.
          yield* browser.login(actors.owner);
          const limitedTo = (targets: readonly unknown[]) =>
            Effect.gen(function* () {
              const issued = yield* oauth.authorize;
              const narrowed = yield* api.request(
                actors.owner,
                "POST",
                "/api/auth/mcp/grants/narrow",
                {
                  id: issued.grantId,
                  policy: {
                    kind: "tools",
                    apps: [{ app: app.id, tools: { kind: "all" }, targets }],
                    approval: "client",
                  },
                },
              );
              expect(narrowed.status, JSON.stringify(narrowed.body)).toBe(200);
              return Redacted.make(Redacted.value(issued.tokens).access_token);
            });
          const scoped = yield* subscribe(
            yield* limitedTo([{ kind: "profile", id: profile.id }]),
            "scoped",
          );
          const accountFree = yield* subscribe(yield* limitedTo([{ kind: "app" }]), "app-only");
          const next = randomUUID();
          const again = yield* api.request(actors.owner, "POST", `${path}/tools/call`, {
            profile: profile.id,
            tool: "receive",
            kind: "mutation",
            input: { id: next },
          });
          expect(again.status, JSON.stringify(again.body)).toBe(200);
          const scopedDeliveries = yield* awaitDeliveries((all) =>
            events(all).some(
              (delivery) => delivery.id === next && delivery.subscription === scoped.id,
            ),
          );
          expect(
            events(scopedDeliveries).filter(
              (delivery) => delivery.id === next && delivery.subscription === accountFree.id,
            ),
          ).toHaveLength(0);
        }).pipe(Effect.provide(McpOAuth.layer)),
      ),
    { timeout: 180_000 },
  );
});
