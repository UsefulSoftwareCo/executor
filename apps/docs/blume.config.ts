import type { AstroIntegration } from "astro";
import { sentryVitePlugin } from "@sentry/vite-plugin";
import { defineConfig } from "blume";
import { appOrigin, siteOrigin } from "@executor-js/marketing/site-origin";
import { assetsInlineLimit } from "@executor-js/marketing/script-assets";
import { releaseCommandMarkdown } from "./release-commands.ts";
import { release } from "../../scripts/releases/config.ts";

const localFamily = (name: string, file: string) => ({
  name,
  variants: [
    { src: `./fonts/${file}.woff2`, style: "normal" as const },
    { src: `./fonts/${file}-italic.woff2`, style: "italic" as const },
  ],
});
const geist = localFamily("Geist", "geist-latin");
const geistMono = localFamily("Geist Mono", "geist-mono-latin");

const analyticsKey = process.env.PUBLIC_POSTHOG_KEY;
const analyticsPath = process.env.PUBLIC_POSTHOG_PATH ?? "";
if (analyticsKey && !/^\/api\/[a-f0-9]{16}$/.test(analyticsPath))
  throw new Error("PostHog proxy path is missing from this build");
const environment = process.env.PUBLIC_EXECUTOR_ENVIRONMENT ?? "";

const analyticsSettings = `(function(){
  var queued = window.posthog && window.posthog._i && window.posthog._i[0];
  if (!queued) return;
  var path = ${JSON.stringify(analyticsPath)};
  Object.assign(queued[1], {
    defaults: "2025-05-24",
    // One delivery hop, over the browser's own beacon transport, to a neutral
    // path the Worker rewrites onto PostHog ingestion. Returning null stops
    // the SDK's own send, so no vendor capture path or compression and
    // version query signature ever leaves the page. Consent, identity,
    // session attribution and campaign properties all run before this point.
    before_send: function (event) {
      if (event) {
        try {
          var body = new Blob([JSON.stringify(event)], { type: "application/json" });
          if (!navigator.sendBeacon(path + "/push", body)) console.warn("Could not queue analytics event");
        } catch (error) { console.warn("Could not encode analytics event"); }
      }
      return null;
    },
    ui_host: ${JSON.stringify(process.env.PUBLIC_POSTHOG_HOST ?? "https://us.posthog.com")},
    autocapture: false,
    // Blume captures a view per client-router navigation itself; this covers
    // the initial load only.
    capture_pageview: true,
    persistence: "localStorage",
    disable_session_recording: true,
    capture_exceptions: false,
    person_profiles: "identified_only",
    // Registered before the first capture, so every documentation event
    // carries the same surface properties as the marketing site.
    loaded: function (client) {
      client.register({
        product_version: "v2",
        surface: "docs",
        environment: ${JSON.stringify(environment)},
        release: ${JSON.stringify(process.env.PUBLIC_EXECUTOR_RELEASE ?? "")},
        executor_test: ${String(environment.startsWith("test-"))},
      });
    },
  });
})();`;

const errors: AstroIntegration = {
  name: "executor-docs-errors",
  hooks: {
    "astro:config:setup": ({ updateConfig }) => {
      updateConfig({
        vite: {
          build: { sourcemap: "hidden", assetsInlineLimit },
          plugins: process.env.SENTRY_AUTH_TOKEN
            ? [
                sentryVitePlugin({
                  telemetry: false,
                  sourcemaps: { filesToDeleteAfterUpload: ["./dist/**/*.map"] },
                }),
              ]
            : [],
        },
      });
    },
  },
};
export default defineConfig({
  integrations: [errors],
  title: "Executor docs",
  description: "Connect your accounts once, then use them from the dashboard or any MCP client.",
  content: { root: "content" },
  seo: { og: { logo: "/executor-og-logo.svg" } },
  ...(analyticsKey === undefined
    ? {}
    : {
        analytics: {
          posthog: { key: analyticsKey, host: analyticsPath },
          scripts: [{ content: analyticsSettings }],
        },
      }),
  deployment: { output: "static", site: siteOrigin, base: "/docs" },
  redirects: [{ from: "/concepts/apps-and-deployments", to: "/concepts/apps-and-versions" }],
  theme: {
    accent: { light: "#111111", dark: "#ededed" },
    mode: "system",
    radius: "md",
    fonts: { display: geist, body: geist, mono: geistMono },
  },
  ai: {
    markdownComponents: {
      ReleaseCommand: ({ props }) => releaseCommandMarkdown(props.product),
      ReleaseDesktopLink: () =>
        `[Download the desktop installer.](${release.cloudOrigin}/#install)`,
    },
    llmsTxt: {
      enabled: true,
      details: [
        "## When to use Executor",
        "",
        "Executor holds the credentials for services you already use and turns them into tools.",
        "Reach for it when an agent needs to call a real service without holding the credential:",
        "connect an account once, then call the app through one MCP endpoint at `<origin>/mcp`.",
        `The hosted origin is \`${appOrigin}\`. Executor also runs locally and self-hosted.`,
      ].join("\n"),
    },
  },
  navigation: {
    sidebar: [
      { label: "Getting started", items: ["/", "/connect-an-account"] },
      { label: "Agents and MCP", items: ["/mcp", "/mcp-clients", "/api-keys"] },
      {
        label: "Concepts",
        items: [
          "/concepts/providers-and-accounts",
          "/concepts/apps-and-versions",
          "/concepts/tools-and-approvals",
          "/concepts/organizations-and-access",
        ],
      },
      { label: "Build", items: ["/author-an-app", "/desktop-apps"] },
      {
        label: "Run Executor yourself",
        items: ["/run/cli", "/run/self-host", "/run/tracing", "/run/usage-analytics"],
      },
    ],
  },
});
