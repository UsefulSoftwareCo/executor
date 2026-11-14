/**
 * Staff keys for app-wide automation, without the editor ever seeing them: a member connects their
 * own key and shares it, an editor links that shared account as the app's own account, and every
 * caller's invocation then runs with it. Personal accounts and non-editors cannot take this path.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Api, body, type Session } from "../support/api.ts";
import { Actors } from "../support/actors.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App, Resource } from "../support/contracts.ts";
import { appsManifest } from "../support/apps-release.ts";
import { connectionsPath, linkAccountResponse } from "../support/app-accounts.ts";

const provider = `const automation = defineProvider({ name: "Shared automation key fixture", auth: { key: secrets({ label: "Key", fields: object({ token: string() }) }) } });`;
const staffApp = `import { defineApp, defineProvider, secrets, object, string } from "apps";
${provider}
export default defineApp({ user: { accounts: { automation } } }, {});`;
const automationApp = `import { defineApp, defineProvider, secrets, object, string, query, router } from "apps";
${provider}
export default defineApp({ app: { accounts: { automation } } }, async (ctx) => ({ tools: router({
  which: query({ input: object({}) }, async () => ({ account: ctx.app.accounts.automation.id })),
}) }));`;
const Access = Schema.Struct({ revision: Schema.String });
const Which = Schema.Struct({ account: Schema.String });

layer(HostedLive, { excludeTestServices: true })("Shared app account handoff", (it) => {
  // Pending product decision: notes/personal-account-model-decision.md (PR #92).
  // Keep this regression until the user decides whether to accept personal-only accounts.
  it.effect.skip(scenarios.sharedAppAccountHandoff.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const accounts: string[] = [];
        const deploy = (name: string, content: string) =>
          Effect.gen(function* () {
            const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
              name: `${name} ${randomUUID().slice(0, 8)}`,
              files: [{ path: "index.ts", content }, appsManifest],
            });
            expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
            const path = `${prefix}/apps/${(yield* body(App, deployed)).id}`;
            yield* Effect.addFinalizer(() =>
              api.request(actors.owner, "DELETE", path).pipe(Effect.ignore),
            );
            const access = yield* body(
              Access,
              yield* api.request(actors.owner, "GET", `${path}/access`),
            );
            expect(
              (yield* api.request(actors.owner, "PATCH", `${path}/access`, {
                revision: access.revision,
                audience: { kind: "everyone" },
              })).status,
            ).toBe(200);
            return path;
          });
        yield* Effect.addFinalizer(() =>
          Effect.forEach(accounts, (account) =>
            api
              .request(actors.owner, "DELETE", `${prefix}/accounts/${account}`)
              .pipe(Effect.ignore),
          ).pipe(Effect.asVoid),
        );
        const staff = yield* deploy("Staff keys", staffApp);
        const automation = yield* deploy("Automation", automationApp);
        // A member connects their own key from the staff app, choosing where it is saved.
        const connect = (actor: Session, label: string, destination: Record<string, unknown>) =>
          Effect.gen(function* () {
            const pending = yield* api.request(
              actor,
              "POST",
              connectionsPath(staff, "user", "automation"),
              { destination },
            );
            expect(pending.status, JSON.stringify(pending.body)).toBe(200);
            const submitted = yield* api.request(
              actor,
              "POST",
              `${prefix}/connections/${(yield* body(Resource, pending)).id}/submit`,
              { method: "key", label, fields: { token: `synthetic-${randomUUID()}` } },
            );
            expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
            const id = (yield* body(Resource, submitted)).id;
            accounts.push(id);
            return id;
          });
        const shared = yield* connect(actors.member, "Staff shared key", {
          kind: "shared",
          audience: { kind: "everyone" },
        });
        const personal = yield* connect(actors.member, "Staff personal key", { kind: "personal" });

        // The app's own requirement has no account yet, so its tools cannot run.
        const which = (actor: Session) =>
          api.request(actor, "POST", `${automation}/tools/call`, {
            tool: "which",
            kind: "query",
            input: {},
          });
        expect((yield* which(actors.owner)).status).toBe(409);

        // A member who cannot edit the app cannot link it for everyone, even their own account.
        expect(
          (yield* linkAccountResponse(actors.member, automation, "automation", shared, "app"))
            .status,
        ).toBe(403);
        // An editor cannot link another person's personal account.
        expect(
          (yield* linkAccountResponse(actors.admin, automation, "automation", personal, "app"))
            .status,
        ).toBe(403);
        // An editor links the shared account as the app's own.
        const linked = yield* linkAccountResponse(
          actors.admin,
          automation,
          "automation",
          shared,
          "app",
        );
        expect(linked.status, JSON.stringify(linked.body)).toBe(200);

        // Every caller's invocation now runs with it: the staff member, the editor and the owner.
        for (const actor of [actors.member, actors.admin, actors.owner]) {
          const called = yield* which(actor);
          expect(called.status, JSON.stringify(called.body)).toBe(200);
          expect(yield* body(Which, called)).toEqual({ account: shared });
        }
      }),
    ),
  );
});
