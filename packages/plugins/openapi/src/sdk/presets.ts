import type { HealthCheckSpec, IntegrationPresetAuthentication } from "@executor-js/sdk/core";
import type { SpecOverrides } from "./spec-overrides";

export interface OpenApiPreset {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  readonly url?: string;
  readonly icon?: string;
  readonly featured?: boolean;
  readonly family?: string;
  readonly specFormat?: string;
  readonly defaultSlug?: string;
  readonly specOverrides?: SpecOverrides;
  readonly authTemplate?: readonly IntegrationPresetAuthentication[];
  readonly healthCheck?: HealthCheckSpec;
}

/** GitHub OAuth-app flow (classic apps, not GitHub Apps): scopes are requested
 *  at authorize time, tokens don't expire, and the token endpoint returns
 *  form-encoded unless the request sends `Accept: application/json` — which the
 *  SDK's token exchange always does (oauth4webapi sets it). `repo` + `read:org`
 *  + `user:email` covers the common repo/issue/PR surface without admin grants. */
export const GITHUB_SUPPORTED_OAUTH_SCOPES = ["repo", "read:org", "user:email"] as const;

export const GITHUB_OAUTH_TEMPLATE: IntegrationPresetAuthentication = {
  slug: "oauth2",
  kind: "oauth2",
  authorizationUrl: "https://github.com/login/oauth/authorize",
  tokenUrl: "https://github.com/login/oauth/access_token",
  scopes: GITHUB_SUPPORTED_OAUTH_SCOPES,
};

export const FIGMA_SUPPORTED_OAUTH_SCOPES = [
  "current_user:read",
  "file_comments:read",
  "file_comments:write",
  "file_content:read",
  "file_dev_resources:read",
  "file_dev_resources:write",
  "file_metadata:read",
  "file_versions:read",
  "folder_metadata:read",
  "folders:read",
  "library_assets:read",
  "library_content:read",
  "team_library_content:read",
  "webhooks:read",
  "webhooks:write",
] as const;

export const FIGMA_SPEC_OVERRIDES: SpecOverrides = [
  {
    op: "replace",
    path: "/components/securitySchemes/OAuth2/flows/authorizationCode/scopes",
    value: Object.fromEntries(FIGMA_SUPPORTED_OAUTH_SCOPES.map((scope) => [scope, ""])),
  },
];

const openApiOnlyPresets: readonly OpenApiPreset[] = [
  {
    id: "figma",
    name: "Figma",
    summary: "Files, comments, components, variables, projects, and webhooks.",
    url: "https://raw.githubusercontent.com/figma/rest-api-spec/refs/heads/main/openapi/openapi.yaml",
    icon: "https://integrations.sh/logo/figma.com",
    featured: true,
    defaultSlug: "figma_api",
    specOverrides: FIGMA_SPEC_OVERRIDES,
  },
  {
    id: "stripe",
    name: "Stripe",
    summary: "Payments, subscriptions, customers, and invoices.",
    url: "https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.json",
    icon: "https://integrations.sh/logo/stripe.com",
    featured: true,
  },
  {
    id: "github-rest",
    name: "GitHub REST",
    summary: "Repos, issues, pull requests, actions, and users.",
    url: "https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.json",
    icon: "https://svgl.app/library/github_dark.svg",
    featured: true,
    authTemplate: [GITHUB_OAUTH_TEMPLATE],
  },
  {
    id: "vercel",
    name: "Vercel",
    summary: "Deployments, domains, projects, and edge config.",
    url: "https://openapi.vercel.sh",
    icon: "https://integrations.sh/logo/vercel.com",
    featured: true,
  },
  {
    id: "cloudflare",
    name: "Cloudflare",
    summary: "DNS, workers, pages, R2, and security rules.",
    url: "https://raw.githubusercontent.com/cloudflare/api-schemas/main/openapi.json",
    icon: "https://integrations.sh/logo/cloudflare.com",
    featured: true,
  },
  {
    id: "neon",
    name: "Neon",
    summary: "Serverless Postgres: projects, branches, and endpoints.",
    url: "https://neon.tech/api_spec/release/v2.json",
    icon: "https://integrations.sh/logo/neon.tech",
    featured: true,
  },
  {
    id: "openai",
    name: "OpenAI",
    summary: "Models, files, responses, and fine-tuning.",
    url: "https://app.stainless.com/api/spec/documented/openai/openapi.documented.yml",
    icon: "https://svgl.app/library/openai_dark.svg",
    featured: true,
  },
  {
    id: "sentry",
    name: "Sentry",
    summary: "Error tracking, performance monitoring, and releases.",
    url: "https://raw.githubusercontent.com/getsentry/sentry-api-schema/main/openapi-derefed.json",
    icon: "https://svgl.app/library/sentry.svg",
    featured: true,
  },
  {
    id: "posthog",
    name: "PostHog",
    summary: "Product analytics, events, feature flags, and insights.",
    url: "https://us.posthog.com/api/schema/",
    icon: "https://svgl.app/library/posthog.svg",
    featured: true,
  },
  {
    id: "exa",
    name: "Exa",
    summary: "Web search, similar links, content retrieval, and answers.",
    url: "https://raw.githubusercontent.com/exa-labs/openapi-spec/refs/heads/master/exa-openapi-spec.yaml",
    icon: "https://integrations.sh/logo/exa.ai",
    featured: true,
  },
  {
    id: "exa-websets",
    name: "Exa Websets",
    summary: "Websets, enrichments, webhooks, and monitors.",
    url: "https://raw.githubusercontent.com/exa-labs/openapi-spec/refs/heads/master/exa-websets-spec.yaml",
    icon: "https://integrations.sh/logo/exa.ai",
    featured: true,
  },
  {
    id: "axiom",
    name: "Axiom",
    summary: "Log ingestion, querying, datasets, and monitors.",
    url: "https://axiom.co/docs/restapi/versions/v2.json",
    icon: "https://integrations.sh/logo/axiom.co",
  },
  {
    id: "asana",
    name: "Asana",
    summary: "Tasks, projects, teams, and workspace management.",
    url: "https://raw.githubusercontent.com/APIs-guru/openapi-directory/main/APIs/asana.com/1.0/openapi.yaml",
    icon: "https://integrations.sh/logo/asana.com",
  },
  {
    id: "twilio",
    name: "Twilio",
    summary: "SMS, voice, video, and messaging APIs.",
    url: "https://raw.githubusercontent.com/twilio/twilio-oai/main/spec/json/twilio_api_v2010.json",
    icon: "https://integrations.sh/logo/twilio.com",
  },
  {
    id: "digitalocean",
    name: "DigitalOcean",
    summary: "Droplets, Kubernetes, databases, and networking.",
    url: "https://raw.githubusercontent.com/digitalocean/openapi/main/specification/DigitalOcean-public.v2.yaml",
    icon: "https://integrations.sh/logo/digitalocean.com",
  },
  {
    id: "petstore",
    name: "Petstore",
    summary: "Classic OpenAPI demo, no auth required.",
    url: "https://petstore3.swagger.io/api/v3/openapi.json",
    icon: "https://integrations.sh/logo/petstore3.swagger.io",
  },
  {
    id: "val-town",
    name: "Val Town",
    summary: "Vals, runs, blobs, and email/web endpoints.",
    url: "https://api.val.town/openapi.json",
    icon: "https://integrations.sh/logo/val.town",
  },
  {
    id: "resend",
    name: "Resend",
    summary: "Transactional email sending and domain management.",
    url: "https://raw.githubusercontent.com/resend/resend-openapi/main/resend.yaml",
    icon: "https://integrations.sh/logo/resend.com",
  },
  {
    id: "spotify",
    name: "Spotify",
    summary: "Tracks, albums, playlists, library, and playback.",
    url: "https://raw.githubusercontent.com/sonallux/spotify-web-api/refs/heads/main/official-spotify-open-api.yml",
    icon: "https://svgl.app/library/spotify.svg",
  },
];

export const openApiPresets: readonly OpenApiPreset[] = openApiOnlyPresets;
