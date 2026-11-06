/** Cloud is the multi-organization product, so only cloud exposes removal. */
import {
  audited,
  beginOrganizationRemoval,
  previewOrganizationRemoval,
  OrganizationId,
  type OrganizationRemovalUnavailable,
} from "@executor-js/hosted-server";
import { Context, Effect, Schema } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { HttpServerResponse } from "effect/http";
import {
  dispatchAcceptedRemoval,
  OrganizationRemovalStart,
} from "../infrastructure/organization-removal-workflow.ts";
import { OrganizationRemovalRecovery } from "../infrastructure/organization-removal-recovery.ts";
import { ExecutorCloudApi } from "../contracts/api.ts";

/** The tombstones among a list of organizations, read together rather than one at a time. */
export class RemovedOrganizations extends Context.Service<
  RemovedOrganizations,
  (
    organizations: ReadonlyArray<OrganizationId>,
  ) => Effect.Effect<ReadonlySet<OrganizationId>, OrganizationRemovalUnavailable>
>()("cloud/RemovedOrganizations") {}

/** Native membership rows outlive acceptance; never put a removed team back in the switcher. */
export const hideRemovedOrganizations = (response: HttpServerResponse.HttpServerResponse) =>
  Effect.gen(function* () {
    if (response.status !== 200) return response;
    const removedAmong = yield* RemovedOrganizations;
    const entries = yield* Effect.tryPromise(() => HttpServerResponse.toWeb(response).json()).pipe(
      Effect.flatMap(
        Schema.decodeUnknownEffect(Schema.Array(Schema.Record(Schema.String, Schema.Unknown))),
      ),
    );
    const listed = yield* Effect.forEach(entries, (entry) =>
      Schema.decodeUnknownEffect(OrganizationId)(entry.id).pipe(
        Effect.map((id) => ({ id, entry })),
      ),
    );
    const removed = yield* removedAmong(listed.map(({ id }) => id));
    const visible = listed.flatMap(({ id, entry }) => (removed.has(id) ? [] : [entry]));
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
      const start = yield* OrganizationRemovalStart;
      const recover = yield* OrganizationRemovalRecovery;
      return handlers
        .handle("preview", () => previewOrganizationRemoval)
        .handle("remove", () =>
          Effect.gen(function* () {
            // Refuse, then hide. The tombstone commits before anything is
            // deleted, so from here no request resolves this organization and the
            // durable erasure that follows races with nothing.
            const { started, instance } = yield* beginOrganizationRemoval;
            // The tombstone is also a durable start record, so the workflow
            // starts after the response; the recovery alarm and the minute job
            // start any it could not.
            yield* dispatchAcceptedRemoval(start, recover, started.organization, instance);
            return started;
          }).pipe(
            audited("organization.delete", {
              kind: "organization",
              id: (started) => started.organization,
            }),
          ),
        );
    }),
);
