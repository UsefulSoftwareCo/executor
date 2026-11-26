import {
  audited,
  CurrentPrincipal,
  previewUserRemoval,
  removeUser,
} from "@executor-js/hosted-server";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import {
  dispatchAcceptedRemoval,
  OrganizationRemovalStart,
} from "../infrastructure/organization-removal-workflow.ts";
import { OrganizationRemovalRecovery } from "../infrastructure/organization-removal-recovery.ts";
import { ExecutorCloudApi } from "../contracts/api.ts";

export const userRemovalHandlers = HttpApiBuilder.group(
  ExecutorCloudApi,
  "userRemoval",
  (handlers) =>
    Effect.gen(function* () {
      const start = yield* OrganizationRemovalStart;
      const recover = yield* OrganizationRemovalRecovery;
      return handlers
        .handle("preview", () => previewUserRemoval)
        .handle("remove", () =>
          Effect.gen(function* () {
            const principal = yield* CurrentPrincipal;
            const removed = yield* removeUser;
            for (const organization of removed.organizations)
              yield* dispatchAcceptedRemoval(start, recover, organization, organization);
            return { removed, user: principal.userId };
          }).pipe(
            audited("user.delete", { kind: "user", id: (result) => result.user }),
            Effect.map((result) => result.removed),
          ),
        );
    }),
);
