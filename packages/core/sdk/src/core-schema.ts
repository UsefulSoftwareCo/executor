import { column, idColumn, table, type AnyColumn, type AnyTable } from "fumadb/schema";
import type { FumaRow } from "./fuma-runtime";
import {
  assertExecutorScopeAllowed,
  assertExecutorScopeTargetValue,
  executorScopePolicyName,
  executorUnscopedPolicyName,
  executorScopeIds,
  requireExecutorScopeTarget,
  type ExecutorScopePolicyContext,
} from "./scope-policy";

type UserColumns = Record<string, AnyColumn>;

export const textColumn = (name: string) => column(name, "string");
export const nullableTextColumn = (name: string) => column(name, "string").nullable();
export const boolColumn = (name: string, defaultValue: boolean) =>
  column(name, "bool").defaultTo(defaultValue);
export const bigintColumn = (name: string) => column(name, "bigint");
export const nullableBigintColumn = (name: string) => column(name, "bigint").nullable();
export const jsonColumn = (name: string) => column(name, "json");
export const nullableJsonColumn = (name: string) => column(name, "json").nullable();
export const dateColumn = (name: string) => column(name, "timestamp");

const unscopedExecutorTable = <const TColumns extends UserColumns>(
  name: string,
  columns: TColumns,
) => {
  const out = table(name, {
    ...columns,
    row_id: idColumn("row_id", "varchar(255)").defaultTo$("auto"),
    id: column("id", "varchar(255)"),
  });
  out.unique(`${name}_id_uidx`, ["id"]);
  return out.policy({
    name: executorUnscopedPolicyName,
  });
};

const scopedExecutorTableBase = <const TColumns extends UserColumns>(
  name: string,
  columns: TColumns,
) => {
  const out = table(name, {
    ...columns,
    row_id: idColumn("row_id", "varchar(255)").defaultTo$("auto"),
    id: column("id", "varchar(255)"),
    scope_id: column("scope_id", "varchar(255)"),
  });
  out.unique(`${name}_scope_id_id_uidx`, ["scope_id", "id"]);
  return out;
};

export const scopedExecutorTable = <const TColumns extends UserColumns>(
  name: string,
  columns: TColumns,
) => {
  const out = scopedExecutorTableBase(name, columns);
  return out.policy<ExecutorScopePolicyContext>({
    name: executorScopePolicyName,
    onRead: ({ builder, context }) =>
      builder("scope_id", "in", executorScopeIds(name, "read", context)),
    onCreate: ({ values, context }) =>
      assertExecutorScopeAllowed(name, "write", values.scope_id, context),
    onUpdate: ({ builder, set, create, where, context }) => {
      const target = requireExecutorScopeTarget(name, "write", where, context);
      if (set.scope_id !== undefined) {
        assertExecutorScopeTargetValue(name, "write", set.scope_id, target, context);
      }
      if (create?.scope_id !== undefined) {
        assertExecutorScopeTargetValue(name, "write", create.scope_id, target, context);
      }
      return builder("scope_id", "=", target.value);
    },
    onDelete: ({ builder, where, context }) => {
      const target = requireExecutorScopeTarget(name, "delete", where, context);
      return builder("scope_id", "=", target.value);
    },
  });
};

const defineTables = <const TTables extends Record<string, AnyTable>>(tables: TTables): TTables =>
  tables;

export const credentialBindingKinds = ["text", "secret", "connection"] as const;

const credentialBindingTable = (() => {
  const out = scopedExecutorTableBase("credential_binding", {
    plugin_id: textColumn("plugin_id"),
    source_id: textColumn("source_id"),
    source_scope_id: textColumn("source_scope_id"),
    slot_key: textColumn("slot_key"),
    kind: textColumn("kind"),
    text_value: nullableTextColumn("text_value"),
    secret_id: nullableTextColumn("secret_id"),
    secret_scope_id: nullableTextColumn("secret_scope_id"),
    connection_id: nullableTextColumn("connection_id"),
    created_at: dateColumn("created_at"),
    updated_at: dateColumn("updated_at"),
  });

  return out.policy<ExecutorScopePolicyContext>({
    name: executorScopePolicyName,
    onRead: ({ builder, context }) =>
      builder("scope_id", "in", executorScopeIds("credential_binding", "read", context)),
    onCreate: ({ values, context }) =>
      assertExecutorScopeAllowed("credential_binding", "write", values.scope_id, context),
    onUpdate: ({ builder, set, create, where, context }) => {
      const target = requireExecutorScopeTarget("credential_binding", "write", where, context);
      if (set.scope_id !== undefined) {
        assertExecutorScopeTargetValue(
          "credential_binding",
          "write",
          set.scope_id,
          target,
          context,
        );
      }
      if (create?.scope_id !== undefined) {
        assertExecutorScopeTargetValue(
          "credential_binding",
          "write",
          create.scope_id,
          target,
          context,
        );
      }
      return builder("scope_id", "=", target.value);
    },
    onDelete: ({ builder, where, context }) => {
      const target = requireExecutorScopeTarget("credential_binding", "delete", where, context, [
        "scope_id",
        "source_scope_id",
      ]);
      return builder(target.column, "=", target.value);
    },
  });
})();

export const coreTables = defineTables({
  source: scopedExecutorTable("source", {
    plugin_id: textColumn("plugin_id"),
    kind: textColumn("kind"),
    name: textColumn("name"),
    url: nullableTextColumn("url"),
    can_remove: boolColumn("can_remove", true),
    can_refresh: boolColumn("can_refresh", false),
    can_edit: boolColumn("can_edit", false),
    created_at: dateColumn("created_at"),
    updated_at: dateColumn("updated_at"),
  }),
  tool: scopedExecutorTable("tool", {
    source_id: textColumn("source_id"),
    plugin_id: textColumn("plugin_id"),
    name: textColumn("name"),
    description: textColumn("description"),
    input_schema: nullableJsonColumn("input_schema"),
    output_schema: nullableJsonColumn("output_schema"),
    created_at: dateColumn("created_at"),
    updated_at: dateColumn("updated_at"),
  }),
  definition: scopedExecutorTable("definition", {
    source_id: textColumn("source_id"),
    plugin_id: textColumn("plugin_id"),
    name: textColumn("name"),
    schema: jsonColumn("schema"),
    created_at: dateColumn("created_at"),
  }),
  secret: scopedExecutorTable("secret", {
    name: textColumn("name"),
    provider: textColumn("provider"),
    owned_by_connection_id: nullableTextColumn("owned_by_connection_id"),
    created_at: dateColumn("created_at"),
  }),
  connection: scopedExecutorTable("connection", {
    provider: textColumn("provider"),
    identity_label: nullableTextColumn("identity_label"),
    access_token_secret_id: textColumn("access_token_secret_id"),
    refresh_token_secret_id: nullableTextColumn("refresh_token_secret_id"),
    expires_at: nullableBigintColumn("expires_at"),
    scope: nullableTextColumn("scope"),
    provider_state: nullableJsonColumn("provider_state"),
    identity_override: nullableJsonColumn("identity_override"),
    created_at: dateColumn("created_at"),
    updated_at: dateColumn("updated_at"),
  }),
  oauth2_session: scopedExecutorTable("oauth2_session", {
    plugin_id: textColumn("plugin_id"),
    strategy: textColumn("strategy"),
    connection_id: textColumn("connection_id"),
    token_scope: textColumn("token_scope"),
    redirect_url: textColumn("redirect_url"),
    payload: jsonColumn("payload"),
    expires_at: bigintColumn("expires_at"),
    created_at: dateColumn("created_at"),
  }),
  credential_binding: credentialBindingTable,
  plugin_storage: scopedExecutorTable("plugin_storage", {
    plugin_id: textColumn("plugin_id"),
    collection: textColumn("collection"),
    key: textColumn("key"),
    data: jsonColumn("data"),
    created_at: dateColumn("created_at"),
    updated_at: dateColumn("updated_at"),
  }),
  tool_policy: scopedExecutorTable("tool_policy", {
    pattern: textColumn("pattern"),
    action: textColumn("action"),
    position: textColumn("position"),
    created_at: dateColumn("created_at"),
    updated_at: dateColumn("updated_at"),
  }),
  blob: unscopedExecutorTable("blob", {
    namespace: textColumn("namespace"),
    key: textColumn("key"),
    value: textColumn("value"),
  }),
});

export const coreSchema = coreTables;
export type CoreSchema = typeof coreTables;

export type SourceRow = FumaRow<CoreSchema["source"]>;
export type ToolRow = FumaRow<CoreSchema["tool"]>;
export type DefinitionRow = FumaRow<CoreSchema["definition"]>;
export type SecretRow = FumaRow<CoreSchema["secret"]>;
export type ConnectionRow = FumaRow<CoreSchema["connection"]>;
export type PluginStorageRow = FumaRow<CoreSchema["plugin_storage"]>;

type CredentialBindingRowBase = Omit<
  FumaRow<CoreSchema["credential_binding"]>,
  "kind" | "text_value" | "secret_id" | "secret_scope_id" | "connection_id"
>;

export type CredentialBindingRow = CredentialBindingRowBase &
  (
    | {
        kind: "text";
        text_value: string;
      }
    | {
        kind: "secret";
        secret_id: string;
        secret_scope_id?: string | null;
      }
    | {
        kind: "connection";
        connection_id: string;
      }
  ) &
  Record<string, unknown>;

export type ToolPolicyRow = FumaRow<CoreSchema["tool_policy"]>;

export type ToolPolicyAction = "approve" | "require_approval" | "block";

export const TOOL_POLICY_ACTIONS = [
  "approve",
  "require_approval",
  "block",
] as const satisfies readonly ToolPolicyAction[];

export const isToolPolicyAction = (value: unknown): value is ToolPolicyAction =>
  typeof value === "string" && (TOOL_POLICY_ACTIONS as readonly string[]).includes(value);

export interface ToolAnnotations {
  readonly requiresApproval?: boolean;
  readonly approvalDescription?: string;
  readonly mayElicit?: boolean;
}

export interface SourceInputTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema?: unknown;
  readonly outputSchema?: unknown;
}

export interface SourceInput {
  readonly id: string;
  readonly scope: string;
  readonly kind: string;
  readonly name: string;
  readonly url?: string;
  readonly canRemove?: boolean;
  readonly canRefresh?: boolean;
  readonly canEdit?: boolean;
  readonly tools: readonly SourceInputTool[];
}

export interface DefinitionsInput {
  readonly sourceId: string;
  readonly scope: string;
  readonly definitions: Record<string, unknown>;
}
