import {
  distTagsPath,
  newerRelease,
  releasesFromDistTags,
  ReleaseVersion,
} from "@executor-js/utils/release-version";
import { SessionAuthentication } from "@executor-js/hosted-server/auth";
import { OrganizationReference } from "@executor-js/hosted-server/organization";
import type { RegistryRead } from "@executor-js/sdk/workerd";
import { Clock, Config, Duration, Effect, Option, Ref, Schedule, Schema } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";

export class UpdateCheckNotRecorded extends Schema.TaggedError<UpdateCheckNotRecorded>()(
  "UpdateCheckNotRecorded",
  { reason: Schema.String },
) {}

class UpdateCheckUnanswered extends Schema.TaggedError<UpdateCheckUnanswered>()(
  "UpdateCheckUnanswered",
  {},
) {}

export interface UpdateCheckStore {
  readonly location: string;
  readonly read: Effect.Effect<Option.Option<string>>;
  readonly write: (value: string) => Effect.Effect<void, UpdateCheckNotRecorded>;
}

export const UpdateAvailable = Schema.Struct({
  current: ReleaseVersion,
  available: ReleaseVersion,
});
export type UpdateAvailable = typeof UpdateAvailable.Type;

const LastCheck = Schema.fromJsonString(
  Schema.Struct({
    checkedAt: Schema.Number,
    beta: Schema.optional(ReleaseVersion),
    latest: Schema.optional(ReleaseVersion),
  }),
);

const checkInterval = Duration.days(1);
const requestTimeout = Duration.seconds(5);

export const updateCheckDisabled = Config.Boolean("EXECUTOR_NO_UPDATE_CHECK").pipe(
  Config.withDefault(false),
);

export const selfHostUpdateCheck = (registry: RegistryRead, store: UpdateCheckStore) =>
  Effect.gen(function* () {
    const found = yield* Ref.make(Option.none<UpdateAvailable>());
    const current = Option.flatMap(
      yield* Config.String("EXECUTOR_BUILD_VERSION").pipe(Config.option),
      Schema.decodeUnknownOption(ReleaseVersion),
    );
    if (Option.isNone(current) || (yield* updateCheckDisabled)) return Ref.get(found);
    const ask = registry(distTagsPath).pipe(
      Effect.filterOrFail(
        (answer) => answer.status === 200,
        () => new UpdateCheckUnanswered(),
      ),
      Effect.flatMap((answer) =>
        Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(answer.body),
      ),
      Effect.map(releasesFromDistTags),
      Effect.timeout(requestTimeout),
    );
    const unrecorded = yield* Ref.make(false);
    const record = (value: typeof LastCheck.Type) =>
      store.write(Schema.encodeSync(LastCheck)(value)).pipe(
        Effect.tapError((error) =>
          Ref.getAndSet(unrecorded, true).pipe(
            Effect.flatMap((already) =>
              already
                ? Effect.void
                : Effect.logWarning(
                    `Self-host update check is off: it cannot write its record to ${store.location} (${error.reason}), and asks the registry only once it can.`,
                  ),
            ),
          ),
        ),
        Effect.tap(() =>
          Ref.getAndSet(unrecorded, false).pipe(
            Effect.flatMap((was) =>
              was
                ? Effect.logInfo(
                    `Self-host update check is on again: it wrote its record to ${store.location}.`,
                  )
                : Effect.void,
            ),
          ),
        ),
      );
    const check = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const saved = yield* store.read.pipe(
        Effect.flatMap((value) =>
          Option.isNone(value)
            ? Effect.succeedNone
            : Schema.decodeUnknownEffect(LastCheck)(value.value).pipe(Effect.option),
        ),
      );
      const last = Option.getOrUndefined(saved);
      const due = last === undefined || now - last.checkedAt >= Duration.toMillis(checkInterval);
      const kept = { checkedAt: now, beta: last?.beta, latest: last?.latest };
      const known = due
        ? yield* record({ ...last, checkedAt: now }).pipe(
            Effect.andThen(ask),
            Effect.map((releases) => ({ checkedAt: now, ...releases })),
            Effect.tap(record),
            Effect.catchTag("UpdateCheckNotRecorded", () => Effect.succeed(kept)),
            Effect.catchCause(() =>
              Effect.logDebug("Self-host update check did not answer").pipe(Effect.as(kept)),
            ),
          )
        : last;
      const newer = newerRelease(current.value, known);
      yield* Ref.set(
        found,
        newer === undefined
          ? Option.none()
          : Option.some({ current: current.value, available: newer }),
      );
    }).pipe(Effect.catchCause(() => Effect.logDebug("Self-host update check did not answer")));
    yield* check.pipe(Effect.repeat(Schedule.spaced("1 hour")), Effect.forkScoped);
    return Ref.get(found);
  });

export const selfHostUpdateStatus = (found: Effect.Effect<Option.Option<UpdateAvailable>>) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const auth = yield* SessionAuthentication;
    const reference = Schema.decodeUnknownOption(OrganizationReference)(
      new URL(request.url, "http://localhost").searchParams.get("organization"),
    );
    const principal = yield* auth.current(new Headers(request.headers));
    if (principal === null || Option.isNone(reference))
      return HttpServerResponse.empty({ status: 401 });
    const organization = yield* auth.organization(reference.value);
    const { role } = yield* auth.membership(principal, organization);
    if (role === "member") return HttpServerResponse.empty({ status: 403 });
    return HttpServerResponse.jsonUnsafe(
      { update: Option.getOrNull(yield* found) },
      { headers: { "cache-control": "private, no-store" } },
    );
  }).pipe(Effect.catch(() => Effect.succeed(HttpServerResponse.empty({ status: 403 }))));
