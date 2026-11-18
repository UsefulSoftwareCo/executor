/**
 * The self-host server's check for a newer release, for its owners and admins to see. It asks the
 * npm registry the instance already installs app packages from (`EXECUTOR_NPM_REGISTRY`, by
 * default registry.npmjs.org) for the `executor` package's dist-tags, as the CLI does: one GET of
 * `/-/package/executor/dist-tags`, with no query, no cookie, no instance identifier and no header of
 * its own (not even a trace's). The apps Worker sends it (`RegistryRead`, its `/registry` route),
 * the same Worker and `fetch` that app installs reach that registry by, on the native server and in
 * the image alike: the network that reaches private addresses as well as public ones, which
 * connects directly and reads no `HTTP_PROXY` or `HTTPS_PROXY`. So a mirror that installs read, on a
 * private network or plain HTTP, answers the check too, and the check goes nowhere installs do not.
 * It follows no redirect, and never asks the public registry in place of a configured one. It asks
 * at most once a day whatever the outcome: each attempt is recorded in the instance's storage
 * before the request goes out, so neither a failed answer nor a restart asks again within the day,
 * and when the attempt cannot be recorded it does not ask. The last releases the registry named
 * are kept with the time of the last attempt, and shown until an answer names others: a release
 * that existed still exists while the registry cannot be reached. `EXECUTOR_NO_UPDATE_CHECK=1`
 * turns it off, as for the CLI; a build with no release version never asks. Members' browsers ask
 * the instance, never the registry.
 *
 * It runs in the background and never delays startup or a request. A registry it cannot reach or
 * read logs one debug line. A record it cannot write turns the check off until one can be: that
 * logs one warning, which names where the record goes, and one line when a write succeeds again.
 */
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

/** The check's record could not be written, so the check does not ask; `reason` says why. */
export class UpdateCheckNotRecorded extends Schema.TaggedError<UpdateCheckNotRecorded>()(
  "UpdateCheckNotRecorded",
  { reason: Schema.String },
) {}

/** The registry did not answer with dist-tags. */
class UpdateCheckUnanswered extends Schema.TaggedError<UpdateCheckUnanswered>()(
  "UpdateCheckUnanswered",
  {},
) {}

/** Where the last answer is kept: a file in the data directory, or the product actor's storage. */
export interface UpdateCheckStore {
  /** Where the record goes, for an operator to look: a file's path, or the storage it is in. */
  readonly location: string;
  readonly read: Effect.Effect<Option.Option<string>>;
  readonly write: (value: string) => Effect.Effect<void, UpdateCheckNotRecorded>;
}

/** A newer release than the one this instance runs. */
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

/** Off with `EXECUTOR_NO_UPDATE_CHECK=1`, the CLI's setting. */
export const updateCheckDisabled = Config.Boolean("EXECUTOR_NO_UPDATE_CHECK").pipe(
  Config.withDefault(false),
);

/**
 * Start the check in the background of the server's scope, and return what it last found: a newer
 * release, or none. `registry` reads the registry app installs use, as they reach it; the check
 * reads only its dist-tags.
 */
export const selfHostUpdateCheck = (registry: RegistryRead, store: UpdateCheckStore) =>
  Effect.gen(function* () {
    const found = yield* Ref.make(Option.none<UpdateAvailable>());
    // A development or commit build names no release version.
    const current = Option.flatMap(
      yield* Config.String("EXECUTOR_BUILD_VERSION").pipe(Config.option),
      Schema.decodeUnknownOption(ReleaseVersion),
    );
    // Without a release to compare, it asks nothing.
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
    // Whether the last write of the record failed: the warning is logged once while it lasts, and
    // the first write that succeeds after it says so.
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
      // The attempt is recorded before the request goes out, keeping the releases last named, so
      // a failed or unanswered request, or a restart while it is open, does not ask again today.
      // When it cannot be recorded, the request does not go out: nothing would stop the next
      // hour's look, or a restart, from asking again. Either way the releases last named stay.
      const kept = { checkedAt: now, beta: last?.beta, latest: last?.latest };
      const known = due
        ? yield* record({ ...last, checkedAt: now }).pipe(
            Effect.andThen(ask),
            Effect.map((releases) => ({ checkedAt: now, ...releases })),
            Effect.tap(record),
            // `record` has warned once; a debug line each hour would only repeat it.
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
    // Each hour it looks whether a day has passed since the last answer; only then does it ask.
    yield* check.pipe(Effect.repeat(Schedule.spaced("1 hour")), Effect.forkScoped);
    return Ref.get(found);
  });

/**
 * `GET /api/self-host/update?organization=<slug>`: what the check last found, for an owner or
 * admin of that organization; members and anyone signed out get nothing. The answer is
 * `{ "update": { "current", "available" } }`, or `{ "update": null }`.
 */
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
