import { browserPageId, BrowserOperationFailure } from "@executor-js/telemetry/browser";
import { budgetedFetch } from "@executor-js/telemetry/keepalive";
import { documentBuild } from "@executor-js/dashboard-start/document-build";
import posthog, { type PostHogConfig } from "posthog-js";
import { BrowserUsage } from "@executor-js/hosted-web/contracts/product-analytics";
import { useAtomValue } from "@effect/atom-react";
import { sessionAtom } from "@executor-js/hosted-web/contracts/auth";
import { AsyncResult } from "effect/reactivity";
import { Schema, Option } from "effect";
import { useEffect } from "react";
import type { SupportLink } from "@executor-js/ui/dashboard/support-dialog";
import { dashboardReplay, replayPageAllowed } from "./analytics-replay.ts";

/* oxlint-disable executor/no-module-level-mutable-state -- browser-only; server renders never start analytics */
let started = false;
let identified = false;
let recorder: Promise<unknown> | undefined;
/* oxlint-enable executor/no-module-level-mutable-state */

const replayAllowed = () => identified && replayPageAllowed(new URL(location.href));

export const pauseReplay = () => {
  if (started) posthog.stopSessionRecording();
};
const updateReplay = () => {
  if (!started) return;
  if (!replayAllowed()) {
    posthog.stopSessionRecording();
    return;
  }
  recorder ??= import("./replay-runtime.ts").catch((error: unknown) => {
    recorder = undefined;
    throw error;
  });
  recorder.then(
    () => {
      if (replayAllowed()) posthog.startSessionRecording();
    },
    () => console.warn("Could not load session replay"),
  );
};

const deniedUrlProperties = [
  "$current_url",
  "$initial_current_url",
  "$referrer",
  "$initial_referrer",
  "$pathname",
  "$session_entry_url",
  "$session_entry_referrer",
  "$session_exit_url",
];

const deploymentProperties = () => ({
  product_version: "v2",
  surface: "dashboard",
  page_id: browserPageId(),
  environment: import.meta.env.VITE_EXECUTOR_ENVIRONMENT,
  release: documentBuild(),
  executor_test: String(import.meta.env.VITE_EXECUTOR_ENVIRONMENT).startsWith("test-"),
});

const ordinaryRequests: NonNullable<PostHogConfig["fetch_options"]> & { keepalive: false } = {
  keepalive: false,
};

export const startAnalytics = () => {
  if (started) return;
  const key: unknown = import.meta.env.VITE_POSTHOG_KEY;
  if (typeof key !== "string" || key.length === 0) return;
  const path: unknown = import.meta.env.VITE_POSTHOG_PATH;
  if (typeof path !== "string" || !/^\/api\/[a-f0-9]{16}$/.test(path))
    throw new Error("PostHog proxy path is missing from this build");
  posthog.init(key, {
    defaults: "2025-05-24",
    before_send: (event) => {
      if (event?.event === "$snapshot")
        return identified && replayPageAllowed(new URL(location.href)) ? event : null;
      if (event) {
        event.properties.event_id ??= crypto.randomUUID();
        for (const key of deniedUrlProperties) {
          delete event.$set_once?.[key];
          delete event.$set?.[key];
        }
        try {
          const body = new Blob([JSON.stringify(event)], { type: "application/json" });
          void budgetedFetch("analytics")(`${path}/push`, {
            method: "POST",
            body,
            keepalive: true,
          }).catch(() => console.warn("Could not send analytics event"));
        } catch {
          console.warn("Could not encode analytics event");
        }
      }
      return null;
    },
    api_host: `${location.origin}${path}`,
    fetch_options: ordinaryRequests,
    ui_host: import.meta.env.VITE_POSTHOG_HOST,
    autocapture: false,
    opt_out_useragent_filter: import.meta.env.VITE_EXECUTOR_ENVIRONMENT === "test-local",
    property_denylist: deniedUrlProperties,
    capture_pageview: false,
    capture_pageleave: false,
    capture_exceptions: false,
    capture_performance: false,
    disable_session_recording: true,
    session_recording: dashboardReplay,
    enable_recording_console_log: false,
    persistence: "localStorage",
    person_profiles: "identified_only",
  });
  posthog.register(deploymentProperties());
  started = true;
  window.addEventListener("executor:operation-failed", (event) => {
    if (!(event instanceof CustomEvent)) return;
    const failure = Schema.decodeUnknownOption(BrowserOperationFailure)(event.detail);
    if (Option.isSome(failure))
      posthog.capture("browser_operation_failed", {
        ...failure.value,
        ...pageContext(location.pathname, location.search),
      });
  });
  window.addEventListener("executor:product-usage", (event) => {
    if (!(event instanceof CustomEvent)) return;
    const usage = Schema.decodeUnknownOption(BrowserUsage)(event.detail);
    if (Option.isSome(usage))
      posthog.capture("product_action", {
        ...usage.value,
        ...pageContext(location.pathname, location.search),
      });
  });
  document.addEventListener("click", (event) => {
    if (!(event.target instanceof Element)) return;
    const control = event.target.closest("[data-product-action]");
    if (
      !control ||
      control.hasAttribute("disabled") ||
      control.getAttribute("aria-disabled") === "true"
    )
      return;
    const usage = Schema.decodeUnknownOption(BrowserUsage)({
      area: control.getAttribute("data-product-area"),
      action: control.getAttribute("data-product-action"),
      outcome: "started",
    });
    if (Option.isSome(usage))
      posthog.capture("product_action", {
        ...usage.value,
        ...pageContext(location.pathname, location.search),
      });
  });
};

export const pageContext = (pathname: string, search = "") => {
  const segments = pathname.split("/").filter(Boolean);
  const pages = new Set([
    "apps",
    "accounts",
    "connect",
    "settings",
    "groups",
    "account",
    "approvals",
    "billing",
    "setup",
  ]);
  const section = segments[0] === "org" ? segments[2] : segments[0];
  const page =
    section !== undefined && pages.has(section)
      ? section
      : section === "login" ||
          section === "create" ||
          section === "invite" ||
          section === "mcp" ||
          section === "app-auth"
        ? section
        : "home";
  const view = new URLSearchParams(search).get("view");
  const tab =
    view !== null &&
    [
      "overview",
      "tools",
      "accounts",
      "skills",
      "schedules",
      "workflows",
      "settings",
      "source",
      "versions",
      "deployments",
    ].includes(view)
      ? view
      : undefined;
  return {
    ...(tab === undefined ? {} : { tab }),
    page,
    page_kind: segments[0] === "org" && segments.length > 3 ? "detail" : "index",
  };
};

export const capturePageview = (pathname: string) => {
  updateReplay();
  if (started)
    posthog.capture("$pageview", {
      ...pageContext(pathname, location.search),
    });
};

export const captureSupportOpened = () => {
  if (started) posthog.capture("support_opened", pageContext(location.pathname, location.search));
};

export const captureSupportLinkClicked = (label: SupportLink) => {
  if (started)
    posthog.capture("support_link_clicked", {
      label,
      ...pageContext(location.pathname, location.search),
    });
};

export function AnalyticsIdentity() {
  const session = useAtomValue(sessionAtom);
  useEffect(() => {
    if (!started) return;
    if (!AsyncResult.isSuccess(session) || session.waiting) {
      identified = false;
      pauseReplay();
      return;
    }
    identified = session.value !== null;
    if (session.value !== null) {
      const previousUser = posthog.get_property("$user_id");
      if (previousUser !== undefined && previousUser !== session.value.user.id) {
        pauseReplay();
        posthog.reset();
        posthog.register(deploymentProperties());
      }
      if (posthog.get_distinct_id() !== session.value.user.id)
        posthog.identify(session.value.user.id);
    } else if (posthog.get_property("$user_id")) {
      posthog.reset();
      posthog.register(deploymentProperties());
    }
    updateReplay();
  }, [session]);
  return null;
}
