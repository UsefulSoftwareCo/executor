// ---------------------------------------------------------------------------
// core-tools plugin
//
// Built-in plugin that contributes agent-facing static tools for managing
// executor-level primitives (scopes, secrets). Auto-registered by
// `createExecutor`, so callers don't need to wire it in.
//
// Today's surface:
//   - scopes.list   — enumerate visible scopes by name
//   - secrets.list  — list visible secrets (collapsed across scopes)
//   - secrets.create — agent supplies scope + name; tool returns a URL
//                      that opens the existing /secrets web page with the
//                      add-modal pre-filled. User enters the value in
//                      that form (writes via the existing secrets HTTP
//                      endpoint). Agent confirms by calling secrets.list.
//
// No elicitation suspension, no cross-request coordination. Works on
// Cloudflare Workers because the tool's return value is just a URL.
//
// The agent never sees plaintext secret values. The agent never picks a
// default scope on the user's behalf — every write tool requires an
// explicit scope name, and `scopes.list` exists so the agent can
// enumerate options before asking.
// ---------------------------------------------------------------------------

import { Effect, Schema } from "effect";

import { definePlugin, tool } from "./plugin";

// ---------------------------------------------------------------------------
// Tool input/output schemas
// ---------------------------------------------------------------------------

const ScopesListOutput = Schema.Struct({
  scopes: Schema.Array(
    Schema.Struct({
      name: Schema.String,
    }),
  ),
});

const SecretsListOutput = Schema.Struct({
  secrets: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      provider: Schema.String,
    }),
  ),
});

const SecretsCreateInput = Schema.Struct({
  /** Display name shown in the secrets UI and used to reference this
   *  secret in subsequent tool calls. */
  name: Schema.String,
  /** Name of the scope (from `scopes.list`) that should own this
   *  secret. Required — there is no default. */
  scope: Schema.String,
  /** Optional provider override. If omitted, the executor picks the
   *  first writable provider in registration order. */
  provider: Schema.optional(Schema.String),
});

const SecretsCreateOutput = Schema.Struct({
  /** Pre-allocated id the secret will receive when the user submits the
   *  form. The agent can pass this to other tools that need a secret
   *  reference; it materializes in `secrets.list` once the user saves. */
  id: Schema.String,
  /** URL to hand to the user. Opens the /secrets page with the add
   *  modal pre-filled with name, scope, and the pre-allocated id. */
  url: Schema.String,
});

const ScopesListOutputStd = Schema.toStandardSchemaV1(
  Schema.toStandardJSONSchemaV1(ScopesListOutput),
);
const SecretsListOutputStd = Schema.toStandardSchemaV1(
  Schema.toStandardJSONSchemaV1(SecretsListOutput),
);
const SecretsCreateInputStd = Schema.toStandardSchemaV1(
  Schema.toStandardJSONSchemaV1(SecretsCreateInput),
);
const SecretsCreateOutputStd = Schema.toStandardSchemaV1(
  Schema.toStandardJSONSchemaV1(SecretsCreateOutput),
);

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface CoreToolsPluginOptions {
  /** Base URL of the executor's web UI. Used to build the URL handed to
   *  the user for secret-value entry, e.g. `${webBaseUrl}/secrets?...`.
   *  If omitted, secrets.create is registered but will fail at invoke
   *  time — the host must supply a URL it can route back to. */
  readonly webBaseUrl?: string;
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export const coreToolsPlugin = definePlugin((options: CoreToolsPluginOptions = {}) => ({
  id: "core-tools" as const,
  packageName: "@executor-js/sdk/core-tools",
  storage: () => ({}),
  extension: () => ({}),

  staticSources: () => [
    {
      id: "core-tools",
      kind: "executor",
      name: "Executor",
      tools: [
        tool({
          name: "scopes.list",
          description:
            "List the scopes visible to this executor. Use this before any tool that takes a `scope` argument so you can ask the user which scope to use.",
          outputSchema: ScopesListOutputStd,
          execute: (_args, { ctx }) =>
            Effect.succeed({
              scopes: ctx.scopes.map((s) => ({ name: s.name })),
            }),
        }),

        tool({
          name: "secrets.list",
          description:
            "List secrets visible to this executor. Returns id, display name, and provider — never values. Use the returned id when other tools ask for a secret reference.",
          outputSchema: SecretsListOutputStd,
          execute: (_args, { ctx }) =>
            Effect.gen(function* () {
              const refs = yield* ctx.secrets.list();
              return {
                secrets: refs.map((r) => ({
                  id: r.id,
                  name: r.name,
                  provider: r.provider,
                })),
              };
            }),
        }),

        tool({
          name: "secrets.create",
          description:
            "Create a new secret. Returns a URL the user should open to enter the value securely; the agent never sees plaintext. The secret materializes once the user submits the form — confirm by calling `secrets.list` and looking for the returned id.",
          inputSchema: SecretsCreateInputStd,
          outputSchema: SecretsCreateOutputStd,
          execute: (input, { ctx }) =>
            Effect.gen(function* () {
              const webBaseUrl = options.webBaseUrl;
              if (!webBaseUrl) {
                return yield* Effect.die(
                  new Error(
                    "core-tools secrets.create requires webBaseUrl. Pass it to coreToolsPlugin({ webBaseUrl }) at executor construction.",
                  ),
                );
              }

              const targetScope = ctx.scopes.find((s) => s.name === input.scope);
              if (!targetScope) {
                return yield* Effect.die(
                  new Error(
                    `secrets.create: unknown scope "${input.scope}". Call scopes.list to see valid names.`,
                  ),
                );
              }

              const secretId = crypto.randomUUID();

              const url = new URL(`${webBaseUrl.replace(/\/$/, "")}/secrets`);
              // Page reads these and opens the add modal pre-filled.
              // Final value is collected from the user and written via
              // the existing /scopes/:id/secrets POST. The presence of
              // `name` is the open-modal signal (no separate flag).
              url.searchParams.set("scope", String(targetScope.id));
              url.searchParams.set("name", input.name);
              url.searchParams.set("secretId", secretId);
              if (input.provider) url.searchParams.set("provider", input.provider);

              return { id: secretId, url: url.toString() };
            }),
        }),
      ],
    },
  ],
}));

export default coreToolsPlugin;
