/** Pending connection ownership is persisted; knowing a connection ID grants no authority. */
import {
  StorageError,
  type AccountConnection,
  type AccountConnectionId,
} from "@executor-js/sdk/core";
import { requireGroupSharing } from "./group-sharing.ts";
import { Effect, Schema } from "effect";
import { OrganizationForbidden } from "../contracts/organization.ts";
import { ConnectionAccess, type ConnectionDestination } from "../contracts/resource-access.ts";
import {
  currentResourceAuthority,
  policyDatabase,
  requireAppAccess,
  requireAccountAccess,
} from "./resource-policy.ts";

/** Reject an inaccessible destination before creating or resuming a connection. */
export const checkDestination = (destination: typeof ConnectionDestination.Type) =>
  Effect.gen(function* () {
    if (destination.kind !== "shared" || destination.audience.kind !== "groups") return;
    const actor = yield* currentResourceAuthority;
    const sql = yield* policyDatabase;
    yield* sql.withTransaction(
      requireGroupSharing(sql, actor.organization, actor.user, destination.audience.groups),
    );
  }).pipe(
    Effect.catchTags({ SqlError: () => new StorageError(), SchemaError: () => new StorageError() }),
  );

/** Save the reviewed destination before exposing the connection URL. */
export const recordConnection = (
  connection: AccountConnection,
  destination: typeof ConnectionDestination.Type,
) =>
  Effect.gen(function* () {
    const actor = yield* currentResourceAuthority;
    const sql = yield* policyDatabase;
    const target =
      connection.target === null
        ? null
        : JSON.stringify({
            app: connection.target.app,
            requirement: connection.target.requirement,
          });
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* checkDestination(destination);
        yield* sql`insert into hosted_connection_access (connection_id, organization_id, creator_id, destination, target)
      values (${connection.id}, ${actor.organization}, ${actor.user}, ${JSON.stringify(destination)}::jsonb, ${target}::jsonb)`;
      }),
    );
    return connection;
  }).pipe(Effect.catchTag("SqlError", () => new StorageError()));
/** Read current ownership and target management rights before every step, including OAuth return. */
export const connectionAccess = (connection: AccountConnectionId) =>
  Effect.gen(function* () {
    const actor = yield* currentResourceAuthority;
    const sql = yield* policyDatabase;
    const rows =
      yield* sql`select connection_id as connection, creator_id as creator, destination, target
    from hosted_connection_access where connection_id = ${connection} and organization_id = ${actor.organization}
    and creator_id = ${actor.user}`;
    const access = (yield* Schema.decodeUnknownEffect(Schema.Array(ConnectionAccess))(rows))[0];
    if (access === undefined) return yield* new OrganizationForbidden();
    if (access.target !== null) yield* requireAppAccess(access.target.app, "manage");
    yield* checkDestination(access.destination);
    return access;
  }).pipe(
    Effect.catchTags({ SqlError: () => new StorageError(), SchemaError: () => new StorageError() }),
  );
/** Reconnect checks the saved account as well as the pending request. */
export const checkConnection = (connection: AccountConnection) =>
  Effect.gen(function* () {
    const access = yield* connectionAccess(connection.id);
    if (connection.reconnectAccount !== null)
      yield* requireAccountAccess(connection.reconnectAccount.id, "manage");
    return access;
  });
