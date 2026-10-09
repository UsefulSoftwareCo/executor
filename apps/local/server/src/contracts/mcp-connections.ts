/** Scoped MCP connections owned by the paired local operator. */
import {
  AccountNotFound,
  AccountSelectionInvalid,
  AppNotFound,
  ProfileErrors,
  StorageError,
} from "@executor-js/sdk/core";
import {
  ConnectionAccessInvalid,
  ConnectionId,
  ConnectionIdTaken,
  ConnectionInput,
  ConnectionName,
  ConnectionNotFound,
  ConnectionView,
} from "@executor-js/mcp-auth/connections";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { AuthStorageError } from "./auth.ts";

const path = "/dashboard/api/mcp/connections";
const connection = { connection: ConnectionId };
/** Saving may create profiles for bare accounts, so it reports profile and account failures. */
const saveErrors = [
  AuthStorageError,
  ConnectionAccessInvalid,
  StorageError,
  AppNotFound,
  AccountNotFound,
  AccountSelectionInvalid,
  ...ProfileErrors,
] as const;
/** Dashboard pairing authorizes these routes; MCP bearer credentials cannot reach them. */
export const DashboardMcpConnections = HttpApiGroup.make("mcpConnections")
  .add(
    HttpApiEndpoint.get("list", path, {
      success: Schema.Array(ConnectionView),
      error: AuthStorageError,
    }),
  )
  .add(
    HttpApiEndpoint.post("create", path, {
      payload: ConnectionInput,
      success: ConnectionView,
      error: [...saveErrors, ConnectionIdTaken],
    }),
  )
  .add(
    HttpApiEndpoint.put("update", `${path}/:connection`, {
      params: connection,
      payload: Schema.Struct({ name: ConnectionName, apps: ConnectionInput.fields.apps }),
      success: ConnectionView,
      error: [...saveErrors, ConnectionNotFound],
    }),
  )
  .add(
    HttpApiEndpoint.post("revoke", `${path}/:connection/revoke`, {
      params: connection,
      success: Schema.Void,
      error: [AuthStorageError, ConnectionNotFound],
    }),
  );
