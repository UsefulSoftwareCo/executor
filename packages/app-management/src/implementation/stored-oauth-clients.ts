/**
 * One-off: move the saved OAuth clients of executor storage before 4.0.10 into stored clients, the
 * resources connections name. The executor decides where each saved client goes; this step walks
 * them. A report says what applying would do without writing. Outcomes:
 * - `moved` / `would_move`: stored under the one owner whose accounts signed in with it. Grants
 *   are not changed: a sign-in using credentials a stored client holds uses that client.
 * - `already_moved`: a stored client from this saved one exists, as after an earlier pass.
 * - `duplicate`: a stored client holds or held its credentials, such as one moved from another
 *   saved record with the same credentials, or one registered since; credentials are one client
 *   per owner and provider, and a grant holding them resolves to that client. A report reads the
 *   same, so it agrees with applying.
 * - `no_account`: no account signed in with it, so its owner is unknown; not moved.
 * - `machine_client`: a client credentials client, which only its account's grant keeps.
 * - `ambiguous_owner`: accounts of several owners or providers hold it; not moved. Its journal
 *   owner is why instead, such as
 *   `ambiguous:owners=2,providers=1,secret=yes,source=manual,resolvable_by_key=yes,provider_ids=…`,
 *   so the summary's `owners` groups ambiguous clients by cause.
 * - `absent`: removed since the pass listed it.
 * - `unreadable`: its record cannot be read with this host's key.
 * - `unavailable`: storage failed; a later pass retries it.
 */
import { SavedOAuthClientsHost, type Executor } from "@executor-js/sdk/core";
import { Effect } from "effect";
import type { DataStep, DataStepMode } from "../contracts/data-steps.ts";

/** The host services the step reads and writes through. */
export interface StoredOAuthClientsHost {
  readonly executor: Executor;
}

/** The journal name. It never changes and the step never repeats. */
export const storedOAuthClientsStepName = "6_stored_oauth_clients";

export const storedOAuthClientsStep = (host: StoredOAuthClientsHost): DataStep<never> => ({
  name: storedOAuthClientsStepName,
  retry: ["unavailable"],
  items: host.executor[SavedOAuthClientsHost].items.pipe(
    Effect.map((items) =>
      items.map((item) => ({
        id: item.id,
        owner: item.owner ?? item.bucket ?? "",
        run: (mode: DataStepMode) => item.move(mode === "apply"),
      })),
    ),
  ),
});
