/** Local organization member switching; production never mounts these handlers. */
import { LoopbackOrigin } from "@executor-js/utils/url-policy";
import { Effect, Redacted, Schema } from "effect";
import { Cookies, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import {
  DevtoolsAccount,
  DevtoolsOrganization,
  DevtoolsState,
  TestRole,
  TestSignIn,
} from "@executor-js/devtools/contracts";
import {
  DevtoolsOperatorId,
  FixtureName,
  provisionTestAccount,
  type testAccountAuth,
} from "./accounts.ts";

const fixtures = [
  { role: "member", name: "rhys-member", displayName: "Maya Chen" },
  { role: "admin", name: "admin", displayName: "Jordan Lee" },
  { role: "owner", name: "agent", displayName: "Alex Morgan" },
] as const;
const Member = Schema.Struct({ userId: Schema.String, role: TestRole });
const SessionView = Schema.NullOr(
  Schema.Struct({
    user: Schema.Struct({ id: Schema.String }),
    session: Schema.Struct({ impersonatedBy: Schema.optionalKey(Schema.NullOr(Schema.String)) }),
  }),
);
const User = Schema.Struct({ id: Schema.String, name: Schema.String, email: Schema.String });
class MemberUnavailable extends Schema.TaggedError<MemberUnavailable>()("MemberUnavailable", {}) {}

/** List actual members on each read and verify membership again before returning a real session. */
export const hostedDevtools = (input: {
  readonly origin: string;
  readonly host: "cloud" | "self-host";
  readonly organization: string;
  readonly auth: ReturnType<typeof testAccountAuth>;
}) =>
  Effect.gen(function* () {
    const origin = yield* Schema.decodeUnknownEffect(LoopbackOrigin)(input.origin);
    const host = new URL(origin).host;
    const defaultOrganization = yield* Schema.decodeUnknownEffect(FixtureName)(input.organization);
    const context = yield* Effect.promise(() => input.auth.$context);
    const operator = yield* Effect.tryPromise(async () => {
      const existing = await context.internalAdapter.findUserById(DevtoolsOperatorId);
      if (existing !== null) {
        if (existing.email !== "devtools-operator@example.test")
          throw new Error("Local operator identity conflicts");
        return existing;
      }
      return context.test.saveUser(
        context.test.createUser({
          id: DevtoolsOperatorId,
          name: "Local developer",
          email: "devtools-operator@example.test",
          emailVerified: true,
        }),
      );
    });
    const existing = yield* Effect.tryPromise(() =>
      context.adapter.findOne({
        model: "organization",
        where: [{ field: "slug", value: defaultOrganization }],
        select: ["id"],
      }),
    );
    // Bootstrap a new development database once. Existing organizations keep their real members/roles.
    if (existing === null) {
      for (const fixture of fixtures)
        yield* provisionTestAccount(input.auth, {
          host: input.host,
          origin,
          organization: defaultOrganization,
          ...fixture,
        });
    }
    const organization = (reference: string) =>
      Effect.tryPromise(() =>
        context.adapter.findMany({
          model: "organization",
          where: [
            { field: "id", value: reference, connector: "OR" },
            { field: "slug", value: reference, connector: "OR" },
          ],
          select: ["id", "slug", "name"],
          limit: 2,
        }),
      ).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(DevtoolsOrganization))),
        Effect.flatMap((matches) =>
          matches.length === 1 && matches[0] !== undefined
            ? Effect.succeed(matches[0])
            : Effect.fail(new MemberUnavailable()),
        ),
      );
    const membership = (organizationId: string, userId: string) =>
      Effect.tryPromise(() =>
        context.adapter.findOne({
          model: "member",
          where: [
            { field: "organizationId", value: organizationId },
            { field: "userId", value: userId },
          ],
          select: ["id", "userId", "role"],
        }),
      ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.NullOr(Member))));
    const accounts = (organizationId: string) =>
      Effect.gen(function* () {
        const result: (typeof DevtoolsAccount.Type)[] = [];
        // Better Auth adapters apply default limits; explicitly traverse every membership page.
        for (let offset = 0; ; offset += 100) {
          const members = yield* Effect.tryPromise(() =>
            context.adapter.findMany({
              model: "member",
              where: [{ field: "organizationId", value: organizationId }],
              select: ["id", "userId", "role"],
              limit: 100,
              offset,
              sortBy: { field: "id", direction: "asc" },
            }),
          ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Member))));
          if (members.length === 0) break;
          const users = yield* Effect.tryPromise(() =>
            context.adapter.findMany({
              model: "user",
              where: [
                { field: "id", operator: "in", value: members.map((member) => member.userId) },
              ],
              select: ["id", "name", "email"],
              limit: members.length,
            }),
          ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(User))));
          const byId = new Map(users.map((user) => [user.id, user]));
          for (const member of members) {
            const user = byId.get(member.userId);
            if (user !== undefined) result.push({ ...user, role: member.role });
          }
          if (members.length < 100) break;
        }
        return result.sort(
          (left, right) =>
            left.name.localeCompare(right.name) || left.email.localeCompare(right.email),
        );
      });
    const status = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      if (
        request.headers.host !== host ||
        (request.headers.origin !== undefined && request.headers.origin !== origin)
      )
        return HttpServerResponse.empty({ status: 403 });
      const reference = yield* Schema.decodeUnknownEffect(Schema.NonEmptyString)(
        new URL(request.url, origin).searchParams.get("organization") ?? defaultOrganization,
      );
      const selectedOrganization = yield* organization(reference);
      const session = yield* Effect.tryPromise(() =>
        input.auth.api.getSession({
          headers: new Headers(request.headers),
          query: { disableRefresh: true, disableCookieCache: true },
        }),
      ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(SessionView)));
      const members = yield* accounts(selectedOrganization.id);
      const state = yield* Schema.decodeUnknownEffect(DevtoolsState)({
        kind: "accounts",
        host: input.host,
        organization: selectedOrganization,
        accounts: members,
        impersonating: session?.session.impersonatedBy != null,
        selected: members.find((member) => member.id === session?.user.id)?.id ?? null,
      });
      return yield* HttpServerResponse.json(state).pipe(
        Effect.map(HttpServerResponse.setHeader("cache-control", "no-store")),
      );
    }).pipe(
      Effect.catchTag("MemberUnavailable", () =>
        Effect.succeed(HttpServerResponse.empty({ status: 403 })),
      ),
      Effect.catchTag("SchemaError", () =>
        Effect.succeed(HttpServerResponse.empty({ status: 400 })),
      ),
      Effect.catch(() => Effect.succeed(HttpServerResponse.empty({ status: 503 }))),
    );
    const signIn = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      if (
        request.method !== "POST" ||
        request.headers.host !== host ||
        request.headers.origin !== origin
      )
        return HttpServerResponse.empty({ status: 403 });
      const body = yield* request.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(TestSignIn)));
      const selectedOrganization = yield* organization(body.organization);
      if ((yield* membership(selectedOrganization.id, body.userId)) === null)
        return yield* new MemberUnavailable();
      const operatorLogin = yield* Effect.tryPromise(() =>
        context.test.login({ userId: operator.id }),
      ).pipe(Effect.map(Redacted.make));
      const switched = yield* Effect.tryPromise(() =>
        input.auth.api.impersonateUser({
          body: { userId: body.userId },
          headers: Redacted.value(operatorLogin).headers,
          returnHeaders: true,
        }),
      ).pipe(
        Effect.map(Redacted.make),
        Effect.onError(() =>
          Effect.promise(() =>
            context.internalAdapter.deleteSession(Redacted.value(operatorLogin).session.token),
          ),
        ),
      );
      const invalidate = Effect.promise(async () => {
        await context.internalAdapter.deleteSession(
          Redacted.value(switched).response.session.token,
        );
        await context.internalAdapter.deleteSession(Redacted.value(operatorLogin).session.token);
      });
      const current = yield* membership(selectedOrganization.id, body.userId).pipe(
        Effect.onError(() => invalidate),
      );
      if (current === null) {
        yield* invalidate;
        return yield* new MemberUnavailable();
      }
      const response = (yield* HttpServerResponse.json({ status: true })).pipe(
        HttpServerResponse.mergeCookies(
          Cookies.fromSetCookie(Redacted.value(switched).headers.getSetCookie()),
        ),
      );
      return HttpServerResponse.setHeader(response, "cache-control", "no-store");
    }).pipe(
      Effect.catchTag("MemberUnavailable", () =>
        Effect.succeed(HttpServerResponse.empty({ status: 403 })),
      ),
      Effect.catchTag("HttpServerError", () =>
        Effect.succeed(HttpServerResponse.empty({ status: 400 })),
      ),
      Effect.catchTag("SchemaError", () =>
        Effect.succeed(HttpServerResponse.empty({ status: 400 })),
      ),
      Effect.catch(() => Effect.succeed(HttpServerResponse.empty({ status: 503 }))),
    );
    return { status, signIn };
  });
