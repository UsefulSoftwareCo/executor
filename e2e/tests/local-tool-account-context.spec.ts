import { expect, layer } from "@effect/vitest";
import { Effect, Redacted, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { TestLive, withCase } from "../support/case.ts";
import { Resource } from "../support/contracts.ts";
import { Target } from "../support/platform.ts";
import { accountToolSource, checkToolAccountContext } from "../support/tool-account-context.ts";
import { scenarios } from "../test-plan.ts";

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
        const response = yield* session.send(
          "POST",
          "/v1/apps/deploy",
          {
            owner: "local",
            name: `Account tools ${randomUUID().slice(0, 8)}`,
            files: [{ path: "index.ts", content: accountToolSource }],
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
        const accounts: string[] = [];
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            yield* session.send("DELETE", `/v1/apps/${app.id}`, undefined, headers);
            for (const account of accounts)
              yield* session.send("DELETE", `/v1/accounts/${account}`, undefined, headers);
          }).pipe(Effect.orDie),
        );
        const add = (label: string, token: string) =>
          Effect.gen(function* () {
            const response = yield* session.send(
              "POST",
              "/v1/accounts",
              {
                owner: "local",
                provider: app.requirements.accounts.workspaces.provider,
                method: "key",
                label,
                fields: { token },
              },
              headers,
            );
            expect(response.status).toBe(200);
            const account = yield* body(Resource, response);
            accounts.push(account.id);
            return account.id;
          });
        const work = yield* add("Work GitHub", "work"),
          personal = yield* add("Personal GitHub", "personal");
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
          select: (ids) =>
            session
              .send("PATCH", `/v1/apps/${app.id}`, { accounts: { workspaces: ids } }, headers)
              .pipe(Effect.tap((response) => Effect.sync(() => expect(response.status).toBe(200)))),
        });
      }),
    ),
  );
});
