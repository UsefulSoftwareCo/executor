/** Host protocol 8 adds sanitized MCP transport fallback diagnostics. */
import { Schema } from "effect";
import { McpError } from "../mcp.ts";
import { McpError as LegacyMcpError } from "../mcp-error-legacy.ts";
import {
  HostError as PreviousHostError,
  HostRouterError as PreviousHostRouterError,
  HostedRouter as PreviousHostedRouter,
  HostedCatalog as PreviousHostedCatalog,
  HostedCatalogSummary as PreviousHostedCatalogSummary,
  HostResponse as PreviousHostResponse,
  protocol7,
} from "./7.ts";

export * from "./7.ts";

export const HostError = Schema.Union([
  McpError,
  ...PreviousHostError.members.filter((member) => member !== LegacyMcpError),
]);
export type HostError = typeof HostError.Type;

export const HostRouterError = Schema.Union([
  McpError,
  ...PreviousHostRouterError.members.filter((member) => member !== LegacyMcpError),
]);
export type HostRouterError = typeof HostRouterError.Type;

export const HostedRouter = Schema.Struct({
  ...PreviousHostedRouter.fields,
  error: Schema.optionalKey(HostRouterError),
});
export type HostedRouter = typeof HostedRouter.Type;

export const HostedCatalog = Schema.Struct({
  ...PreviousHostedCatalog.fields,
  routers: Schema.Array(HostedRouter),
});
export type HostedCatalog = typeof HostedCatalog.Type;

export const HostedCatalogSummary = Schema.Struct({
  ...PreviousHostedCatalogSummary.fields,
  routers: Schema.Array(HostedRouter),
});
export type HostedCatalogSummary = typeof HostedCatalogSummary.Type;

export const HostResponse = Schema.Union([
  PreviousHostResponse.members[0],
  Schema.Struct({ ok: Schema.Literal(false), error: HostError }),
]);
export type HostResponse = typeof HostResponse.Type;

export const protocol8 = {
  version: 8,
  schemas: {
    ...protocol7.schemas,
    response: HostResponse,
    catalog: HostedCatalog,
    catalogSummary: HostedCatalogSummary,
  },
} as const;
