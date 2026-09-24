/** Local organization member switching; production never mounts these handlers. */
import { LoopbackOrigin } from "@executor-js/utils/url-policy";
import { Effect, Redacted, Schema } from "effect";
import { Cookies, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { DevtoolsState } from "@executor-js/devtools/contracts";
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
/** Bootstrap a loopback-only operator; all user listing and impersonation use native auth routes. */
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
        return context.internalAdapter.updateUser(existing.id, { role: "admin" });
      }
      return context.test.saveUser(
        context.test.createUser({
          id: DevtoolsOperatorId,
          name: "Local developer",
          email: "devtools-operator@example.test",
          emailVerified: true,
          role: "admin",
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
    const allowed = (request: HttpServerRequest.HttpServerRequest, write: boolean) =>
      request.headers.host === host &&
      (write
        ? request.headers.origin === origin
        : request.headers.origin === undefined || request.headers.origin === origin);
    const status = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      if (!allowed(request, false)) return HttpServerResponse.empty({ status: 403 });
      return yield* HttpServerResponse.json({
        kind: "operator",
        host: input.host,
      } satisfies typeof DevtoolsState.Type).pipe(
        Effect.map(HttpServerResponse.setHeader("cache-control", "no-store")),
      );
    });
    const signIn = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      if (request.method !== "POST" || !allowed(request, true))
        return HttpServerResponse.empty({ status: 403 });
      const login = yield* Effect.tryPromise(() =>
        context.test.login({ userId: operator.id }),
      ).pipe(Effect.map(Redacted.make));
      const headers = new Headers();
      for (const cookie of Redacted.value(login).cookies)
        headers.append(
          "set-cookie",
          `${cookie.name}=${cookie.value}; Path=/; HttpOnly; SameSite=Lax`,
        );
      return (yield* HttpServerResponse.json({ status: true })).pipe(
        HttpServerResponse.mergeCookies(Cookies.fromSetCookie(headers.getSetCookie())),
        HttpServerResponse.setHeader("cache-control", "no-store"),
      );
    }).pipe(Effect.catch(() => Effect.succeed(HttpServerResponse.empty({ status: 503 }))));
    return { status, signIn };
  });
