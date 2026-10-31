/**
 * Host protocol 13 adds app and user account scopes. App-scope work omits user accounts.
 * This released boundary imports only earlier protocols and remains frozen.
 */
import { Schema } from "effect";
import {
  DeclaredRequirements as PreviousRequirements,
  HostInvocation as PreviousInvocation,
  ResolvedAccounts as PreviousAccounts,
  HostedTool as PreviousTool,
  HostedRouter,
  HostRequest as PreviousRequest,
  protocol12,
} from "./12.ts";
import { JsonValue, OperationSchedule as PreviousSchedule } from "./1.ts";

export * from "./12.ts";

export const DeclaredRequirements = Schema.Struct({
  ...PreviousRequirements.fields,
  capabilities: Schema.optionalKey(
    Schema.Struct({
      skills: Schema.Literal(true),
      toolIndex: Schema.optionalKey(Schema.Literal(true)),
      skillSources: Schema.optionalKey(Schema.Literal(true)),
      scheduledTools: Schema.optionalKey(Schema.Literal(true)),
      sharedDefinitions: Schema.optionalKey(Schema.Literal(true)),
    }),
  ),
  accounts: Schema.Struct({
    app: PreviousRequirements.fields.accounts,
    user: PreviousRequirements.fields.accounts,
  }),
});

export const ResolvedAccounts = Schema.Struct({
  app: PreviousAccounts,
  user: Schema.optionalKey(PreviousAccounts),
});

export const HostRequest = Schema.Union(
  PreviousRequest.members.map((member) => {
    if ("fields" in member && "detail" in member.fields)
      return Schema.Struct({
        ...member.fields,
        definitions: Schema.optionalKey(Schema.Literal("shared")),
      });
    return member;
  }),
);

export const OperationSchedule = Schema.Struct({
  name: PreviousSchedule.fields.name,
  scope: Schema.optionalKey(Schema.Literal("app")),
  timing: PreviousSchedule.fields.timing,
  input: PreviousSchedule.fields.input,
});
export const HostedTool = Schema.Struct({
  schedules: Schema.optionalKey(Schema.Array(OperationSchedule)),
  name: PreviousTool.fields.name,
  router: PreviousTool.fields.router,
  tags: PreviousTool.fields.tags,
  description: PreviousTool.fields.description,
  inputSchema: PreviousTool.fields.inputSchema,
  readOnly: PreviousTool.fields.readOnly,
  kindConfirmed: Schema.optionalKey(Schema.Boolean),
  title: PreviousTool.fields.title,
  outputSchema: PreviousTool.fields.outputSchema,
  annotations: PreviousTool.fields.annotations,
  _meta: PreviousTool.fields._meta,
});
export const HostedToolSummary = HostedTool.mapFields(
  ({ inputSchema: _input, outputSchema: _output, _meta, ...fields }) => fields,
);
export const HostedCatalog = Schema.Struct({
  tools: Schema.Array(HostedTool),
  routers: Schema.Array(HostedRouter),
});
export const HostedCatalogSummary = Schema.Struct({
  tools: Schema.Array(HostedToolSummary),
  routers: Schema.Array(HostedRouter),
});
export const HostedSharedTool = Schema.Struct({
  ...HostedTool.fields,
  shared: Schema.optionalKey(Schema.Array(Schema.Literals(["inputSchema", "outputSchema"]))),
});
export const HostedSharedCatalog = Schema.Struct({
  tools: Schema.Array(HostedSharedTool),
  routers: Schema.Array(HostedRouter),
  definitions: Schema.Array(JsonValue),
  defs: Schema.Array(Schema.Record(Schema.String, Schema.Int)),
});

export const HostInvocation = Schema.Struct({
  ...PreviousInvocation.fields,
  accounts: ResolvedAccounts,
  command: HostRequest,
});

export const protocol13 = {
  version: 13,
  schemas: {
    ...protocol12.schemas,
    requirements: DeclaredRequirements,
    accounts: ResolvedAccounts,
    invocation: HostInvocation,
    request: HostRequest,
    catalog: HostedCatalog,
    catalogSummary: HostedCatalogSummary,
    sharedCatalog: HostedSharedCatalog,
  },
} as const;
