/**
 * Rolling back a v1 organization that moved into an existing v2 organization (`notes/v1-import.md`,
 * decision 32). The organization is its owner's own, so it stays; only what the import added to it
 * goes: its apps, its accounts, members' toolkit copies and the memberships it added. Every one is
 * found through the import map, so whatever its users added themselves stays.
 */
import {
  CurrentUserId,
  HostedExecutor,
  organizationOwner,
  type McpConnectionStore,
  type OrganizationId,
} from "@executor-js/hosted-server";
import { AccountId, AppId, OAuthGrantImport } from "@executor-js/sdk/core";
import { ConnectionId } from "@executor-js/mcp-auth/connections";
import { Effect, Schema } from "effect";
import { V1ImportDatabase, V1ImportUnavailable } from "../../contracts/v1-import.ts";
import { makeImportStore } from "./store.ts";

const Actors = Schema.Array(Schema.Struct({ actor: Schema.NullOr(Schema.String) }));
const ConnectionUsers = Schema.Array(
  Schema.Struct({ userId: Schema.String, revoked: Schema.Boolean }),
);

/** What a rollback removed from the existing organization, or why it removed nothing. */
export type ImportedRemoval =
  | {
      readonly removed: {
        readonly apps: number;
        readonly accounts: number;
        readonly toolkitCopies: number;
        readonly members: number;
      };
    }
  | { readonly refused: string };

/**
 * Remove from `target` what importing `organization` into it added. Refused, removing nothing,
 * when its users changed an imported app or toolkit copy since: that is their work now. Accounts go
 * without revoking their grants at the provider, which v1 holds too and uses again once the
 * organization is back. Running it again after it stopped part way removes the rest.
 */
export const removeImported = (
  organization: string,
  target: OrganizationId,
  connections: McpConnectionStore,
) =>
  Effect.gen(function* () {
    const sql = yield* Effect.flatten(V1ImportDatabase);
    const executor = yield* Effect.flatten(HostedExecutor);
    const store = makeImportStore(sql);
    const owner = organizationOwner(target);
    const rows = (yield* store.rows(organization)).flatMap((row) =>
      row.status === "imported" && row.v2_id !== null ? [{ ...row, v2_id: row.v2_id }] : [],
    );
    // Integrations' apps, connections' own apps (decision 33) and artifacts' apps.
    const apps = rows.filter(
      (row) =>
        (row.v1_kind === "integration" ||
          row.v1_kind === "connection_app" ||
          row.v1_kind === "artifact") &&
        (row.v2_kind === "app" || row.v2_kind === "undeployed_app"),
    );
    const copies = rows.filter(
      (row) => row.v1_kind === "toolkit" && row.v2_kind === "mcp_connection",
    );
    const changed: string[] = [];
    for (const row of [...apps, ...copies]) {
      const kind =
        row.v1_kind === "toolkit"
          ? "toolkit"
          : row.v1_kind === "artifact"
            ? "artifact"
            : row.v1_kind === "connection_app"
              ? "connection_app"
              : "integration";
      if ((yield* store.sinceImported(kind, row.v1_id)) === "changed") changed.push(row.v1_id);
    }
    if (changed.length > 0)
      return {
        refused: `Its users changed ${changed.length} imported apps or toolkit copies in v2 since; roll it back by hand.`,
      } satisfies ImportedRemoval;

    let toolkitCopies = 0;
    for (const row of copies) {
      const [found] = yield* sql`
        select "userId", revoked from "mcpConnection" where id = ${row.v2_id} and resource = ${target}
      `.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(ConnectionUsers)),
        Effect.mapError(() => new V1ImportUnavailable()),
      );
      if (found === undefined || found.revoked) continue;
      yield* connections
        .revoke({ userId: found.userId, resource: target }, ConnectionId.make(row.v2_id))
        .pipe(Effect.catchTag("ConnectionNotFound", () => Effect.void));
      toolkitCopies++;
    }
    // Apps first, which ends their webhooks and workflows, then the accounts they used.
    const inUse = (kind: string) => () =>
      Effect.succeed({
        refused: `An imported ${kind} still has webhooks or workflows running; roll it back once they stop.`,
      } satisfies ImportedRemoval);
    for (const row of apps) {
      const stopped = yield* executor.apps
        .remove({ owner, app: AppId.make(row.v2_id) })
        .pipe(
          Effect.as(undefined),
          Effect.catchTags({ AppWebhooksActive: inUse("app"), AppWorkflowsActive: inUse("app") }),
        );
      if (stopped !== undefined) return stopped;
    }
    const accounts = [
      ...new Set(rows.flatMap((row) => (row.v2_kind === "account" ? [row.v2_id] : []))),
    ];
    for (const account of accounts) {
      // Removed as the member it is personal to, or as its creator, the owner the import acted as.
      const [access] = yield* sql`
        select coalesce(personal_user_id, creator_id) as actor from hosted_account_access
        where account_id = ${account} and organization_id = ${target}
      `.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Actors)),
        Effect.mapError(() => new V1ImportUnavailable()),
      );
      if (access === undefined) continue;
      const stopped = yield* executor[OAuthGrantImport]
        .removeImportedAccount({
          owner,
          account: AccountId.make(account),
        })
        .pipe(
          Effect.provideService(CurrentUserId, access.actor ?? undefined),
          Effect.as(undefined),
          Effect.catchTags({
            AccountWebhooksActive: inUse("account"),
            AccountWorkflowsActive: inUse("account"),
          }),
        );
      if (stopped !== undefined) return stopped;
    }
    // Members the import added, never one who was there before it or the organization's owner.
    const members = yield* sql`
      delete from member where "organizationId" = ${target} and role <> 'owner'
        and id in (
          select v2_id from private_v1_import_map
          where v1_org_id = ${organization} and v1_kind = 'membership' and status = 'imported'
            and v2_kind = 'member'
        )
      returning id
    `.pipe(Effect.mapError(() => new V1ImportUnavailable()));
    return {
      removed: {
        apps: apps.length,
        accounts: accounts.length,
        toolkitCopies,
        members: members.length,
      },
    } satisfies ImportedRemoval;
  });
