export interface OpenApiPreset {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  readonly url?: string;
  readonly icon?: string;
  readonly featured?: boolean;
}

const openApiOnlyPresets: readonly OpenApiPreset[] = [
  {
    id: "stripe",
    name: "Stripe",
    summary: "Payments, subscriptions, customers, and invoices.",
    url: "https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.json",
    icon: "https://stripe.com/favicon.ico",
    featured: true,
  },
  {
    id: "github-rest",
    name: "GitHub REST",
    summary: "Repos, issues, pull requests, actions, and users.",
    url: "https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.json",
    icon: "https://svgl.app/library/github_dark.svg",
    featured: true,
  },
  {
    id: "vercel",
    name: "Vercel",
    summary: "Deployments, domains, projects, and edge config.",
    url: "https://openapi.vercel.sh",
    icon: "https://vercel.com/favicon.ico",
    featured: true,
  },
  {
    id: "cloudflare",
    name: "Cloudflare",
    summary: "DNS, workers, pages, R2, and security rules.",
    url: "https://raw.githubusercontent.com/cloudflare/api-schemas/main/openapi.json",
    icon: "https://cloudflare.com/favicon.ico",
    featured: true,
  },
  {
    id: "neon",
    name: "Neon",
    summary: "Serverless Postgres: projects, branches, and endpoints.",
    url: "https://neon.tech/api_spec/release/v2.json",
    icon: "https://neon.tech/favicon/favicon.ico",
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
    icon: "https://exa.ai/images/favicon-32x32.png",
    featured: true,
  },
  {
    id: "exa-websets",
    name: "Exa Websets",
    summary: "Websets, enrichments, webhooks, and monitors.",
    url: "https://raw.githubusercontent.com/exa-labs/openapi-spec/refs/heads/master/exa-websets-spec.yaml",
    icon: "https://exa.ai/images/favicon-32x32.png",
    featured: true,
  },
  {
    id: "axiom",
    name: "Axiom",
    summary: "Log ingestion, querying, datasets, and monitors.",
    url: "https://axiom.co/docs/restapi/versions/v2.json",
    icon: "https://axiom.co/favicon.ico",
  },
  {
    id: "asana",
    name: "Asana",
    summary: "Tasks, projects, teams, and workspace management.",
    url: "https://raw.githubusercontent.com/APIs-guru/openapi-directory/main/APIs/asana.com/1.0/openapi.yaml",
    icon: "https://asana.com/favicon.ico",
  },
  {
    id: "twilio",
    name: "Twilio",
    summary: "SMS, voice, video, and messaging APIs.",
    url: "https://raw.githubusercontent.com/twilio/twilio-oai/main/spec/json/twilio_api_v2010.json",
    icon: "https://twilio.com/favicon.ico",
  },
  {
    id: "digitalocean",
    name: "DigitalOcean",
    summary: "Droplets, Kubernetes, databases, and networking.",
    url: "https://raw.githubusercontent.com/digitalocean/openapi/main/specification/DigitalOcean-public.v2.yaml",
    icon: "https://assets.digitalocean.com/favicon.ico",
  },
  {
    id: "petstore",
    name: "Petstore",
    summary: "Classic OpenAPI demo, no auth required.",
    url: "https://petstore3.swagger.io/api/v3/openapi.json",
    icon: "https://petstore3.swagger.io/favicon-32x32.png",
  },
  {
    id: "val-town",
    name: "Val Town",
    summary: "Vals, runs, blobs, and email/web endpoints.",
    url: "https://api.val.town/openapi.json",
    icon: "https://www.val.town/favicon.svg",
  },
  {
    id: "resend",
    name: "Resend",
    summary: "Transactional email sending and domain management.",
    url: "https://raw.githubusercontent.com/resend/resend-openapi/main/resend.yaml",
    icon: "https://resend.com/static/favicons/favicon.ico",
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
