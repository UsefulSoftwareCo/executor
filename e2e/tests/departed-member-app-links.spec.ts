import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { appLinksFixture, keyProvider, ok } from "../support/app-links.ts";
import { scenarios } from "../test-plan.ts";

const source = `import { defineApp, defineProvider, query, secrets, object, string, router, type QueryContext } from "apps";
const team = ${keyProvider("Departed member link fixture")};
const requirements = { app: { accounts: { team: team.many() } } };
const accounts = query({ input: object({}) }, async (ctx: QueryContext<typeof requirements>) => ({
  team: ctx.app.accounts.team.map((account) => account.id),
}));
export default defineApp(requirements, async () => ({ tools: router({ accounts }) }));`;
const Accounts = Schema.Struct({ team: Schema.Array(Schema.String) });
const SessionIdentity = Schema.Struct({ user: Schema.Struct({ email: Schema.String }) });

layer(HostedLive, { excludeTestServices: true })("Departed member app links", (it) => {
  it.effect(scenarios.hostedDepartedMemberAppLink.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const fixture = yield* appLinksFixture([{ path: "index.ts", content: source }]);
        const { api, actors, connect, links } = fixture;
        const used = Effect.gen(function* () {
          const response = yield* fixture.call(actors.member, "accounts");
          yield* ok(response);
          return (yield* body(Accounts, response)).team;
        });
        const listed = Effect.map(links(), (read) => read.map((item) => item.account.id));

        const personal = yield* connect(actors.admin, "app", "team", "departed-admin-team");
        const remaining = yield* connect(actors.owner, "app", "team", "departed-owner-team");
        expect(yield* used).toEqual([personal, remaining]);
        expect(yield* listed).toEqual([personal, remaining]);

        const { user } = yield* body(
          SessionIdentity,
          yield* api.request(actors.admin, "GET", "/api/auth/get-session"),
        );
        yield* ok(
          yield* api.request(actors.owner, "POST", "/api/auth/organization/remove-member", {
            organizationId: actors.organization.id,
            memberIdOrEmail: user.email,
          }),
        );
        expect(yield* used).toEqual([remaining]);
        expect(yield* listed).toEqual([personal, remaining]);
      }),
    ),
  );
});
