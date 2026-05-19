// ---------------------------------------------------------------------------
// core-tools plugin
//
// Built-in plugin that contributes agent-facing static tools for configuring
// executor-level primitives. The important boundary: sensitive values never
// travel through tool arguments. Agents create secret placeholders and OAuth
// sessions, then hand the returned browser URL to the user.
// ---------------------------------------------------------------------------

import { Data, Effect, Schema } from "effect";

import { ConnectionRef } from "./connections";
import { CredentialBindingRef, CredentialBindingValue } from "./credential-bindings";
import { ConnectionId, ScopeId, SecretId } from "./ids";
import { OAuthStrategy as OAuthStrategySchema } from "./oauth";
import { definePlugin, tool, type StaticToolSchema } from "./plugin";
import { ToolPolicyActionSchema } from "./policies";
import { ToolResult } from "./tool-result";
import { SourceDetectionResult } from "./types";
import { Usage } from "./usages";

const schemaToStandard = <A, I>(schema: Schema.Decoder<A, I>): StaticToolSchema<A, I> =>
  Schema.toStandardSchemaV1(Schema.toStandardJSONSchemaV1(schema) as never) as StaticToolSchema<
    A,
    I
  >;

const UnknownRecord = Schema.Record(Schema.String, Schema.Unknown);

const ScopeName = Schema.String;

const ScopesListOutput = Schema.Struct({
  scopes: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
    }),
  ),
});

const SecretRefOutput = Schema.Struct({
  id: Schema.String,
  scopeId: Schema.String,
  name: Schema.String,
  provider: Schema.String,
});

const SecretsListOutput = Schema.Struct({
  secrets: Schema.Array(SecretRefOutput),
});

const SecretsCreateInput = Schema.Struct({
  name: Schema.String,
  scope: Schema.optional(ScopeName),
  provider: Schema.optional(Schema.String),
});

const SecretsCreateOutput = Schema.Struct({
  id: Schema.String,
  url: Schema.String,
  instructions: Schema.String,
});

const SecretPointerInput = Schema.Struct({
  id: Schema.String,
});

const SecretScopedPointerInput = Schema.Struct({
  id: Schema.String,
  targetScope: Schema.String,
});

const SecretStatusOutput = Schema.Struct({
  id: Schema.String,
  status: Schema.Literals(["resolved", "missing"]),
});

const SecretUsagesOutput = Schema.Struct({
  usages: Schema.Array(Usage),
});

const ProvidersOutput = Schema.Struct({
  providers: Schema.Array(Schema.String),
});

const RemovedOutput = Schema.Struct({
  removed: Schema.Boolean,
});

const RefreshedOutput = Schema.Struct({
  refreshed: Schema.Boolean,
});

const SourceOutput = Schema.Struct({
  id: Schema.String,
  scopeId: Schema.optional(Schema.String),
  kind: Schema.String,
  name: Schema.String,
  url: Schema.optional(Schema.String),
  pluginId: Schema.String,
  canRemove: Schema.Boolean,
  canRefresh: Schema.Boolean,
  canEdit: Schema.Boolean,
  runtime: Schema.Boolean,
});

const SourcesListOutput = Schema.Struct({
  sources: Schema.Array(SourceOutput),
});

const SourcesDetectInput = Schema.Struct({
  url: Schema.String,
});

const SourcesDetectOutput = Schema.Struct({
  results: Schema.Array(SourceDetectionResult),
});

const SourcePresetOutput = Schema.Struct({
  pluginId: Schema.String,
  id: Schema.String,
  name: Schema.String,
  summary: Schema.String,
  url: Schema.optional(Schema.String),
  endpoint: Schema.optional(Schema.String),
  icon: Schema.optional(Schema.String),
  featured: Schema.optional(Schema.Boolean),
  transport: Schema.optional(Schema.Literals(["remote", "stdio"])),
  command: Schema.optional(Schema.String),
  args: Schema.optional(Schema.Array(Schema.String)),
  env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});

const SourcesPresetsInput = Schema.Struct({
  query: Schema.optional(Schema.String),
  pluginId: Schema.optional(Schema.String),
  featuredOnly: Schema.optional(Schema.Boolean),
  limit: Schema.optional(Schema.Number),
});

const SourcesPresetsOutput = Schema.Struct({
  presets: Schema.Array(SourcePresetOutput),
});

const SourcePointer = Schema.Struct({
  id: Schema.String,
  scope: Schema.String,
});

const SourcesConfigureInput = Schema.Struct({
  source: SourcePointer,
  scope: Schema.String,
  type: Schema.optional(Schema.String),
  config: Schema.Unknown,
});

const SourcesConfigureOutput = Schema.Struct({
  result: Schema.Unknown,
});

const SourceLifecycleInput = Schema.Struct({
  id: Schema.String,
  targetScope: Schema.String,
});

const SourceBindingsListInput = Schema.Struct({
  source: SourcePointer,
});

const SourceBindingsResolveInput = Schema.Struct({
  source: SourcePointer,
  slotKey: Schema.String,
});

const SourceBindingsSetInput = Schema.Struct({
  scope: Schema.String,
  source: SourcePointer,
  slotKey: Schema.String,
  value: CredentialBindingValue,
});

const SourceBindingsRemoveInput = Schema.Struct({
  scope: Schema.String,
  source: SourcePointer,
  slotKey: Schema.String,
});

const SourceBindingsListOutput = Schema.Struct({
  bindings: Schema.Array(CredentialBindingRef),
});

const SourceBindingsResolveOutput = Schema.Struct({
  binding: Schema.NullOr(CredentialBindingRef),
});

const SourceBindingsSetOutput = Schema.Struct({
  binding: CredentialBindingRef,
});

const ConnectionsListOutput = Schema.Struct({
  connections: Schema.Array(ConnectionRef),
});

const ConnectionPointerInput = Schema.Struct({
  id: Schema.String,
});

const ConnectionScopedPointerInput = Schema.Struct({
  id: Schema.String,
  targetScope: Schema.String,
});

const ConnectionUsagesOutput = Schema.Struct({
  usages: Schema.Array(Usage),
});

const PolicyOutput = Schema.Struct({
  id: Schema.String,
  scopeId: Schema.String,
  pattern: Schema.String,
  action: ToolPolicyActionSchema,
  position: Schema.String,
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
});

const PoliciesListOutput = Schema.Struct({
  policies: Schema.Array(PolicyOutput),
});

const PolicyCreateInput = Schema.Struct({
  targetScope: Schema.String,
  pattern: Schema.String,
  action: ToolPolicyActionSchema,
  position: Schema.optional(Schema.String),
});

const PolicyUpdateInput = Schema.Struct({
  id: Schema.String,
  targetScope: Schema.String,
  pattern: Schema.optional(Schema.String),
  action: Schema.optional(ToolPolicyActionSchema),
  position: Schema.optional(Schema.String),
});

const PolicyRemoveInput = Schema.Struct({
  id: Schema.String,
  targetScope: Schema.String,
});

const PolicyMutationOutput = Schema.Struct({
  policy: PolicyOutput,
});

const OAuthProbeInput = Schema.Struct({
  endpoint: Schema.String,
  headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  queryParams: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});

const OAuthProbeOutput = Schema.Struct({
  resourceMetadata: Schema.NullOr(UnknownRecord),
  resourceMetadataUrl: Schema.NullOr(Schema.String),
  authorizationServerMetadata: Schema.NullOr(UnknownRecord),
  authorizationServerMetadataUrl: Schema.NullOr(Schema.String),
  authorizationServerUrl: Schema.NullOr(Schema.String),
  supportsDynamicRegistration: Schema.Boolean,
  isBearerChallengeEndpoint: Schema.Boolean,
});

const OAuthStartInput = Schema.Struct({
  credentialScope: Schema.optional(Schema.String),
  endpoint: Schema.String,
  connectionId: Schema.String,
  pluginId: Schema.String,
  identityLabel: Schema.optional(Schema.String),
  redirectUrl: Schema.optional(Schema.String),
  headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  queryParams: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  strategy: OAuthStrategySchema,
});

const OAuthStartOutput = Schema.Struct({
  sessionId: Schema.String,
  authorizationUrl: Schema.NullOr(Schema.String),
  completedConnection: Schema.NullOr(Schema.Struct({ connectionId: Schema.String })),
  instructions: Schema.String,
});

const OAuthCancelInput = Schema.Struct({
  credentialScope: Schema.optional(Schema.String),
  sessionId: Schema.String,
});

const OAuthCancelOutput = Schema.Struct({
  cancelled: Schema.Boolean,
});

const ScopesListOutputStd = schemaToStandard(ScopesListOutput);
const SecretsListOutputStd = schemaToStandard(SecretsListOutput);
const SecretsCreateInputStd = schemaToStandard<
  typeof SecretsCreateInput.Type,
  typeof SecretsCreateInput.Encoded
>(SecretsCreateInput);
const SecretsCreateOutputStd = schemaToStandard(SecretsCreateOutput);
const SecretPointerInputStd = schemaToStandard<
  typeof SecretPointerInput.Type,
  typeof SecretPointerInput.Encoded
>(SecretPointerInput);
const SecretScopedPointerInputStd = schemaToStandard<
  typeof SecretScopedPointerInput.Type,
  typeof SecretScopedPointerInput.Encoded
>(SecretScopedPointerInput);
const SecretStatusOutputStd = schemaToStandard(SecretStatusOutput);
const SecretUsagesOutputStd = schemaToStandard(SecretUsagesOutput);
const ProvidersOutputStd = schemaToStandard(ProvidersOutput);
const RemovedOutputStd = schemaToStandard(RemovedOutput);
const RefreshedOutputStd = schemaToStandard(RefreshedOutput);
const SourcesListOutputStd = schemaToStandard(SourcesListOutput);
const SourcesDetectInputStd = schemaToStandard<
  typeof SourcesDetectInput.Type,
  typeof SourcesDetectInput.Encoded
>(SourcesDetectInput);
const SourcesDetectOutputStd = schemaToStandard(SourcesDetectOutput);
const SourcesPresetsInputStd = schemaToStandard<
  typeof SourcesPresetsInput.Type,
  typeof SourcesPresetsInput.Encoded
>(SourcesPresetsInput);
const SourcesPresetsOutputStd = schemaToStandard(SourcesPresetsOutput);
const SourcesConfigureInputStd = schemaToStandard<
  typeof SourcesConfigureInput.Type,
  typeof SourcesConfigureInput.Encoded
>(SourcesConfigureInput);
const SourcesConfigureOutputStd = schemaToStandard(SourcesConfigureOutput);
const SourceLifecycleInputStd = schemaToStandard<
  typeof SourceLifecycleInput.Type,
  typeof SourceLifecycleInput.Encoded
>(SourceLifecycleInput);
const SourceBindingsListInputStd = schemaToStandard<
  typeof SourceBindingsListInput.Type,
  typeof SourceBindingsListInput.Encoded
>(SourceBindingsListInput);
const SourceBindingsResolveInputStd = schemaToStandard<
  typeof SourceBindingsResolveInput.Type,
  typeof SourceBindingsResolveInput.Encoded
>(SourceBindingsResolveInput);
const SourceBindingsSetInputStd = schemaToStandard<
  typeof SourceBindingsSetInput.Type,
  typeof SourceBindingsSetInput.Encoded
>(SourceBindingsSetInput);
const SourceBindingsRemoveInputStd = schemaToStandard<
  typeof SourceBindingsRemoveInput.Type,
  typeof SourceBindingsRemoveInput.Encoded
>(SourceBindingsRemoveInput);
const SourceBindingsListOutputStd = schemaToStandard(SourceBindingsListOutput);
const SourceBindingsResolveOutputStd = schemaToStandard(SourceBindingsResolveOutput);
const SourceBindingsSetOutputStd = schemaToStandard(SourceBindingsSetOutput);
const ConnectionsListOutputStd = schemaToStandard(ConnectionsListOutput);
const ConnectionPointerInputStd = schemaToStandard<
  typeof ConnectionPointerInput.Type,
  typeof ConnectionPointerInput.Encoded
>(ConnectionPointerInput);
const ConnectionScopedPointerInputStd = schemaToStandard<
  typeof ConnectionScopedPointerInput.Type,
  typeof ConnectionScopedPointerInput.Encoded
>(ConnectionScopedPointerInput);
const ConnectionUsagesOutputStd = schemaToStandard(ConnectionUsagesOutput);
const PoliciesListOutputStd = schemaToStandard(PoliciesListOutput);
const PolicyCreateInputStd = schemaToStandard<
  typeof PolicyCreateInput.Type,
  typeof PolicyCreateInput.Encoded
>(PolicyCreateInput);
const PolicyUpdateInputStd = schemaToStandard<
  typeof PolicyUpdateInput.Type,
  typeof PolicyUpdateInput.Encoded
>(PolicyUpdateInput);
const PolicyRemoveInputStd = schemaToStandard<
  typeof PolicyRemoveInput.Type,
  typeof PolicyRemoveInput.Encoded
>(PolicyRemoveInput);
const PolicyMutationOutputStd = schemaToStandard(PolicyMutationOutput);
const OAuthProbeInputStd = schemaToStandard<
  typeof OAuthProbeInput.Type,
  typeof OAuthProbeInput.Encoded
>(OAuthProbeInput);
const OAuthProbeOutputStd = schemaToStandard(OAuthProbeOutput);
const OAuthStartInputStd = schemaToStandard<
  typeof OAuthStartInput.Type,
  typeof OAuthStartInput.Encoded
>(OAuthStartInput);
const OAuthStartOutputStd = schemaToStandard(OAuthStartOutput);
const OAuthCancelInputStd = schemaToStandard<
  typeof OAuthCancelInput.Type,
  typeof OAuthCancelInput.Encoded
>(OAuthCancelInput);
const OAuthCancelOutputStd = schemaToStandard(OAuthCancelOutput);

export interface CoreToolsPluginOptions {
  readonly webBaseUrl?: string;
}

class CoreToolsConfigurationError extends Data.TaggedError("CoreToolsConfigurationError")<{
  readonly message: string;
}> {}

class CoreToolsScopeNotFoundError extends Data.TaggedError("CoreToolsScopeNotFoundError")<{
  readonly scope: string;
  readonly message: string;
}> {}

const findScopeByNameOrId = (
  scopes: readonly { readonly id: ScopeId; readonly name: string }[],
  value: string,
) => scopes.find((scope) => scope.name === value || String(scope.id) === value);

const resolveScopeInput = (
  scopes: readonly { readonly id: ScopeId; readonly name: string }[],
  value: string | undefined,
) => {
  if (value === undefined) {
    const [onlyScope] = scopes;
    return onlyScope && scopes.length === 1
      ? Effect.succeed(String(onlyScope.id))
      : Effect.fail(
          new CoreToolsScopeNotFoundError({
            scope: "",
            message:
              scopes.length === 0
                ? "No visible scopes are available."
                : "Multiple scopes are visible. Call scopes.list and pass the target scope id or name.",
          }),
        );
  }

  const scope = findScopeByNameOrId(scopes, value);
  return scope
    ? Effect.succeed(String(scope.id))
    : Effect.fail(
        new CoreToolsScopeNotFoundError({
          scope: value,
          message: `Unknown scope "${value}". Call scopes.list to see valid scope ids and names.`,
        }),
      );
};

const normalizeCredentialBindingValue = (
  value: typeof CredentialBindingValue.Encoded,
): CredentialBindingValue => {
  if (value.kind === "text") {
    return value;
  }
  if (value.kind === "secret") {
    return {
      kind: "secret",
      secretId: SecretId.make(value.secretId),
      ...(value.secretScopeId ? { secretScopeId: ScopeId.make(value.secretScopeId) } : {}),
    };
  }
  return {
    kind: "connection",
    connectionId: ConnectionId.make(value.connectionId),
  };
};

const oauthToolFailure = (code: string, message: string, details?: unknown) =>
  ToolResult.fail({
    code,
    message,
    ...(details === undefined ? {} : { details }),
  });

const requireWebBaseUrl = (value: string | undefined) =>
  value
    ? Effect.succeed(value.replace(/\/$/, ""))
    : Effect.fail(
        new CoreToolsConfigurationError({
          message: "This executor did not provide a webBaseUrl for browser handoff flows.",
        }),
      );

const policyOutput = (policy: {
  readonly id: string;
  readonly scopeId: string;
  readonly pattern: string;
  readonly action: typeof ToolPolicyActionSchema.Type;
  readonly position: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}) => ({
  id: String(policy.id),
  scopeId: String(policy.scopeId),
  pattern: policy.pattern,
  action: policy.action,
  position: policy.position,
  createdAt: policy.createdAt.getTime(),
  updatedAt: policy.updatedAt.getTime(),
});

export const coreToolsPlugin = definePlugin((options: CoreToolsPluginOptions = {}) => ({
  id: "core-tools" as const,
  packageName: "@executor-js/sdk/core-tools",
  storage: () => ({}),
  extension: () => ({}),

  staticSources: () => [
    {
      id: "coreTools",
      kind: "executor",
      name: "Executor",
      tools: [
        tool({
          name: "scopes.list",
          description:
            "List visible executor scopes. Call this before write tools when more than one scope is visible; single-scope local executors can usually omit scope inputs.",
          outputSchema: ScopesListOutputStd,
          execute: (_args, { ctx }) =>
            Effect.succeed({
              scopes: ctx.scopes.map((s) => ({ id: String(s.id), name: s.name })),
            }),
        }),
        tool({
          name: "secrets.list",
          description:
            "List visible secrets by id, name, and provider. This never returns values. Use returned ids in source configuration or OAuth client credential strategies.",
          outputSchema: SecretsListOutputStd,
          execute: (_args, { ctx }) =>
            Effect.map(ctx.secrets.list(), (refs) => ({
              secrets: refs.map((r) => ({
                id: String(r.id),
                scopeId: String(r.scopeId),
                name: r.name,
                provider: r.provider,
              })),
            })),
        }),
        tool({
          name: "secrets.create",
          description:
            "Create a secret placeholder and return a browser URL for the user to enter the sensitive value. Never ask the user to paste passwords, tokens, client secrets, or API keys into chat. In a single-scope local executor, omit `scope`; otherwise call `scopes.list` and pass the target credential scope id or name. The optional `provider` is the Executor secret storage backend, not the API vendor; omit it unless the user explicitly chose a value returned by `secrets.providers`.",
          inputSchema: SecretsCreateInputStd,
          outputSchema: SecretsCreateOutputStd,
          execute: (input, { ctx }) =>
            Effect.gen(function* () {
              const webBaseUrl = yield* requireWebBaseUrl(options.webBaseUrl);
              if (input.provider) {
                const providers = yield* ctx.secrets.providers();
                if (!providers.includes(input.provider)) {
                  return oauthToolFailure(
                    "secret_provider_not_found",
                    `Unknown secret storage provider "${input.provider}". Omit provider unless the user chose one from secrets.providers.`,
                    { providers },
                  );
                }
              }
              const targetScope = yield* resolveScopeInput(ctx.scopes, input.scope);

              const secretId = crypto.randomUUID();
              const url = new URL(`${webBaseUrl}/secrets`);
              url.searchParams.set("scope", targetScope);
              url.searchParams.set("name", input.name);
              url.searchParams.set("secretId", secretId);
              if (input.provider) url.searchParams.set("provider", input.provider);
              return {
                id: secretId,
                url: url.toString(),
                instructions:
                  "The user needs to open this URL and set the secret value in the browser. Until the user saves the value there, this secret is only a placeholder and will not be available for binding. After the user saves it, call secrets.status for this id before using it in source configuration.",
              };
            }).pipe(
              Effect.catchTags({
                CoreToolsConfigurationError: ({ message }) =>
                  Effect.succeed(oauthToolFailure("secret_handoff_not_configured", message)),
                CoreToolsScopeNotFoundError: ({ message, scope }) =>
                  Effect.succeed(oauthToolFailure("scope_not_found", message, { scope })),
              }),
            ),
        }),
        tool({
          name: "secrets.status",
          description:
            "Check whether a user-visible secret id has a backing value without revealing that value. Use this after a browser handoff from `secrets.create` before wiring the secret into a source.",
          inputSchema: SecretPointerInputStd,
          outputSchema: SecretStatusOutputStd,
          execute: (input, { ctx }) =>
            Effect.map(ctx.secrets.status(input.id), (status) => ({ id: input.id, status })),
        }),
        tool({
          name: "secrets.usages",
          description:
            "List sources and credential slots that reference a secret. Call this before removing a secret so the user can detach it first if needed.",
          inputSchema: SecretPointerInputStd,
          outputSchema: SecretUsagesOutputStd,
          execute: (input, { ctx }) =>
            Effect.map(ctx.secrets.usages(input.id), (usages) => ({ usages })),
        }),
        tool({
          name: "secrets.providers",
          description:
            "List registered secret storage providers. Only use these exact values for the optional `provider` field in `secrets.create`; do not use API vendor names such as Vercel, GitHub, Stripe, or Google. Sensitive values still must be entered through the returned browser URL.",
          outputSchema: ProvidersOutputStd,
          execute: (_args, { ctx }) =>
            Effect.map(ctx.secrets.providers(), (providers) => ({ providers })),
        }),
        tool({
          name: "secrets.remove",
          description:
            "Remove a user-visible secret from a target scope. Call `secrets.usages` first; removal is refused while sources still reference the secret. Connection-owned token secrets cannot be removed here; remove the connection instead.",
          annotations: {
            requiresApproval: true,
            approvalDescription: "Remove an Executor secret",
          },
          inputSchema: SecretScopedPointerInputStd,
          outputSchema: RemovedOutputStd,
          execute: (input, { ctx }) =>
            Effect.gen(function* () {
              const targetScope = yield* resolveScopeInput(ctx.scopes, input.targetScope);
              return yield* Effect.as(
                ctx.secrets.remove({
                  id: SecretId.make(input.id),
                  targetScope: ScopeId.make(targetScope),
                }),
                { removed: true },
              );
            }),
        }),
        tool({
          name: "sources.list",
          description:
            "List configured and built-in sources. Use this to find source ids/scopes before calling plugin-specific configureSource tools, `sources.bindings.*`, refresh, remove, or tool discovery.",
          outputSchema: SourcesListOutputStd,
          execute: (_args, { ctx }) =>
            Effect.map(ctx.core.sources.list(), (sources) => ({ sources })),
        }),
        tool({
          name: "sources.detect",
          description:
            "Detect which plugin can add or configure a URL. This is the same URL auto-detection used by the Executor web Connect dialog. Use this when the user gives a URL but not a source type; then call the matching plugin add tool such as `openapi.previewSpec` + `openapi.addSource`, `graphql.addSource`, or `mcp.addSource`.",
          inputSchema: SourcesDetectInputStd,
          outputSchema: SourcesDetectOutputStd,
          execute: (input, { ctx }) =>
            Effect.map(ctx.core.sources.detect(input.url), (results) => ({ results })),
        }),
        tool({
          name: "sources.presets",
          description:
            "List the same popular source presets shown in Executor web's Connect dialog. Use this before asking the user what to connect; filter with `query` for names like GitHub, Stripe, Axiom, Google Calendar, Linear, or OpenAI. For MCP and GraphQL presets, pass `endpoint` to the probe/add tools. For OpenAPI and Google Discovery presets, pass `url` to the preview/probe and add tools. For stdio MCP presets, use the returned command/args/env.",
          inputSchema: SourcesPresetsInputStd,
          outputSchema: SourcesPresetsOutputStd,
          execute: (input, { ctx }) =>
            Effect.sync(() => {
              const query = input.query?.trim().toLowerCase() ?? "";
              const pluginId = input.pluginId?.trim();
              const featuredOnly = input.featuredOnly ?? false;
              const limit = Math.max(0, Math.trunc(input.limit ?? 50));
              const presets = ctx.core.sources
                .presets()
                .filter((preset) => (pluginId ? preset.pluginId === pluginId : true))
                .filter((preset) => (featuredOnly ? preset.featured === true : true))
                .filter((preset) => {
                  if (query.length === 0) return true;
                  const corpus =
                    `${preset.name} ${preset.summary} ${preset.pluginId} ${preset.id}`.toLowerCase();
                  return corpus.includes(query);
                })
                .slice(0, limit);
              return { presets };
            }),
        }),
        tool({
          name: "sources.configure",
          description:
            'Low-level escape hatch for configuring an existing source through its owning plugin. Prefer plugin-specific tools such as `openapi.configureSource`, `graphql.configureSource`, `mcp.configureSource`, or `googleDiscovery.configureSource`; this accepts plugin config as `unknown` for repair and compatibility cases. Use `secrets.create`/`oauth.start` first for sensitive inputs. Pass secret refs as `{kind:"secret", secretId}` and OAuth connections as `{kind:"connection", connectionId}` when the plugin schema supports them.',
          annotations: {
            requiresApproval: true,
            approvalDescription: "Configure an Executor source",
          },
          inputSchema: SourcesConfigureInputStd,
          outputSchema: SourcesConfigureOutputStd,
          execute: (input, { ctx }) =>
            Effect.gen(function* () {
              const sourceScope = yield* resolveScopeInput(ctx.scopes, input.source.scope);
              const targetScope = yield* resolveScopeInput(ctx.scopes, input.scope);
              const result = yield* ctx.core.sources.configure({
                ...input,
                source: { ...input.source, scope: sourceScope },
                scope: targetScope,
              });
              return { result };
            }),
        }),
        tool({
          name: "sources.refresh",
          description:
            "Refresh a configurable source's registered tools from its backing spec/server. Use `sources.list` first to get the source id and owning scope, then refresh the owning scope.",
          annotations: {
            requiresApproval: true,
            approvalDescription: "Refresh an Executor source",
          },
          inputSchema: SourceLifecycleInputStd,
          outputSchema: RefreshedOutputStd,
          execute: (input, { ctx }) =>
            Effect.gen(function* () {
              const targetScope = yield* resolveScopeInput(ctx.scopes, input.targetScope);
              return yield* Effect.as(ctx.core.sources.refresh({ ...input, targetScope }), {
                refreshed: true,
              });
            }),
        }),
        tool({
          name: "sources.remove",
          description:
            "Remove a configurable source and its registered tools from a target scope. Use `sources.list` and, when credentials are involved, `sources.bindings.list` first so the user can confirm exactly what will be removed.",
          annotations: {
            requiresApproval: true,
            approvalDescription: "Remove an Executor source",
          },
          inputSchema: SourceLifecycleInputStd,
          outputSchema: RemovedOutputStd,
          execute: (input, { ctx }) =>
            Effect.gen(function* () {
              const targetScope = yield* resolveScopeInput(ctx.scopes, input.targetScope);
              return yield* Effect.as(ctx.core.sources.remove({ ...input, targetScope }), {
                removed: true,
              });
            }),
        }),
        tool({
          name: "sources.bindings.list",
          description:
            "List credential bindings for a source. Use this to verify that secrets or OAuth connections were bound after a plugin-specific configureSource tool.",
          inputSchema: SourceBindingsListInputStd,
          outputSchema: SourceBindingsListOutputStd,
          execute: (input, { ctx }) =>
            Effect.gen(function* () {
              const sourceScope = yield* resolveScopeInput(ctx.scopes, input.source.scope);
              const bindings = yield* ctx.core.sources.listBindings({
                source: { id: input.source.id, scope: ScopeId.make(sourceScope) },
              });
              return { bindings };
            }),
        }),
        tool({
          name: "sources.bindings.resolve",
          description:
            "Resolve the effective credential binding for one source slot, accounting for scope shadowing. Values are references only; plaintext is never returned.",
          inputSchema: SourceBindingsResolveInputStd,
          outputSchema: SourceBindingsResolveOutputStd,
          execute: (input, { ctx }) =>
            Effect.gen(function* () {
              const sourceScope = yield* resolveScopeInput(ctx.scopes, input.source.scope);
              const binding = yield* ctx.core.sources.resolveBinding({
                source: { id: input.source.id, scope: ScopeId.make(sourceScope) },
                slotKey: input.slotKey,
              });
              return { binding };
            }),
        }),
        tool({
          name: "sources.bindings.set",
          description:
            "Set one credential binding for a source slot. Prefer plugin-specific configureSource tools for normal flows because they name the right credential fields. Use this low-level tool only when a plugin or status output has given an exact slot key.",
          annotations: {
            requiresApproval: true,
            approvalDescription: "Set a source credential binding",
          },
          inputSchema: SourceBindingsSetInputStd,
          outputSchema: SourceBindingsSetOutputStd,
          execute: (input, { ctx }) =>
            Effect.gen(function* () {
              const scope = yield* resolveScopeInput(ctx.scopes, input.scope);
              const sourceScope = yield* resolveScopeInput(ctx.scopes, input.source.scope);
              const binding = yield* ctx.core.sources.setBinding({
                scope: ScopeId.make(scope),
                source: { id: input.source.id, scope: ScopeId.make(sourceScope) },
                slotKey: input.slotKey,
                value: normalizeCredentialBindingValue(input.value),
              });
              return { binding };
            }),
        }),
        tool({
          name: "sources.bindings.remove",
          description:
            "Remove one credential binding from a source slot at a target scope. Use `sources.bindings.list` first so the user can confirm the exact binding being removed.",
          annotations: {
            requiresApproval: true,
            approvalDescription: "Remove a source credential binding",
          },
          inputSchema: SourceBindingsRemoveInputStd,
          execute: (input, { ctx }) =>
            Effect.gen(function* () {
              const scope = yield* resolveScopeInput(ctx.scopes, input.scope);
              const sourceScope = yield* resolveScopeInput(ctx.scopes, input.source.scope);
              return yield* Effect.asVoid(
                ctx.core.sources.removeBinding({
                  scope: ScopeId.make(scope),
                  source: { id: input.source.id, scope: ScopeId.make(sourceScope) },
                  slotKey: input.slotKey,
                }),
              );
            }),
        }),
        tool({
          name: "connections.list",
          description:
            "List OAuth/sign-in connections. This returns metadata and token secret ids, never token values. Use it to verify that `oauth.start` completed, then bind the connection id with the relevant plugin-specific configureSource tool.",
          outputSchema: ConnectionsListOutputStd,
          execute: (_args, { ctx }) =>
            Effect.map(ctx.connections.list(), (connections) => ({ connections })),
        }),
        tool({
          name: "connections.usages",
          description:
            "List sources and credential slots that reference an OAuth/sign-in connection. Call this before removing a connection so the user can detach it first if needed.",
          inputSchema: ConnectionPointerInputStd,
          outputSchema: ConnectionUsagesOutputStd,
          execute: (input, { ctx }) =>
            Effect.map(ctx.connections.usages(input.id), (usages) => ({ usages })),
        }),
        tool({
          name: "connections.providers",
          description:
            "List registered connection providers. Use this to understand which OAuth/sign-in connection kinds this executor can mint and refresh.",
          outputSchema: ProvidersOutputStd,
          execute: (_args, { ctx }) =>
            Effect.map(ctx.connections.providers(), (providers) => ({ providers })),
        }),
        tool({
          name: "connections.remove",
          description:
            "Remove an OAuth/sign-in connection and its owned token secrets from a target scope. Call `connections.usages` first; removal is refused while sources still reference the connection.",
          annotations: {
            requiresApproval: true,
            approvalDescription: "Remove an Executor connection",
          },
          inputSchema: ConnectionScopedPointerInputStd,
          outputSchema: RemovedOutputStd,
          execute: (input, { ctx }) =>
            Effect.gen(function* () {
              const targetScope = yield* resolveScopeInput(ctx.scopes, input.targetScope);
              return yield* Effect.as(
                ctx.connections.remove({
                  id: ConnectionId.make(input.id),
                  targetScope: ScopeId.make(targetScope),
                }),
                { removed: true },
              );
            }),
        }),
        tool({
          name: "policies.list",
          description:
            "List tool approval policies visible to this executor, sorted in evaluation order. Use this before creating, updating, reordering, or removing policies.",
          outputSchema: PoliciesListOutputStd,
          execute: (_args, { ctx }) =>
            Effect.map(ctx.core.policies.list(), (policies) => ({
              policies: policies.map(policyOutput),
            })),
        }),
        tool({
          name: "policies.create",
          description:
            'Create a tool approval policy. Patterns are exact tool ids, a trailing wildcard such as `executor.openapi.*`, or `*`. Actions are `"approve"`, `"require_approval"`, or `"block"`. Omit `position` to place the policy at the top of the target scope.',
          annotations: {
            requiresApproval: true,
            approvalDescription: "Create an Executor tool policy",
          },
          inputSchema: PolicyCreateInputStd,
          outputSchema: PolicyMutationOutputStd,
          execute: (input, { ctx }) =>
            Effect.gen(function* () {
              const targetScope = yield* resolveScopeInput(ctx.scopes, input.targetScope);
              const policy = yield* ctx.core.policies.create({ ...input, targetScope });
              return { policy: policyOutput(policy) };
            }),
        }),
        tool({
          name: "policies.update",
          description:
            "Update or reorder an approval policy. Use `policies.list` first; preserve fields you are not changing, and use the listed `position` values when computing a new order.",
          annotations: {
            requiresApproval: true,
            approvalDescription: "Update an Executor tool policy",
          },
          inputSchema: PolicyUpdateInputStd,
          outputSchema: PolicyMutationOutputStd,
          execute: (input, { ctx }) =>
            Effect.gen(function* () {
              const targetScope = yield* resolveScopeInput(ctx.scopes, input.targetScope);
              const policy = yield* ctx.core.policies.update({ ...input, targetScope });
              return { policy: policyOutput(policy) };
            }),
        }),
        tool({
          name: "policies.remove",
          description:
            "Remove an approval policy from a target scope. Use `policies.list` first so the user can confirm the exact rule id and pattern.",
          annotations: {
            requiresApproval: true,
            approvalDescription: "Remove an Executor tool policy",
          },
          inputSchema: PolicyRemoveInputStd,
          outputSchema: RemovedOutputStd,
          execute: (input, { ctx }) =>
            Effect.gen(function* () {
              const targetScope = yield* resolveScopeInput(ctx.scopes, input.targetScope);
              return yield* Effect.as(ctx.core.policies.remove({ ...input, targetScope }), {
                removed: true,
              });
            }),
        }),
        tool({
          name: "oauth.probe",
          description:
            'Probe an OAuth-protected endpoint before starting OAuth. For dynamic MCP-style OAuth, call this first; if `supportsDynamicRegistration` is true, call `oauth.start` with strategy `{kind:"dynamic-dcr"}`. If false, create client id/secret secrets in the browser and use an `authorization-code` strategy.',
          inputSchema: OAuthProbeInputStd,
          outputSchema: OAuthProbeOutputStd,
          execute: (input, { ctx }) =>
            ctx.oauth
              .probe(input)
              .pipe(
                Effect.catchTag("OAuthProbeError", ({ message }) =>
                  Effect.succeed(oauthToolFailure("oauth_probe_failed", message)),
                ),
              ),
        }),
        tool({
          name: "oauth.start",
          description:
            "Start an OAuth flow and return the authorization URL the user must open in a browser. `credentialScope` chooses where Executor stores the OAuth connection/token secrets; omit it only in a single-scope local executor, otherwise call `scopes.list` and ask whether the connection should be personal/user-scoped or organization-scoped. OAuth permission scopes belong in `strategy.scopes`. Never put OAuth passwords, authorization codes, or client secrets in chat. For confidential clients, first call `secrets.create` for client id/secret and pass those secret ids in the strategy. After the browser callback completes, call `connections.list`, then configure the source with the returned connection id.",
          inputSchema: OAuthStartInputStd,
          outputSchema: OAuthStartOutputStd,
          execute: (input, { ctx }) =>
            Effect.gen(function* () {
              const webBaseUrl = yield* requireWebBaseUrl(options.webBaseUrl);
              const tokenScope = yield* resolveScopeInput(ctx.scopes, input.credentialScope);
              const result = yield* ctx.oauth.start({
                endpoint: input.endpoint,
                headers: input.headers,
                queryParams: input.queryParams,
                redirectUrl: input.redirectUrl ?? `${webBaseUrl}/api/oauth/callback`,
                connectionId: input.connectionId,
                tokenScope,
                strategy: input.strategy,
                pluginId: input.pluginId,
                identityLabel: input.identityLabel,
              });
              return {
                ...result,
                instructions:
                  result.authorizationUrl === null
                    ? "This OAuth flow completed without a browser handoff. The OAuth connection/token secrets were saved to the selected credential scope. Call connections.list to verify the connection id, then pass that connection id to the relevant source configuration tool."
                    : "The user needs to open this authorization URL in a browser and complete the OAuth/sign-in flow. Until the browser callback completes, no connection is available for binding. After the user finishes sign-in, call connections.list to find the connection id, then pass that connection id to the relevant source configuration tool. The OAuth connection/token secrets are saved to the selected credential scope.",
              };
            }).pipe(
              Effect.catchTags({
                CoreToolsConfigurationError: ({ message }) =>
                  Effect.succeed(oauthToolFailure("oauth_start_not_configured", message)),
                CoreToolsScopeNotFoundError: ({ message, scope }) =>
                  Effect.succeed(oauthToolFailure("scope_not_found", message, { scope })),
                OAuthStartError: ({ message, error, errorDescription }) =>
                  Effect.succeed(
                    oauthToolFailure("oauth_start_failed", message, {
                      ...(error ? { error } : {}),
                      ...(errorDescription ? { errorDescription } : {}),
                    }),
                  ),
              }),
            ),
        }),
        tool({
          name: "oauth.cancel",
          description:
            "`credentialScope` must match where `oauth.start` saved the pending browser handoff. Cancel it if the user declines or the wrong flow was started.",
          inputSchema: OAuthCancelInputStd,
          outputSchema: OAuthCancelOutputStd,
          execute: (input, { ctx }) =>
            Effect.gen(function* () {
              const scope = yield* resolveScopeInput(ctx.scopes, input.credentialScope);
              return yield* Effect.as(ctx.oauth.cancel(input.sessionId, scope), {
                cancelled: true,
              });
            }).pipe(
              Effect.catchTag("CoreToolsScopeNotFoundError", ({ message, scope }) =>
                Effect.succeed(oauthToolFailure("scope_not_found", message, { scope })),
              ),
            ),
        }),
      ],
    },
  ],
}));

export default coreToolsPlugin;
