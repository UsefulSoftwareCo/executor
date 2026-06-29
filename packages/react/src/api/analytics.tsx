import * as React from "react";

// ---------------------------------------------------------------------------
// Product-analytics seam — same DI shape as ./error-reporting: a module-level
// client set by a provider the HOST mounts, and a free `trackEvent` function
// callsites import directly (works outside React, e.g. oauth-popup callbacks).
// No client mounted (local, self-host, cloudflare, tests) → every call is a
// no-op. Cloud mounts `AnalyticsProvider` with a posthog-backed client.
//
// `AnalyticsEvents` is the single catalog of every product event: names are
// `object_verb` snake_case, properties are snake_case. A callsite with a typo
// or an undeclared property is a type error, so the catalog can't drift from
// the instrumentation.
//
// BROWSER-ONLY by design: during SSR the host mounts no client (cloud's is
// undefined when `window` is absent), and on shared-module-scope runtimes
// (Cloudflare Workers) every SSR render resets the singleton to null. Server-
// side product events need their own seam — do not route them through this one.
//
// PROPERTY RULES — properties must never carry:
//   - secrets, tokens, credential values, copied clipboard contents
//   - emails, person/org names, or any user-entered free text
//   - connection names or tool ADDRESSES (both embed user-entered label text;
//     integration slugs and spec-derived tool names are fine)
//   - policy patterns (user-entered globs) — use `pattern_kind` instead
// Identity attaches via posthog identify/group (the host's concern), never as
// event properties.
// ---------------------------------------------------------------------------

type Owner = "org" | "user";

export interface AnalyticsEvents {
  // ── Integrations ─────────────────────────────────────────────────────────
  integration_connect_dialog_opened: {};
  integration_detect_submitted: {
    success: boolean;
    detected_kind?: string;
    confidence?: string;
  };
  integration_add_started: {
    plugin_key: string;
    via: "detect" | "manual" | "preset" | "command_palette";
    preset_id?: string;
  };
  integration_added: { plugin_key: string; integration_slug?: string };
  integration_add_cancelled: { plugin_key: string };
  integration_removed: { integration_slug: string; success: boolean };
  integration_refreshed: {
    integration_slug: string;
    connection_count: number;
    success: boolean;
  };
  integration_renamed: { integration_slug: string; success: boolean };

  // ── Connections & auth ───────────────────────────────────────────────────
  connection_add_opened: {
    integration_slug: string;
    has_oauth_method: boolean;
    has_api_key_method: boolean;
  };
  connection_credential_submitted: {
    integration_slug: string;
    owner: Owner;
    credential_origin: "paste" | "onepassword";
    success: boolean;
  };
  connection_oauth_started: {
    integration_slug: string;
    owner: Owner;
    flow: "byo" | "dcr" | "cimd";
    success: boolean;
    dcr_fallback?: boolean;
  };
  connection_reconnected: { integration_slug: string; owner: Owner; success: boolean };
  connection_removed: { integration_slug: string; owner: Owner; success: boolean };
  oauth_completed: { success: boolean };
  oauth_popup_blocked: {};
  oauth_client_registered: {
    owner: Owner;
    grant: string;
    via_dcr: boolean;
    success: boolean;
  };
  oauth_client_removed: { owner: Owner };
  custom_auth_method_created: { integration_slug: string; kind: string };
  custom_auth_method_removed: { integration_slug: string };

  // ── Tools ────────────────────────────────────────────────────────────────
  tool_selected: { integration_slug: string; tool_name: string };
  tool_run_submitted: {
    integration_slug: string;
    tool_name: string;
    args_mode: "form" | "json";
    result: "completed" | "paused" | "failed";
    is_error?: boolean;
  };
  tool_id_copied: { integration_slug: string; tool_name: string };
  tool_policy_set: { action: string; pattern_kind: "exact" | "group"; owner: Owner };
  tool_policy_cleared: { pattern_kind: "exact" | "group"; owner: Owner };

  // ── Policies page ────────────────────────────────────────────────────────
  policy_created: { action: string; owner: Owner; success: boolean };
  policy_action_changed: { action: string; owner: Owner; success: boolean };
  policy_removed: { owner: Owner; success: boolean };
  policy_reordered: { owner: Owner; direction: "up" | "down"; success: boolean };

  // ── API keys ─────────────────────────────────────────────────────────────
  api_key_created: { success: boolean };
  api_key_revoked: { success: boolean };
  api_key_copied: { kind: "value" | "bearer_header" };

  // ── Organization ─────────────────────────────────────────────────────────
  org_renamed: { success: boolean };
  org_member_invited: { role: string; success: boolean };
  org_member_role_changed: { role: string; success: boolean };
  org_member_removed: { success: boolean };

  // ── Executions & approvals ───────────────────────────────────────────────
  resume_approval_submitted: {
    action: "accept" | "decline" | "cancel";
    interaction_kind?: string;
    chained_to_next?: boolean;
    success: boolean;
  };
  resume_return_prompt_copied: { action: "accept" | "decline" | "cancel" };

  // ── MCP install / onboarding ─────────────────────────────────────────────
  mcp_install_command_copied: {
    transport: "http" | "stdio";
    elicitation_mode?: string;
    surface: "integrations" | "setup_mcp";
  };
  mcp_install_transport_switched: { transport: "http" | "stdio" };
  mcp_install_elicitation_mode_changed: { elicitation_mode: string };

  // ── Command palette ──────────────────────────────────────────────────────
  command_palette_navigated: {
    kind: "integration" | "add_integration" | "preset";
    plugin_key?: string;
  };

  // ── Docs / help ──────────────────────────────────────────────────────────
  docs_opened: { surface: "sidebar" };

  // ── Cloud: auth & onboarding ─────────────────────────────────────────────
  login_cta_clicked: {};
  signed_out: {};
  org_created: { success: boolean };
  org_switched: { success: boolean };
  org_invitation_accepted: { success: boolean };
  setup_mcp_completed: {};
  setup_mcp_skipped: {};

  // ── Cloud: billing & support ─────────────────────────────────────────────
  billing_plan_selected: {
    plan_id: string;
    action: "activate" | "upgrade" | "downgrade";
  };
  billing_manage_opened: {};
  billing_cancel_plan_clicked: { plan_id: string };
  support_opened: {};
  support_link_clicked: { label: string };
  org_domain_added: { success: boolean };
  org_domain_removed: { success: boolean };
}

export type AnalyticsEventName = keyof AnalyticsEvents;

/**
 * The host-supplied sink. Cloud backs this with `posthog.capture`; hosts that
 * mount no provider get the no-op default.
 */
export type AnalyticsClient = <Name extends AnalyticsEventName>(
  name: Name,
  properties: AnalyticsEvents[Name],
) => void;

let currentAnalyticsClient: AnalyticsClient | null = null;

/**
 * Imperative injection point — what `AnalyticsProvider` uses, and the hook for
 * non-React hosts (or tests). Pass `null` to restore the no-op default.
 */
export const setAnalyticsClient = (client: AnalyticsClient | null): void => {
  currentAnalyticsClient = client;
};

/**
 * Record one product event. Safe to call from anywhere (React handlers,
 * Effect callbacks, plain modules); a host without a mounted client makes
 * this a no-op. Events with no properties may omit the second argument.
 */
export const trackEvent = <Name extends AnalyticsEventName>(
  name: Name,
  ...rest: {} extends AnalyticsEvents[Name]
    ? [properties?: AnalyticsEvents[Name]]
    : [properties: AnalyticsEvents[Name]]
): void => {
  currentAnalyticsClient?.(name, rest[0] ?? ({} as AnalyticsEvents[Name]));
};

/**
 * Declarative mount for React hosts — sets the module-level client during
 * render, exactly like `FrontendErrorReporterProvider` does for error
 * reporting. Mount once at the app root, ABOVE any tree that fires events
 * (in cloud that is the document root, not ExecutorProvider, because the
 * login/onboarding routes render outside the authenticated shell).
 */
export const AnalyticsProvider = (props: React.PropsWithChildren<{ client?: AnalyticsClient }>) => {
  currentAnalyticsClient = props.client ?? null;
  return <>{props.children}</>;
};
