import type { CiTarget } from "./ci-shard";

/**
 * A conservative estimate for a test file that has no recorded CI duration.
 * New tests therefore receive real scheduling weight instead of accumulating
 * unnoticed in one shard.
 */
export const UNKNOWN_TEST_DURATION_MS = 10_000;

/**
 * Slow-file durations observed in the last complete pre-planner CI run.
 * Files below five seconds intentionally use UNKNOWN_TEST_DURATION_MS: that
 * overestimate keeps the plan balanced by both known hotspots and file count.
 */
export const OBSERVED_TEST_DURATIONS_MS: Readonly<
  Record<CiTarget, Readonly<Record<string, number>>>
> = {
  cloud: {
    "cloud/admin-users-console.test.ts": 17_089,
    "cloud/auth-hint.test.ts": 8_275,
    "cloud/billing-trial-checkout-stale.test.ts": 10_173,
    "cloud/connect-link-multi-org.test.ts": 9_743,
    "cloud/connection-modal-oauth-abandon.test.ts": 7_468,
    "cloud/logout-stale-session.test.ts": 10_136,
    "cloud/mcp-browser-resume-page.test.ts": 5_729,
    "cloud/mcp-client-sessions.test.ts": 16_544,
    "cloud/mcp-priming-reconnect.test.ts": 15_482,
    "cloud/mcp-sse-replay.test.ts": 48_617,
    "cloud/member-invite-seat-limit.test.ts": 16_661,
    "cloud/oauth-callback-org-scope.test.ts": 17_959,
    "cloud/org-api-keys-console.test.ts": 9_520,
    "cloud/org-delete.test.ts": 8_075,
    "cloud/org-last-visited.test.ts": 6_696,
    "cloud/org-limit.test.ts": 19_139,
    "cloud/org-multitab-cookie.test.ts": 15_626,
    "cloud/org-switcher.test.ts": 7_686,
    "cloud/repro-transport-brick.test.ts": 5_474,
    "scenarios/artifact-approval.test.ts": 65_965,
    "scenarios/artifact-loading-surface.test.ts": 16_426,
    "scenarios/artifact-preview-gallery.test.ts": 10_838,
    "scenarios/artifacts.test.ts": 23_178,
    "scenarios/connect-deep-link.test.ts": 8_836,
    "scenarios/connect-handoff-session.test.ts": 10_296,
    "scenarios/connect-handoff.test.ts": 7_519,
    "scenarios/connection-remove-confirm.test.ts": 5_197,
    "scenarios/google-health-checks.test.ts": 20_737,
    "scenarios/google-photos-preset-ui.test.ts": 5_696,
    "scenarios/graphql-introspection-health.test.ts": 12_617,
    "scenarios/health-checks-ui.test.ts": 71_165,
    "scenarios/mcp-catalog-sync-ui.test.ts": 11_813,
    "scenarios/microsoft-graph-full.test.ts": 7_586,
    "scenarios/oauth-client-handoff.test.ts": 9_866,
    "scenarios/openapi-add-integration-action-bar.test.ts": 6_084,
    "scenarios/openapi-server-selection-ui.test.ts": 5_933,
    "scenarios/org-slug-routing.test.ts": 8_598,
    "scenarios/policies-ui.test.ts": 9_515,
    "scenarios/provider-plugins-ui.test.ts": 9_060,
    "scenarios/toolkits-mcp.test.ts": 6_665,
  },
  local: {
    "local/auth.test.ts": 8_687,
    "local/cli-mcp-daemon-attach-stress.test.ts": 12_241,
    "local/stdio-mcp.test.ts": 6_886,
    "local/update-notice.test.ts": 8_438,
  },
  selfhost: {
    "scenarios/artifact-approval.test.ts": 65_795,
    "scenarios/artifact-loading-surface.test.ts": 10_961,
    "scenarios/artifact-preview-gallery.test.ts": 6_923,
    "scenarios/artifacts.test.ts": 17_794,
    "scenarios/browser-approval.test.ts": 5_055,
    "scenarios/connect-deep-link.test.ts": 7_034,
    "scenarios/connect-handoff-session.test.ts": 7_279,
    "scenarios/connect-handoff.test.ts": 5_695,
    "scenarios/google-health-checks.test.ts": 18_428,
    "scenarios/graphql-introspection-health.test.ts": 8_060,
    "scenarios/health-checks-ui.test.ts": 53_684,
    "scenarios/mcp-catalog-sync-ui.test.ts": 9_870,
    "scenarios/microsoft-graph-full.test.ts": 7_137,
    "scenarios/oauth-client-handoff.test.ts": 7_317,
    "scenarios/policies-ui.test.ts": 8_609,
    "scenarios/provider-plugins-ui.test.ts": 6_317,
    "scenarios/resume-after-sandbox-deadline.test.ts": 23_491,
    "scenarios/toolkits-mcp.test.ts": 5_571,
    "selfhost/admin-users-console.test.ts": 10_751,
    "selfhost/api-keys-feedback.test.ts": 7_290,
    "selfhost/auth-methods-ui.test.ts": 17_925,
    "selfhost/cli-device-login.test.ts": 8_718,
    "selfhost/detected-auth-immutable-ui.test.ts": 5_976,
    "selfhost/mcp-oauth-reconnect-health.test.ts": 30_776,
    "selfhost/oauth-app-modal.test.ts": 5_160,
    "selfhost/toolkits-ui.test.ts": 8_628,
  },
};
