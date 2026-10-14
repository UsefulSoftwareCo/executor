import { expect, layer } from "@effect/vitest";
import { Effect, Redacted, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Api, body, type Session } from "../support/api.ts";
import { connectLocalAccount } from "../support/app-accounts.ts";
import { linkLocal, localLinks, unlinkLocal } from "../support/local-links.ts";
import { Browser } from "../support/browser.ts";
import { TestLive, withCase } from "../support/case.ts";
import { Target } from "../support/platform.ts";
import { accountToolSource, checkToolAccountContext } from "../support/tool-account-context.ts";
import { scenarios } from "../test-plan.ts";
import { appsManifest } from "../support/apps-release.ts";

layer(TestLive, { excludeTestServices: true })("Local tool account context", (it) => {
  it.effect(scenarios.localToolAccountContext.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          target = yield* Target,
          browser = yield* Browser,
          session = yield* api.session();
        const headers = { authorization: `Bearer ${Redacted.value(target.apiKey)}` };
        const agent: Session = {
          ...session,
          send: (method, path, data, extra = {}) => {
            const { origin: _origin, ...rest } = extra;
            return session.send(method, path, data, { ...rest, ...headers });
          },
        };
        const response = yield* session.send(
          "POST",
          "/v1/apps/deploy",
          {
            owner: "local",
            name: `Account tools ${randomUUID().slice(0, 8)}`,
            files: [{ path: "index.ts", content: accountToolSource }, appsManifest],
          },
          headers,
        );
        expect(response.status).toBe(200);
        const { app } = yield* body(
          Schema.Struct({
            app: Schema.Struct({
              id: Schema.String,
              requirements: Schema.Struct({
                accounts: Schema.Struct({ workspaces: Schema.Struct({ provider: Schema.String }) }),
              }),
            }),
          }),
          response,
        );
        // Saved accounts by label.
        const accounts = new Map<string, string>();
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            yield* session.send("DELETE", `/v1/apps/${app.id}`, undefined, headers);
            for (const account of accounts.values())
              yield* session.send("DELETE", `/v1/accounts/${account}`, undefined, headers);
          }).pipe(Effect.orDie),
        );
        // Accounts connect for the app's many-account requirement, which links them to it.
        const add = (label: string, token: string) =>
          Effect.gen(function* () {
            const account = yield* connectLocalAccount(
              agent,
              {
                app: app.id,
                requirement: "workspaces",
                method: "key",
                label,
                fields: { token },
              },
              headers,
            );
            accounts.set(label, account.id);
            return account.id;
          });
        const roles = [
          { label: "Work GitHub", token: "work" },
          { label: "Personal GitHub", token: "personal" },
        ] as const;
        const work = yield* add(roles[0].label, roles[0].token),
          personal = yield* add(roles[1].label, roles[1].token);
        const role = (id: string) => (id === personal ? roles[1] : roles[0]);
        const linked = Effect.gen(function* () {
          const response = yield* session.send(
            "GET",
            `/dashboard/api/apps/${app.id}/accounts/user`,
            undefined,
            headers,
          );
          expect(response.status).toBe(200);
          return (yield* body(
            Schema.Array(
              Schema.Struct({
                requirement: Schema.Literal("workspaces"),
                account: Schema.Struct({ label: Schema.String }),
              }),
            ),
            response,
          ))
            .map((link) => link.account.label)
            .sort();
        });
        const pairing = yield* session.send("POST", "/auth/pair", undefined, headers);
        const { url } = yield* body(Schema.Struct({ url: Schema.String }), pairing);
        yield* browser.use("Pair the local browser", (page) => page.goto(url));
        yield* browser.use("Local pairing completes before app navigation", (page) =>
          page.getByRole("heading", { name: /^Apps/ }).waitFor({ state: "visible" }),
        );
        yield* checkToolAccountContext({
          url: `/apps/${app.id}`,
          work,
          personal,
          catalogs: [`/dashboard/api/live/apps/${app.id}/tools`],
          // The many() requirement uses every linked account. Choosing accounts links exactly
          // those; the unlinked ones stay saved.
          select: (ids) =>
            Effect.gen(function* () {
              const current = yield* localLinks(agent, app.id);
              for (const id of [work, personal]) {
                if (ids.includes(id) && !current.includes(id))
                  yield* linkLocal(agent, app.id, "workspaces", id);
                if (!ids.includes(id) && current.includes(id))
                  yield* unlinkLocal(agent, app.id, "workspaces", id);
              }
              expect(yield* linked).toEqual(ids.map((id) => role(id).label).sort());
            }),
        });
      }),
    ),
  );
});
