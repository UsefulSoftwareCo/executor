import { expect, layer } from "@effect/vitest";
import { Effect, Redacted, Schema } from "effect";
import { scenarios } from "../test-plan.ts";
import { accountLinks, requirementPath } from "../support/app-accounts.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { appAccountsFixture, who } from "../support/hosted-app-accounts.ts";

const Key = Schema.Struct({ id: Schema.String, key: Schema.RedactedFromValue(Schema.String) });

layer(HostedLive, { excludeTestServices: true })("Tools-only account links", (it) => {
  it.effect(scenarios.toolsOnlyAccountLinks.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api;
        const { actors, path, mailA, connect } = yield* appAccountsFixture;
        const replacement = yield* connect(actors.member, "Replacement account", {
          requirement: "extra",
        });
        const anonymous = yield* api.session();
        const lifecycle = "/api/auth/api-key";
        const keys: string[] = [];
        yield* Effect.addFinalizer(() =>
          Effect.forEach(
            keys,
            (keyId) => api.request(actors.member, "POST", `${lifecycle}/delete`, { keyId }),
            { discard: true },
          ).pipe(Effect.orDie),
        );
        const create = (tools: boolean) =>
          Effect.gen(function* () {
            const response = yield* api.request(actors.member, "POST", `${lifecycle}/create`, {
              name: tools ? "Tools-only member" : "Legacy member",
              metadata: {
                organization: actors.organization.id,
                ...(tools ? { scope: "tools" } : {}),
              },
            });
            expect(response.status).toBe(200);
            const key = yield* body(Key, response);
            keys.push(key.id);
            return { authorization: `Bearer ${Redacted.value(key.key)}` };
          });
        const scoped = yield* create(true);
        const legacy = yield* create(false);
        const requirement = requirementPath(path, "user", "service");
        const before = yield* accountLinks(actors.member, path);
        expect(
          (yield* api.request(anonymous, "PUT", `${requirement}/${replacement}`, undefined, scoped))
            .status,
        ).toBe(403);
        expect(
          (yield* api.request(anonymous, "DELETE", `${requirement}/${mailA}`, undefined, scoped))
            .status,
        ).toBe(403);
        expect(yield* accountLinks(actors.member, path)).toEqual(before);
        const call = (headers: Record<string, string>) =>
          api
            .request(
              anonymous,
              "POST",
              `${path}/tools/call`,
              { tool: "who", kind: "query", input: {} },
              headers,
            )
            .pipe(Effect.flatMap(who));
        expect((yield* call(scoped)).account).toBe(mailA);
        expect(
          (yield* api.request(anonymous, "PUT", `${requirement}/${replacement}`, undefined, legacy))
            .status,
        ).toBe(200);
        expect((yield* call(legacy)).account).toBe(replacement);
        expect(
          (yield* api.request(
            anonymous,
            "DELETE",
            `${requirement}/${replacement}`,
            undefined,
            legacy,
          )).status,
        ).toBe(200);
        expect(yield* accountLinks(actors.member, path)).toEqual([["extra", replacement]]);
        expect((yield* api.request(actors.member, "PUT", `${requirement}/${mailA}`)).status).toBe(
          200,
        );
        expect(
          (yield* api.request(actors.member, "DELETE", `${requirement}/${mailA}`)).status,
        ).toBe(200);
        expect(yield* accountLinks(actors.member, path)).toEqual([["extra", replacement]]);
      }),
    ),
  );
});
