/**
 * Where a v1 workspace moved, as metadata on its v1 WorkOS organization (`notes/v1-import.md`).
 * v1 may read it to show a "you've moved" notice. It does not freeze v1 or redirect anything: the
 * opt-in import copies, and the moved flag (`moved-flag.ts`) is only for the later automatic move.
 */
import { Effect, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import type { V1SourceSettings } from "./source.ts";

/** The v2 organization's slug the workspace was imported into. */
export const movedSlugKey = "executor_v2_org_slug";
/** When the first finished import recorded the move, as an ISO 8601 timestamp. */
export const movedAtKey = "executor_v2_moved_at";

const Organization = Schema.Struct({
  metadata: Schema.optional(Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown))),
});

export const makeV1MovedNotice = (
  settings: Pick<V1SourceSettings, "workosUrl" | "workosKey">,
  http: HttpClient.HttpClient,
) => {
  const workos = http.pipe(
    HttpClient.mapRequest((request) =>
      request.pipe(
        HttpClientRequest.prependUrl(settings.workosUrl),
        HttpClientRequest.bearerToken(settings.workosKey),
        HttpClientRequest.acceptJson,
      ),
    ),
    HttpClient.filterStatusOk,
  );
  return {
    /**
     * Record the move (`at`, ISO 8601) unless the organization already names this slug. WorkOS merges metadata
     * updates key by key, so only these two keys are sent and every other key stays. A recorded
     * time is kept, so finishing again changes nothing; a failed write is retried by the next
     * finish.
     */
    record: (input: {
      readonly organization: string;
      readonly slug: string;
      readonly at: string;
    }) =>
      Effect.gen(function* () {
        const path = `/organizations/${encodeURIComponent(input.organization)}`;
        const current = yield* workos.execute(HttpClientRequest.get(path)).pipe(
          Effect.flatMap((response) => response.json),
          Effect.flatMap(Schema.decodeUnknownEffect(Organization)),
        );
        const metadata = current.metadata ?? {};
        const at = metadata[movedAtKey];
        if (metadata[movedSlugKey] === input.slug && typeof at === "string") return;
        yield* workos.execute(
          HttpClientRequest.put(path).pipe(
            HttpClientRequest.bodyJsonUnsafe({
              metadata: {
                [movedSlugKey]: input.slug,
                [movedAtKey]: typeof at === "string" ? at : input.at,
              },
            }),
          ),
        );
      }),
  };
};
