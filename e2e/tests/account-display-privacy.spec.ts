import { Actors } from "../support/actors.ts";
import { Api } from "../support/api.ts";
import { Resource } from "../support/contracts.ts";
import { appsManifest } from "../support/apps-release.ts";
import { accountStatusBackend } from "../support/account-status-fixture.ts";
/** Encodings and identity-only results cannot bypass the public display confidentiality check. */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { accountStatusSource, displayedStatus } from "../support/account-status-fixture.ts";
import { interactiveBackendKey } from "../support/interactive-account-backend.ts";
import { legacyStorage } from "../support/legacy-storage.ts";
import { serverControl } from "../support/server-control.ts";
import { statusAccount } from "../support/status-account.ts";
import { scenarios } from "../test-plan.ts";
const Health = Schema.Struct({
  apps: Schema.Array(
    Schema.Struct({ check: Schema.NullOr(Schema.Struct({ status: Schema.String })) }),
  ),
});
const forms = (secret: string) => {
  const bytes = Buffer.from(secret, "utf8");
  return [
    secret,
    bytes.toString("base64"),
    bytes.toString("base64url"),
    encodeURIComponent(secret),
    [...bytes].map((v) => "%" + v.toString(16).padStart(2, "0")).join(""),
    bytes.toString("hex"),
    bytes.toString("hex").toUpperCase(),
  ];
};
layer(HostedLive, { excludeTestServices: true })("Display confidentiality", (it) => {
  it.effect(scenarios.accountDisplayEncodedPrivacy.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const unicodeSecret = "p?Ω/++ünï";
        const fixture = yield* statusAccount(
          (connect, check) =>
            accountStatusSource(connect, check).replace(
              "token: string()",
              "token: string(), encoded: string()",
            ),
          { encoded: unicodeSecret },
        );
        for (const secret of ["opaque-1", interactiveBackendKey, unicodeSecret]) {
          for (const encoded of forms(secret)) {
            yield* fixture.statusBackend.answer({
              status: 200,
              body: {
                status: {
                  ...displayedStatus,
                  stats: [{ label: "Value", value: `public:${encoded}` }],
                },
              },
            });
            const response = yield* fixture.check();
            expect(response.status).toBe(200);
            expect((yield* body(Health, response)).apps[0]?.check?.status).toBe("check_failed");
            expect(JSON.stringify((yield* fixture.read()).body)).not.toContain(encoded);
          }
        }
        const stored = yield* legacyStorage([
          {
            sql: "SELECT account_info FROM executor_account_checks WHERE account = $1",
            params: [fixture.account],
          },
        ]);
        expect(stored).toEqual([[{ account_info: null }]]);
        yield* serverControl("start");
        yield* fixture.statusBackend.answer({
          status: 200,
          body: { accountInfo: { profileUrl: "https://example.test/" + "x".repeat(32_768) } },
        });
        expect((yield* body(Health, yield* fixture.check())).apps[0]?.check?.status).toBe(
          "check_failed",
        );
        yield* fixture.statusBackend.answer({
          status: 200,
          body: { accountInfo: { displayName: "Public identity" }, status: displayedStatus },
        });
        expect((yield* body(Health, yield* fixture.check())).apps[0]?.check?.status).toBe(
          "healthy",
        );
      }),
    ),
  );
  it.effect(scenarios.accountDisplayIdentityPrivacy.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const fixture = yield* statusAccount(accountStatusSource);
        for (const secret of ["opaque-1", interactiveBackendKey]) {
          for (const field of [
            "externalId",
            "displayName",
            "username",
            "email",
            "avatarUrl",
            "profileUrl",
          ]) {
            for (const status of [undefined, displayedStatus]) {
              const value = field.endsWith("Url")
                ? `https://example.test/${secret}`
                : `public:${secret}`;
              yield* fixture.statusBackend.answer({
                status: 200,
                body: {
                  accountInfo: { [field]: value },
                  ...(status === undefined ? {} : { status }),
                },
              });
              const response = yield* fixture.check();
              expect(response.status).toBe(200);
              expect((yield* body(Health, response)).apps[0]?.check?.status).toBe("check_failed");
              expect(JSON.stringify((yield* fixture.read()).body)).not.toContain(secret);
            }
          }
        }
        // Identity strings need the same encoding protection even without status.
        for (const encoded of forms(interactiveBackendKey)) {
          yield* fixture.statusBackend.answer({
            status: 200,
            body: { accountInfo: { displayName: encoded } },
          });
          expect((yield* body(Health, yield* fixture.check())).apps[0]?.check?.status).toBe(
            "check_failed",
          );
        }
      }),
    ),
  );
  it.effect(scenarios.accountDisplayProviderPrivacy.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          backend = yield* accountStatusBackend;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: "Provider privacy fixture",
          files: [
            {
              path: "index.ts",
              content: `import { defineApp, defineProvider, object, secrets, string, router } from "apps";
const service = defineProvider({ name: "Private provider check", hosts: [${JSON.stringify(new URL(backend.origin).host)}], auth: { key: secrets({ label: "Key", fields: object({ token: string() }) }) },
  health: async ({ account, fetch, signal }) => await (await fetch(${JSON.stringify(backend.origin + "/check?ref=opaque-fixture")}, { signal, headers: { authorization: "Bearer " + account.fields.token } })).json() });
export default defineApp({ user: { accounts: { service } } }, { tools: router({}) });`,
            },
            appsManifest,
          ],
        });
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const app = yield* body(
          Schema.Struct({
            id: Schema.String,
            requirements: Schema.Struct({
              accounts: Schema.Struct({ service: Schema.Struct({ provider: Schema.String }) }),
            }),
          }),
          deployed,
        );
        const path = `${prefix}/apps/${app.id}`;
        let account: string | undefined;
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            yield* api.request(actors.owner, "DELETE", path);
            if (account !== undefined)
              yield* api.request(actors.owner, "DELETE", `${prefix}/accounts/${account}`);
          }).pipe(Effect.orDie),
        );
        for (const encoded of forms(interactiveBackendKey)) {
          yield* backend.answer({ status: 200, body: { accountInfo: { displayName: encoded } } });
          const response = yield* api.request(actors.owner, "POST", `${path}/credential-checks`, {
            provider: app.requirements.accounts.service.provider,
            method: "key",
            fields: { token: interactiveBackendKey },
          });
          expect(response.status, JSON.stringify(response.body)).toBe(200);
          expect(response.body).toMatchObject({ status: "check_failed", info: null });
          expect(JSON.stringify(response.body)).not.toContain(encoded);
        }
        const pending = yield* body(
          Resource,
          yield* api.request(actors.owner, "POST", `${path}/accounts/user/service/connections`, {}),
        );
        const saved = yield* api.request(
          actors.owner,
          "POST",
          `${prefix}/connections/${pending.id}/submit`,
          { method: "key", fields: { token: interactiveBackendKey } },
        );
        expect(saved.status).toBe(200);
        account = (yield* body(Resource, saved)).id;
        for (const encoded of forms(interactiveBackendKey)) {
          yield* backend.answer({ status: 200, body: { accountInfo: { displayName: encoded } } });
          const response = yield* api.request(
            actors.owner,
            "POST",
            `${prefix}/accounts/${account}/health`,
          );
          expect(response.status).toBe(200);
          expect((yield* body(Health, response)).apps[0]?.check?.status).toBe("check_failed");
          expect(JSON.stringify(response.body)).not.toContain(encoded);
        }
      }),
    ),
  );
});
