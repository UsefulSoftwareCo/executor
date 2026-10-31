/** Shared app and public API reads used by contributed-account scenarios. */
import { expect } from "@effect/vitest";
import { Effect, Schedule, Schema } from "effect";
import { body, type Session } from "./api.ts";
import { appLinksFixture, ok } from "./app-links.ts";

export const contributedSource = `import { defineApp, defineProvider, secrets, query, object, string, router, type QueryContext } from "apps";
const service = defineProvider({ name: "Contributed service", auth: {
  key: secrets({ label: "Key", fields: object({ token: string() }) }),
}, async health() { return { accountInfo: { displayName: "Upstream person", username: "upstream-user", email: "upstream@example.test" } }; } });
const requirements = { app: { accounts: { shared: service.many().contributed(), ordinary: service.many() } }, user: { accounts: { own: service.many() } } };
const accounts = query({ input: object({}) }, async (ctx: QueryContext<typeof requirements>) => ({ shared: ctx.app.accounts.shared.map((account) => account.id) }));
export default defineApp(requirements, { tools: router({ accounts }) });`;

export const Health = Schema.Struct({
  info: Schema.NullOr(Schema.Struct({ email: Schema.optionalKey(Schema.String) })),
  infoCheckedAt: Schema.NullOr(Schema.String),
  apps: Schema.Array(
    Schema.Struct({ check: Schema.NullOr(Schema.Struct({ status: Schema.String })) }),
  ),
});
export const Contribution = Schema.Struct({
  requirement: Schema.String,
  account: Schema.Struct({
    id: Schema.String,
    label: Schema.String,
    description: Schema.NullOr(Schema.String),
  }),
  linkedBy: Schema.Struct({ id: Schema.String, name: Schema.NullOr(Schema.String) }),
  canRemove: Schema.Boolean,
  health: Schema.optionalKey(Health),
});
const Members = Schema.Struct({
  members: Schema.Array(Schema.Struct({ id: Schema.String, userId: Schema.String })),
});
class PendingContributions extends Schema.TaggedError<PendingContributions>()(
  "PendingContributions",
  {},
) {}

export const contributedApp = Effect.gen(function* () {
  const fixture = yield* appLinksFixture([{ path: "index.ts", content: contributedSource }]);
  const { api, actors, path, ids } = fixture;
  const readLinks = (actor: Session = actors.owner) =>
    api.request(actor, "GET", `${path}/accounts/app`).pipe(
      Effect.tap(ok),
      Effect.flatMap((response) => body(Schema.Array(Contribution), response)),
    );
  const role = (user: string, role: "admin" | "member") =>
    Effect.gen(function* () {
      const directory = yield* body(
        Members,
        yield* api.request(
          actors.owner,
          "GET",
          `/api/auth/organization/list-members?organizationId=${actors.organization.id}`,
        ),
      );
      const member = directory.members.find((entry) => entry.userId === user);
      if (member === undefined) return yield* Effect.die("Synthetic member is missing");
      yield* ok(
        yield* api.request(actors.owner, "POST", "/api/auth/organization/update-member-role", {
          organizationId: actors.organization.id,
          memberId: member.id,
          role,
        }),
      );
    });
  const waitForLinks = (expected: readonly string[]) =>
    readLinks().pipe(
      Effect.flatMap((links) => {
        const ids = links.map((link) => link.account.id).sort();
        return JSON.stringify(ids) === JSON.stringify([...expected].sort())
          ? Effect.succeed(links)
          : Effect.fail(new PendingContributions());
      }),
      Effect.retry({
        while: Schema.is(PendingContributions),
        schedule: Schedule.spaced("100 millis"),
      }),
      Effect.timeout("15 seconds"),
    );
  const member = yield* body(
    Schema.Struct({
      user: Schema.Struct({ id: Schema.String, name: Schema.String, email: Schema.String }),
    }),
    yield* api.request(actors.member, "GET", "/api/auth/get-session"),
  );
  expect(member.user.id).toBe(ids.member);
  return { ...fixture, readLinks, role, waitForLinks, member: member.user };
});
