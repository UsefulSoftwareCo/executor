import { Effect, Layer, type Redacted, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { V1Membership, V1MembershipUnavailable } from "../contracts/onboarding.ts";

/** Only the fields the decision reads; the rest of each WorkOS record is never decoded or kept. */
const Users = Schema.Struct({ data: Schema.Array(Schema.Struct({ id: Schema.String })) });
const Memberships = Schema.Struct({
  data: Schema.Array(Schema.Struct({ status: Schema.String })),
});

/** v1's WorkOS environment and the moment the check shipped. */
export interface V1MembershipSettings {
  /** WorkOS API origin, or an emulator instance in tests. */
  readonly baseUrl: string;
  readonly key: Redacted.Redacted<string>;
  /** Accounts created before this instant used v2 before the check existed and skip it. */
  readonly since: Date;
}

/** Self-host, local Cloud and test stages without v1's key admit every account. */
export const v1MembershipDisabled = Layer.succeed(
  V1Membership,
  V1Membership.of({ check: () => Effect.succeed("continue") }),
);

/**
 * Reads v1's WorkOS with two list calls: the user with this email, then that user's active
 * organization memberships. Any active membership, whatever its role, keeps the account on v1.
 * Emails and WorkOS responses never enter errors, logs or spans.
 */
export const v1MembershipLive = (settings: V1MembershipSettings) =>
  Layer.effect(
    V1Membership,
    Effect.gen(function* () {
      const client = (yield* HttpClient.HttpClient).pipe(
        HttpClient.mapRequest((request) =>
          request.pipe(
            HttpClientRequest.prependUrl(settings.baseUrl),
            HttpClientRequest.bearerToken(settings.key),
            HttpClientRequest.acceptJson,
          ),
        ),
        HttpClient.filterStatusOk,
      );
      const list = <S extends Schema.Top>(
        path: string,
        params: Record<string, string>,
        schema: S,
      ) =>
        client
          .execute(HttpClientRequest.get(path).pipe(HttpClientRequest.setUrlParams(params)))
          .pipe(
            Effect.flatMap((response) => response.json),
            Effect.flatMap(Schema.decodeUnknownEffect(schema)),
          );
      const member = (email: string) =>
        Effect.gen(function* () {
          const users = yield* list("/user_management/users", { email }, Users);
          // WorkOS emails are unique, so this is at most one user.
          for (const user of users.data) {
            const memberships = yield* list(
              "/user_management/organization_memberships",
              { user_id: user.id, statuses: "active" },
              Memberships,
            );
            if (memberships.data.some((membership) => membership.status === "active")) return true;
          }
          return false;
        });
      return V1Membership.of({
        check: (account) =>
          account.createdAt < settings.since
            ? Effect.succeed("continue")
            : member(account.email).pipe(
                Effect.timeout("10 seconds"),
                Effect.map((found) => (found ? ("v1" as const) : ("continue" as const))),
                Effect.tapError(() => Effect.logWarning("v1 membership check unavailable")),
                Effect.mapError(() => new V1MembershipUnavailable()),
                Effect.withSpan("onboarding.v1Membership"),
              ),
      });
    }),
  );
