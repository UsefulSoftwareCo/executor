/** Cloud is the multi-organization product, so only cloud exposes removal. */
import {
  beginOrganizationRemoval,
  previewOrganizationRemoval,
  OrganizationId,
  OrganizationTombstones,
} from "@executor-js/hosted-server";
import { Effect, Schema } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { HttpServerResponse } from "effect/unstable/http";
import { OrganizationRemoval } from "../infrastructure/organization-removal-workflow.ts";
import { ExecutorCloudApi } from "../contracts/api.ts";

/** Native membership rows outlive acceptance; never put a removed team back in the switcher. */
export const hideRemovedOrganizations = (response: HttpServerResponse.HttpServerResponse) =>
  Effect.gen(function* () {
    if (response.status !== 200) return response;
    const removed = yield* OrganizationTombstones;
    const entries = yield* Effect.tryPromise(() => HttpServerResponse.toWeb(response).json()).pipe(
      Effect.flatMap(
        Schema.decodeUnknownEffect(Schema.Array(Schema.Record(Schema.String, Schema.Unknown))),
      ),
    );
    const visible = yield* Effect.filter(entries, (entry) =>
      Schema.decodeUnknownEffect(OrganizationId)(entry.id).pipe(
        Effect.flatMap(removed),
        Effect.map((deleted) => !deleted),
      ),
    );
    return yield* HttpServerResponse.json(visible, {
      headers: response.headers,
      cookies: response.cookies,
    });
  });

export const organizationRemovalHandlers = HttpApiBuilder.group(
  ExecutorCloudApi,
  "organizationRemoval",
  (handlers) =>
    Effect.gen(function* () {
      const workflow = yield* OrganizationRemoval;
      return handlers
        .handle("preview", () => previewOrganizationRemoval)
        .handle("remove", () =>
          Effect.gen(function* () {
            // Refuse, then hide. The tombstone commits before anything is
            // deleted, so from here no request resolves this organization and the
            // durable erasure that follows races with nothing.
            const { started, instance } = yield* beginOrganizationRemoval;
            // The instance id is the organization id, so a repeated request is the
            // same removal. Adopt the existing run rather than starting a second
            // one over the same records, and treat a create whose response was
            // lost as started if the instance is there afterwards.
            const status = workflow.get(instance).pipe(
              Effect.flatMap((run) => run.status()),
              Effect.map((state) => state.status),
              Effect.catchCause(() => Effect.succeed("unknown")),
            );
            if ((yield* status) === "unknown")
              yield* workflow
                .create({ id: instance, params: { organization: started.organization } })
                .pipe(
                  Effect.catchCause((cause) =>
                    Effect.flatMap(status, (current) =>
                      current === "unknown" ? Effect.failCause(cause) : Effect.void,
                    ),
                  ),
                );
            return started;
          }),
        );
    }),
);
