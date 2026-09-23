import { organizationsAtom } from "@executor-js/hosted-web/contracts/organization";
/** Removal is a cloud capability; self-host keeps its single instance organization. */
import { acknowledge } from "@executor-js/ui/contracts/mutations";
import { Cause, Effect, Match, Option, type Schema } from "effect";
import { Atom } from "effect/unstable/reactivity";
import type { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import type { HttpClientError } from "effect/unstable/http";
import type { OrganizationId } from "@executor-js/hosted-server/organization";
import { ExecutorCloudApi } from "../../../src/contracts/api.ts";
import { CloudClient } from "./billing.ts";

type Removal = HttpApiGroup.Endpoints<(typeof ExecutorCloudApi.groups)["organizationRemoval"]>;
/** The precise failures this one destructive request can produce. */
export type OrganizationRemovalError =
  | HttpApiEndpoint.Errors<Removal>
  | HttpClientError.HttpClientError
  | Schema.SchemaError;

const message = Match.type<OrganizationRemovalError>().pipe(
  Match.tags({
    AppWorkflowsActive: () =>
      "A workflow is still running. Wait for it to finish, then delete the organization.",
    AccountWorkflowsActive: () =>
      "A running workflow is still using a saved account. Wait for it to finish, then delete the organization.",
    OrganizationForbidden: () => "Only an organization owner can delete it.",
    OrganizationRemovalUnavailable: () => "Deletion is unavailable right now. Try again shortly.",
    AuthenticationUnavailable: () => "Sign-in is unavailable. Try again shortly.",
    HttpClientError: () => "Could not reach the server. Check your connection and try again.",
  }),
  Match.orElse(() => "The organization could not be deleted. Try again."),
);
/** Safe copy for the delete dialog; defects never render their raw cause. */
export const organizationRemovalError = (cause: Cause.Cause<OrganizationRemovalError>) =>
  Option.match(Cause.findErrorOption(cause), {
    onSome: message,
    onNone: () => "The organization could not be deleted. Try again.",
  });

/** Removal counts include private resources that the normal inventory must omit. */
export const organizationRemovalPreviewAtom = Atom.family((organization: OrganizationId) =>
  CloudClient.query("organizationRemoval", "preview", { params: { organization } }).pipe(
    Atom.refreshOnWindowFocus,
  ),
);

/**
 * Publish the removal to every organization reader before the dialog closes, so
 * the entry route cannot send this tab back into an organization that is gone.
 */
export const deleteOrganizationAtom = Atom.family((organization: OrganizationId) =>
  CloudClient.runtime.fn((_: void, get) =>
    Effect.flatMap(CloudClient, (client) =>
      client.organizationRemoval.remove({ params: { organization } }),
    ).pipe(
      Effect.tap((removed) =>
        Effect.sync(() =>
          acknowledge(get, organizationsAtom, (current) =>
            current.filter((entry) => entry.id !== removed.organization),
          ),
        ),
      ),
    ),
  ),
);
