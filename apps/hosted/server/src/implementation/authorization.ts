import { permitsApp, permitsTool } from "@executor-js/authorization";
import type { AppId, ToolName } from "@executor-js/sdk/core";
import { Effect } from "effect";
import { CurrentAuthorization } from "../contracts/authorization.ts";
import { OrganizationForbidden } from "../contracts/organization.ts";

/** Check the shared app policy before reading or evaluating an app; ownership is checked separately. */
export const authorizeApp = (app: AppId) =>
  Effect.gen(function* () {
    const policy = yield* CurrentAuthorization;
    if (!permitsApp(policy, app)) return yield* new OrganizationForbidden();
    return policy;
  });
/** Check exact tool identity before executing or resuming work, independent of HTTP/MCP authentication. */
export const authorizeTool = (app: AppId, tool: ToolName) =>
  Effect.gen(function* () {
    const policy = yield* CurrentAuthorization;
    if (!permitsTool(policy, app, tool)) return yield* new OrganizationForbidden();
  });
