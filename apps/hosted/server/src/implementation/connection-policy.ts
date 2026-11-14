/** Pending connection ownership is persisted; knowing a connection ID grants no authority. */
import {
  StorageError,
  type AccountConnection,
  type AccountConnectionId,
  type AccountScope,
} from "@executor-js/sdk/core";
import { Effect, Schema } from "effect";
import { OrganizationForbidden, OrganizationId } from "../contracts/organization.ts";
import { ConnectionAccess } from "../contracts/resource-access.ts";
import {
  currentResourceAuthority,
  policyDatabase,
  requireAppAccess,
  requireAccountOwner,
} from "./resource-policy.ts";

/** Save the connection's creator and target before exposing the connection URL. */
export const recordConnection = (connection: AccountConnection, scope: AccountScope) =>
  Effect.gen(function* () {
    const actor = yield* currentResourceAuthority;
    const sql = yield* policyDatabase;
    const target = JSON.stringify(
      yield* Schema.encodeEffect(ConnectionAccess.fields.target)({
        app: connection.target.app,
        requirement: connection.target.requirement,
        scope,
      }),
    );
    // destination is no longer read; it stays required until a later release drops the column.
    yield* sql`insert into hosted_connection_access (connection_id, organization_id, creator_id, destination, target)
      values (${connection.id}, ${actor.organization}, ${actor.user}, '{"kind":"personal"}'::jsonb, ${target}::jsonb)`;
    return connection;
  }).pipe(
    Effect.catchTags({ SqlError: () => new StorageError(), SchemaError: () => new StorageError() }),
  );
/**
 * Read current ownership and target rights before every step, including OAuth return: use of the
 * app for a user requirement, management of it for an app requirement, which links the account for everyone.
 */
export const connectionAccess = (connection: AccountConnectionId) =>
  Effect.gen(function* () {
    const actor = yield* currentResourceAuthority;
    const sql = yield* policyDatabase;
    const rows = yield* sql`select connection_id as connection, creator_id as creator, target
    from hosted_connection_access where connection_id = ${connection} and organization_id = ${actor.organization}
    and creator_id = ${actor.user}`;
    const access = (yield* Schema.decodeUnknownEffect(Schema.Array(ConnectionAccess))(rows))[0];
    if (access === undefined) return yield* new OrganizationForbidden();
    yield* requireAppAccess(access.target.app, access.target.scope === "app" ? "manage" : "use");
    return access;
  }).pipe(
    Effect.catchTags({ SqlError: () => new StorageError(), SchemaError: () => new StorageError() }),
  );
/** The organization where this user created the connection; nobody else's creation qualifies. */
export const createdConnectionOrganization = (connection: AccountConnectionId, user: string) =>
  Effect.gen(function* () {
    const sql = yield* policyDatabase;
    const rows = yield* sql`select organization_id as organization from hosted_connection_access
    where connection_id = ${connection} and creator_id = ${user}`;
    const created = (yield* Schema.decodeUnknownEffect(
      Schema.Array(Schema.Struct({ organization: OrganizationId })),
    )(rows))[0];
    if (created === undefined) return yield* new OrganizationForbidden();
    return created.organization;
  }).pipe(
    Effect.catchTags({ SqlError: () => new StorageError(), SchemaError: () => new StorageError() }),
  );
/** Reconnect checks the saved account as well as the pending request. */
export const checkConnection = (connection: AccountConnection) =>
  Effect.gen(function* () {
    const access = yield* connectionAccess(connection.id);
    if (connection.reconnectAccount !== null)
      yield* requireAccountOwner(connection.reconnectAccount.id);
    return access;
  });
