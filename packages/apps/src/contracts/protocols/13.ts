/**
 * Host protocol 13 adds app and user account scopes. Frozen schemas import only earlier protocols;
 * changing a live framework contract cannot change this retained boundary.
 */
import { Schema } from "effect";
import {
  DeclaredProvider,
  DeclaredRequirements as PreviousRequirements,
  HostInvocation as PreviousInvocation,
  ResolvedAccount,
  HostRequest as PreviousRequest,
  HostedRouter,
  HostedCatalog as PreviousCatalog,
  HostedCatalogSummary as PreviousCatalogSummary,
  protocol12,
} from "./12.ts";

import {
  OperationSchedule as PreviousSchedule,
  JsonValue,
  JsonObject,
  ToolAnnotations,
} from "./1.ts";

export * from "./12.ts";

const OperationSchedule = Schema.Struct({
  name: PreviousSchedule.fields.name,
  scope: Schema.optionalKey(Schema.Literal("app")),
  timing: PreviousSchedule.fields.timing,
  input: PreviousSchedule.fields.input,
});
export const HostedTool = Schema.Struct({
  schedules: Schema.optionalKey(Schema.Array(OperationSchedule)),
  name: Schema.NonEmptyString,
  router: Schema.optionalKey(Schema.NonEmptyString),
  tags: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
  description: Schema.String,
  inputSchema: JsonObject,
  readOnly: Schema.optionalKey(Schema.Boolean),
  kindConfirmed: Schema.optionalKey(Schema.Boolean),
  title: Schema.optionalKey(Schema.String),
  outputSchema: Schema.optionalKey(JsonObject),
  annotations: Schema.optionalKey(ToolAnnotations),
  _meta: Schema.optionalKey(JsonObject),
});
export const HostedToolSummary = HostedTool.mapFields(
  ({ inputSchema: _input, outputSchema: _output, _meta, ...fields }) => fields,
);
export const HostedCatalog = Schema.Struct({
  ...PreviousCatalog.fields,
  tools: Schema.Array(HostedTool),
});
export const HostedCatalogSummary = Schema.Struct({
  ...PreviousCatalogSummary.fields,
  tools: Schema.Array(HostedToolSummary),
});
const SharedSchemaKey = Schema.Literals(["inputSchema", "outputSchema"]);
const HostedSharedTool = Schema.Struct({
  ...HostedTool.fields,
  shared: Schema.optionalKey(Schema.Array(SharedSchemaKey)),
});
const HostedSharedCatalog = Schema.Struct({
  tools: Schema.Array(HostedSharedTool),
  routers: Schema.Array(HostedRouter),
  definitions: Schema.Array(JsonValue),
  defs: Schema.Array(Schema.Record(Schema.String, Schema.Int)),
});
const Inspect = Schema.Struct({
  operation: Schema.Literal("inspect"),
  detail: Schema.optionalKey(Schema.Literal("summary")),
  tools: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
  scheduled: Schema.optionalKey(Schema.Literal(true)),
  definitions: Schema.optionalKey(Schema.Literal("shared")),
});
export const HostRequest = Schema.Union(
  PreviousRequest.members.map((member, index) => (index === 3 ? Inspect : member)),
);

export const DeclaredAccountSlot = Schema.Struct({
  definition: DeclaredProvider,
  cardinality: Schema.Literals(["one", "many"]),
  health: Schema.optionalKey(Schema.Literal(true)),
});
export const DeclaredAccountSlots = Schema.Record(Schema.NonEmptyString, DeclaredAccountSlot);
export const DeclaredRequirements = Schema.Struct({
  ...PreviousRequirements.fields,
  capabilities: Schema.optionalKey(
    Schema.Struct({
      ...PreviousRequirements.fields.capabilities.schema.fields,
      sharedDefinitions: Schema.optionalKey(Schema.Literal(true)),
    }),
  ),
  accounts: Schema.Struct({ app: DeclaredAccountSlots, user: DeclaredAccountSlots }),
});

export const ResolvedAccountSlots = Schema.Record(
  Schema.NonEmptyString,
  Schema.Union([ResolvedAccount, Schema.Array(ResolvedAccount)]),
);
export const ResolvedAccounts = Schema.Struct({
  app: ResolvedAccountSlots,
  user: Schema.optionalKey(ResolvedAccountSlots),
});
export const HostInvocation = Schema.Struct({
  ...PreviousInvocation.fields,
  command: HostRequest,
  accounts: ResolvedAccounts,
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
