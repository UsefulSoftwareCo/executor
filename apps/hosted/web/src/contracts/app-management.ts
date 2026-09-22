import { retainProtectedFailure } from "./protected-query.ts";
import type { HostedError } from "./errors.ts";
/** Organization keys isolate app reads and independent copy operations. */
import { makeAppManagementAtoms } from "@executor-js/ui/contracts/app-management";
import type { OrganizationReference } from "@executor-js/hosted-server/organization";
import { Effect } from "effect";
import { Atom } from "effect/unstable/reactivity";
import { HostedClient } from "./api.ts";
export const appManagement = Atom.family((organization: OrganizationReference) =>
  makeAppManagementAtoms<HostedClient, HostedError>(
    HostedClient.runtime,
    Effect.map(HostedClient, (client) => client.appManagement),
    { organization },
    retainProtectedFailure,
  ),
);
