/**
 * Stored OAuth clients belong to their owner and authorization server (issuer) from SDK 4.0.12,
 * so one client serves every app that signs in at that server. These steps move what earlier
 * versions stored by provider. The executor decides where each client goes; the steps walk them.
 *
 * `8_oauth_clients_by_issuer` records the server of each client stored before 4.0.12, whether a
 * 4.0.10 or 4.0.11 server stored it or `6_stored_oauth_clients` moved it. Clients of one owner
 * holding the same credentials for the same server become one. Outcomes:
 * - `migrated` / `would_migrate`: its server is recorded, with its current credentials under its
 *   owner and server; any other client of its set is merged into it.
 * - `merged` / `would_merge`: merged into its set's surviving client, which keeps every
 *   credentials record it had, so a grant's copy of its credentials is the survivor.
 * - `already_migrated`: its server was recorded by an earlier pass.
 * - `issuer_unknown`: its provider discovers its server and no sign-in recorded which; left as it
 *   is, offered to no sign-in, and its credentials stay its own. Register it again for its server.
 * - `access_conflict`: its set's audiences cannot be combined into one; every client of the set is
 *   left as it is, as for `issuer_unknown`.
 * - `absent`: removed since the pass listed it.
 * - `unreadable`: its record cannot be read with this host's key.
 * - `unavailable`: storage failed or another write claimed its credentials; a later pass retries.
 *
 * `9_saved_oauth_clients_by_issuer` moves the saved clients of versions before 4.0.10 as step 6
 * does, except to the owner's client for the server the owner's accounts signed in at. When the
 * accounts holding a record belong to several owners, the one whose settings rebuild the record's
 * key saved it. Outcomes are step 6's, with `ambiguous_owner` when no single owner is found that
 * way and `ambiguous_issuer` when that owner's accounts signed in at more than one server.
 */
import { SavedOAuthClientsHost, type Executor } from "@executor-js/sdk/core";
import { Effect } from "effect";
import type { DataStep, DataStepMode } from "../contracts/data-steps.ts";

/** The host services the steps read and write through. */
export interface OAuthClientsByIssuerHost {
  readonly executor: Executor;
}

/** Journal names. They never change and the steps never repeat. */
export const oauthClientsByIssuerStepName = "8_oauth_clients_by_issuer";
export const savedOAuthClientsByIssuerStepName = "9_saved_oauth_clients_by_issuer";

export const oauthClientsByIssuerStep = (host: OAuthClientsByIssuerHost): DataStep<never> => ({
  name: oauthClientsByIssuerStepName,
  retry: ["unavailable"],
  items: host.executor[SavedOAuthClientsHost].issuerItems.pipe(
    Effect.map((items) =>
      items.map((item) => ({
        id: item.id,
        owner: item.owner,
        run: (mode: DataStepMode) => item.migrate(mode === "apply"),
      })),
    ),
  ),
});

export const savedOAuthClientsByIssuerStep = (host: OAuthClientsByIssuerHost): DataStep<never> => ({
  name: savedOAuthClientsByIssuerStepName,
  retry: ["unavailable"],
  items: host.executor[SavedOAuthClientsHost].itemsByIssuer.pipe(
    Effect.map((items) =>
      items.map((item) => ({
        id: item.id,
        owner: item.owner ?? "",
        run: (mode: DataStepMode) => item.move(mode === "apply"),
      })),
    ),
  ),
});
