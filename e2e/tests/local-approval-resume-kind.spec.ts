/**
 * An approved call whose service refuses its token is repeated after renewal only when the caller
 * named it a query. A call that named no kind may already have written, even when the catalog
 * names its tool a query, so it is not repeated.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Redacted, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { randomUUID } from "node:crypto";
import { Api, body, type Session } from "../support/api.ts";
import { TestLive, withCase } from "../support/case.ts";
import { Resource } from "../support/contracts.ts";
import { oauthSetupIssuer } from "../support/oauth-setup-issuer.ts";
import { Target } from "../support/platform.ts";
import { recordingService } from "../support/recording-service.ts";
import { scenarios } from "../test-plan.ts";
import { appsManifest } from "../support/apps-release.ts";

const Published = Schema.Struct({ app: Schema.Struct({ id: Schema.String }) });
const Link = Schema.Struct({ connection: Schema.String, url: Schema.String });
const Redirect = Schema.Struct({
  status: Schema.Literal("redirect"),
  authorizationUrl: Schema.String,
});
const Pending = Schema.Struct({
  status: Schema.Literal("approval-required"),
  requestId: Schema.String,
  invocation: Schema.Struct({ kind: Schema.optionalKey(Schema.String) }),
});

layer(TestLive, { excludeTestServices: true })("Local approval resume kind", (it) => {
  it.effect(scenarios.localApprovalResumeKind.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          target = yield* Target,
          http = yield* HttpClient.HttpClient,
          session = yield* api.session();
        const headers = { authorization: `Bearer ${Redacted.value(target.apiKey)}` };
        const agent: Session = {
          ...session,
          send: (method, path, data, extra = {}) => {
            const { origin: _origin, ...rest } = extra;
            return session.send(method, path, data, { ...rest, ...headers });
          },
        };
        const records = yield* recordingService;
        const issuer = yield* oauthSetupIssuer;
        // No `expires_in`, so only the service's refusal starts a renewal.
        yield* issuer.configure({ refreshTokens: true, expiresIn: null });
        const name = `Resume kind ${randomUUID().slice(0, 8)}`;
        // `save` is a query and `write` a mutation. Each approval policy saves a record and asks
        // for approval; each tool saves a record and then presents the account's token.
        const tool = (kind: "query" | "mutation", marker: string) =>
          `${kind}({ input: object({}), approval: async () => {
      await record("policy");
      return "user-approval" as const;
    } }, async () => {
      await record(${JSON.stringify(marker)});
      const response = await fetch(${JSON.stringify(`${issuer.origin}/resource`)}, { headers: { authorization: "Bearer " + accounts.service.fields.access_token } });
      if (response.status === 401) throw new ProviderError({ reason: "unauthorized", status: 401, accountId: accounts.service.id });
      return "ran";
    })`;
        const deployed = yield* api.request(agent, "POST", "/v1/apps/deploy", {
          owner: "local",
          name,
          files: [
            {
              path: "index.ts",
              content: `import { defineApp, defineProvider, oauth2, query, mutation, object, router, ProviderError } from "apps";
const service = defineProvider({ name: ${JSON.stringify(name)}, auth: { oauth: oauth2({ discover: ${JSON.stringify(`${issuer.origin}/mcp`)} }) } });
const record = (name) => fetch(${JSON.stringify(`${records.url}/records`)}, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) });
export default defineApp({ user: { accounts: { service } } }, async ({ user: { accounts } }) => ({
  tools: router({
    save: ${tool("query", "save")},
    write: ${tool("mutation", "write")},
  }),
}));`,
            },
            appsManifest,
          ],
        });
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const { app } = yield* body(Published, deployed);
        let account: string | undefined;
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            yield* api.request(agent, "DELETE", `/v1/apps/${app.id}`);
            if (account !== undefined)
              yield* api.request(agent, "DELETE", `/v1/accounts/${account}`);
          }).pipe(Effect.orDie),
        );
        const link = yield* body(
          Link,
          yield* api.request(agent, "POST", "/account-connect/api/requests", {
            owner: "local",
            target: { app: app.id, requirement: "service" },
          }),
        );
        const grant = {
          connection: link.connection,
          token: new URLSearchParams(new URL(link.url).hash.slice(1)).get("token"),
        };
        const started = yield* api.request(session, "POST", "/account-connect/api/oauth/start", {
          ...grant,
          method: "oauth",
          label: "Synthetic resume account",
        });
        expect(started.status, JSON.stringify(started.body)).toBe(200);
        const { authorizationUrl } = yield* body(Redirect, started);
        const callbackUrl = yield* Effect.scoped(
          Effect.gen(function* () {
            const consent = yield* HttpClient.withScope(http).get(authorizationUrl);
            expect(consent.status).toBe(302);
            const location = consent.headers.location;
            if (location === undefined)
              return yield* Effect.die("Issuer did not return a callback");
            return location;
          }),
        ).pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }));
        const completed = yield* api.request(
          session,
          "POST",
          "/account-connect/api/oauth/complete",
          { ...grant, callbackUrl },
        );
        expect(completed.status, JSON.stringify(completed.body)).toBe(200);
        const connected = (yield* body(Resource, completed)).id;
        account = connected;

        /**
         * Call the tool, then resume its approval after the service has ended the account's
         * token. Returns the resumed result, the records saved since the call, and the renewals.
         */
        const approveRefused = (name: string, kind?: "query" | "mutation") =>
          Effect.gen(function* () {
            const before = {
              records: (yield* records.saved).length,
              refreshes: (yield* issuer.metrics).refreshesIssued,
            };
            // The call names no account; it uses the account linked to the app.
            const called = yield* api.request(agent, "POST", "/v1/tools/call", {
              app: app.id,
              tool: name,
              ...(kind === undefined ? {} : { kind }),
              input: {},
            });
            expect(called.status, JSON.stringify(called.body)).toBe(200);
            const pending = yield* body(Pending, called);
            yield* issuer.expireAccessTokens;
            const resumed = yield* api.request(agent, "POST", "/v1/tools/resume", {
              requestId: pending.requestId,
              response: { action: "accept" },
            });
            expect(resumed.status, JSON.stringify(resumed.body)).toBe(200);
            return {
              saved: pending.invocation,
              resumed: resumed.body,
              records: (yield* records.saved).slice(before.records),
              renewals: (yield* issuer.metrics).refreshesIssued - before.refreshes,
            };
          });

        // No kind named: the request saves none. The refused call is renewed but not repeated,
        // although the catalog names the tool a query: the tool ran once.
        const unnamed = yield* approveRefused("save");
        expect(unnamed.saved).not.toHaveProperty("kind");
        expect(unnamed.records).toEqual(["policy", "save"]);
        expect(unnamed.renewals).toBe(1);
        expect(unnamed.resumed).toMatchObject({ status: "failed", reason: "execution-failed" });

        // Named a query: the refused call is repeated once with the renewed access.
        const queried = yield* approveRefused("save", "query");
        expect(queried.saved).toMatchObject({ kind: "query" });
        expect(queried.records).toEqual(["policy", "save", "save"]);
        expect(queried.renewals).toBe(1);
        expect(queried.resumed).toEqual({ status: "completed", value: "ran" });

        // Named a mutation: renewed, not repeated.
        const written = yield* approveRefused("write", "mutation");
        expect(written.saved).toMatchObject({ kind: "mutation" });
        expect(written.records).toEqual(["policy", "write"]);
        expect(written.renewals).toBe(1);
        expect(written.resumed).toMatchObject({ status: "failed", reason: "execution-failed" });
      }),
    ),
  );
});
