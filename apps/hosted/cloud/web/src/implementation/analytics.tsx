import { browserPageId, BrowserOperationFailure } from "@executor-js/telemetry/browser";
/** Cloud-only product analytics, sharing the marketing site's PostHog project. */
import posthog from "posthog-js";
import { BrowserUsage } from "@executor-js/hosted-web/contracts/product-analytics";
import { useAtomValue } from "@effect/atom-react";
import { sessionAtom } from "@executor-js/hosted-web/contracts/auth";
import { AsyncResult } from "effect/unstable/reactivity";
import { Schema, Option } from "effect";
import { useEffect } from "react";
import { dashboardReplay, replayPageAllowed } from "./analytics-replay.ts";

let started = false;
let identified = false;

/** Stop before route changes so login, consent and private settings never enter the recorder. */
export const pauseReplay = () => {
  if (started) posthog.stopSessionRecording();
};
const updateReplay = () => {
  if (!started) return;
  if (identified && replayPageAllowed(new URL(location.href))) posthog.startSessionRecording();
  else posthog.stopSessionRecording();
};

/** URL fingerprints are kept out of PostHog on every property channel, not just events. */
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
  release: import.meta.env.VITE_EXECUTOR_RELEASE,
  executor_test: String(import.meta.env.VITE_EXECUTOR_ENVIRONMENT).startsWith("test-"),
});

/** Initialize explicit event capture at the browser entry point. */
export const startAnalytics = () => {
  if (started) return;
  const key: unknown = import.meta.env.VITE_POSTHOG_KEY;
  if (typeof key !== "string" || key.length === 0) return;
  const path: unknown = import.meta.env.VITE_POSTHOG_PATH;
  if (typeof path !== "string" || !/^\/api\/[a-f0-9]{16}$/.test(path))
    throw new Error("PostHog proxy path is missing from this build");
  posthog.init(key, {
    defaults: "2025-05-24",
    // Keep SDK identity/attribution, but deliver analytics without vendor URL fingerprints.
    before_send: (event) => {
      // Replay owns its chunked /s/ transport; sending snapshots to the event endpoint loses recordings.
      if (event?.event === "$snapshot")
        return identified && replayPageAllowed(new URL(location.href)) ? event : null;
      if (event) {
        event.properties.event_id ??= crypto.randomUUID();
        // property_denylist covers event.properties only. Initial person properties
        // travel on $set_once and $set, and $initial_current_url is the raw
        // first-visit href, including an invitation token or an OAuth code.
        for (const key of deniedUrlProperties) {
          delete event.$set_once?.[key];
          delete event.$set?.[key];
        }
        try {
          const body = new Blob([JSON.stringify(event)], { type: "application/json" });
          if (!navigator.sendBeacon(`${path}/push`, body))
            console.warn("Could not queue analytics event");
        } catch {
          console.warn("Could not encode analytics event");
        }
      }
      // This adapter owns delivery; the SDK must not send the same event again.
      return null;
    },
    api_host: `${location.origin}${path}`,
    ui_host: import.meta.env.VITE_POSTHOG_HOST,
    autocapture: false,
    // The managed loopback receiver exercises capture from an automated browser. Production keeps bot filtering.
    opt_out_useragent_filter:
      import.meta.env.DEV && import.meta.env.VITE_EXECUTOR_ENVIRONMENT === "test-local",
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

/** Route categories avoid high-cardinality customer names, resource IDs and capability values. */
export const pageContext = (pathname: string, search = "") => {
  const segments = pathname.split("/").filter(Boolean);
  const pages = new Set([
    "apps",
    "accounts",
    "connect",
    "settings",
    "groups",
    "api-keys",
    "approvals",
    "billing",
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

/** Record resolved SPA navigation without OAuth codes, search parameters or fragments. */
export const capturePageview = (pathname: string) => {
  updateReplay();
  if (started)
    posthog.capture("$pageview", {
      ...pageContext(pathname, location.search),
    });
};

/** Identify only confirmed sessions; reset persisted identity after confirmed sign-out. */
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
