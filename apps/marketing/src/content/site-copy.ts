// ---------------------------------------------------------------------------
// Shared marketing copy. One source for text that must read the same in the
// HTML homepage and in the machine-readable Markdown endpoints
// (`/index.md`, `/setup-prompt.md`, `/pricing.md`).
//
// Import from here rather than duplicating strings: the homepage renders the
// human view, the endpoints render the agent view, and both must stay in step.
// ---------------------------------------------------------------------------

/**
 * Copied by the hero CTA and served verbatim at `/setup-prompt.md`.
 * Helps an agent turn the user's need into a small, useful Executor app.
 */
export const setupPrompt = (origins: {
  readonly site: string;
  readonly app: string;
}) => `Help me build something useful with Executor.

Executor is a place to deploy software that my agents and I can use: custom tools, skills, automations, and apps with saved data and a UI. An existing MCP or API can be a starting point, or you can write the code for something new.

Ask what I want to do. Start with the smallest useful version. Explain what it will do before building it.

Help me sign in at ${origins.app}/login and connect Executor to you over MCP. If your client needs a restart to load its tools, tell me and wait until they are available.

Read the Executor app's executor skill through Executor's skills tool, then its app-authoring skill. Check what this Executor host supports. Use its management tools to build and deploy the app. Connect any required accounts through the secure connection flow and select them for the app. Never ask me to paste credentials into this chat or put them in source code.

Explain what the app can read or change, and ask before actions that send, delete, or publish anything. Verify the result with a safe call. Keep its source so I can ask you or another agent to change it later. Add features only when they serve the task I asked for.

Docs: ${origins.site}/docs`;

/** Canonical GitHub repository. */
export const GITHUB_URL = "https://github.com/UsefulSoftwareCo/executor";

/** One-line description of the product, used as the Markdown tagline. */
export const tagline = "Everything you use, connected in one place.";

/** The hero's third beat: what you do once it is all connected. */
export const taglineBuild = "Then build whatever you need on top.";

/** Shared introduction for metadata and Markdown. */
export const introduction =
  "Executor connects the tools you use to the agent you already use, through one MCP server. Then your agent can build whatever you need on top: custom tools, automations, storage, and interfaces.";

/** The hero subhead's lead sentence. */
export const heroLead = "Executor is your agents' cloud.";

/** What Executor holds, in the order the hero subhead lists them. */
export const heroItems = [
  { label: "connectors" },
  { label: "skills" },
  { label: "automations" },
  { label: "personal software" },
  { label: "browser", comingSoon: true },
  { label: "computer", comingSoon: true },
] as const;

/** The subhead as plain text, listing only what ships today. */
export const heroSubhead = `${heroLead} All of your ${heroItems
  .filter((item) => !("comingSoon" in item))
  .map((item) => item.label)
  .join(", ")}, all in one place.`;

/** Capabilities an app can include, with tools first. */
export const appParts = [
  { title: "Tools", body: "Call anything, it's just JavaScript." },
  { title: "Skills", body: "Give your agent instructions it can use again." },
  { title: "Apps", body: "A page for people, beside the tools for agents." },
  { title: "Storage", body: "Keep data and state between runs." },
  { title: "Triggers", body: "Run on a schedule or respond to webhooks." },
  { title: "Workflows", body: "Durable work across multiple steps." },
] as const;

/**
 * The homepage teaches the tagline one clause at a time: everything you use,
 * connected in one place, then built on.
 */
export const homepageStory = {
  everything: {
    title: "Everything you use.",
    body: "Gmail, Calendar, GitHub, Linear, Stripe. Add an MCP server you already have, or ask your agent to write the tool. You connect each account once through a secure link, so credentials never end up in chat or in code.",
  },
  connected: {
    title: "Connected in one place.",
    body: "Add Executor to your agent once. Every account you connect is then available to every agent you use. Your agent does the thinking; Executor is where it reaches your tools, and where the things it builds keep running.",
  },
  build: {
    title: "Then build whatever you need on top.",
    body: "Start with the tools a service already has. When something's missing, ask your agent to add it. Here's how one Gmail connection grows:",
  },
  more: {
    title: "Some other things to ask for",
  },
  apps: {
    title: "As small or as large as you need.",
    body: "An app can be a single tool. It can also combine tools, storage, a page, schedules, webhooks, and workflows. Add each piece when you need it.",
  },
} as const;

/** One service, extended a step at a time. The homepage animates through it. */
export const gmailLadder = [
  {
    piece: "Tools",
    title: "Connect Gmail",
    prompt: "Connect my Gmail.",
    result: "Your agent can search, read, label, and send mail.",
  },
  {
    piece: "Workflow",
    title: "Undo send",
    prompt: "Hold every email I send for five minutes so I can cancel it.",
    result: "Sends wait in a durable workflow. Cancel any of them before they go.",
  },
  {
    piece: "Storage",
    title: "Notes",
    prompt: "Let me keep notes on the emails I get.",
    result: "Notes live in the app's own SQLite database, ready for any agent to search.",
  },
  {
    piece: "Webhook",
    title: "Auto-archive",
    prompt: "Archive newsletters as soon as they arrive.",
    result: "Gmail notifies the app, and the app archives them. No agent needed.",
  },
  {
    piece: "UI",
    title: "Your own inbox",
    prompt: "Build me a Superhuman-style inbox with keyboard shortcuts.",
    result: "A page for you, built on the same tools your agent uses.",
  },
] as const;

/** Short examples beyond Gmail, each naming the pieces it uses. */
export const moreExamples = [
  {
    prompt: "Every three hours, copy new Stripe customers into Notion.",
    pieces: ["Schedule", "Tool"],
    result: "A cron job moves the data. No agent has to be running.",
    logos: ["stripe", "notion"],
  },
  {
    prompt: "Every Friday, post what shipped on GitHub to Slack.",
    pieces: ["Schedule", "Tool"],
    result: "Runs at 5pm every Friday, the same way every time.",
    logos: ["github", "slack"],
  },
  {
    prompt: "When a Sentry issue spikes, open a Linear ticket.",
    pieces: ["Webhook", "Tool"],
    result: "Sentry calls the app, and the app files the ticket.",
    logos: ["sentry", "linear"],
  },
  {
    prompt: "Show me signups, errors, and open issues on one page.",
    pieces: ["UI", "Tool"],
    result: "A one-off dashboard stops being a project.",
    logos: ["posthog", "sentry", "github"],
  },
] as const;

/** The questions people ask first, answered plainly. */
export const differences: ReadonlyArray<{ readonly question: string; readonly answer: string }> = [
  {
    question: "Is it an agent?",
    answer:
      "No. Executor runs no AI. It extends the agent you already use, through one MCP server.",
  },
  {
    question: "Is it like Composio?",
    answer:
      "Both connect your accounts. With Executor you can also bring your own integrations, change how any tool works, and build apps on top of them.",
  },
  {
    question: "Is it like n8n or Zapier?",
    answer:
      "There's no flow builder. Your agent writes the automation as code, and Executor runs it on a schedule or when a webhook arrives.",
  },
  {
    question: "Is it still an MCP gateway?",
    answer:
      "Yes. Connecting your tools and routing your agent to them is where it starts. Everything else is optional.",
  },
];

/** Plain definition shared by the illustrated section and Markdown overview. */
export const appDefinition = homepageStory.apps.body;

/** Cache-Control for the Markdown endpoints. Short, so copy edits land fast. */
export const MARKDOWN_CACHE_CONTROL = "public, max-age=300";

/** Content-Type for the Markdown endpoints. */
export const MARKDOWN_CONTENT_TYPE = "text/markdown; charset=utf-8";

export type PricingTier = {
  readonly name: string;
  readonly price: string;
  readonly audience: string;
  readonly featuresLabel?: string;
  readonly features: ReadonlyArray<string>;
  readonly cta: string;
};

/**
 * Pricing tiers. The `/pricing` page and `/pricing.md` both read this list,
 * so it is the single source of truth.
 */
export const pricingTiers = (appOrigin: string): ReadonlyArray<PricingTier> => [
  {
    name: "Free",
    price: "$0 / month",
    audience: "For small teams getting started",
    features: ["Up to 3 members", "Unlimited integrations"],
    cta: `Start free: ${appOrigin}/login?mode=signup`,
  },
  {
    name: "Team",
    price: "$15 / member / month",
    audience: "For growing organizations (recommended)",
    features: [
      "14-day free trial, then $15 / member / month",
      "Verified domains & join by team domain",
    ],
    cta: `Start free trial: ${appOrigin}/login?mode=signup`,
  },
  {
    name: "Enterprise",
    price: "Custom",
    audience: "For orgs with custom needs",
    featuresLabel: "Everything in Team, plus",
    features: [
      "Self-hosted or dedicated cloud deployment support",
      "SSO / SAML & SCIM provisioning",
      "Audit logs for every tool call",
      "Dedicated support & onboarding",
      "Security reviews, DPA & SOC 2 on request",
    ],
    cta: "Contact rhys@executor.sh",
  },
];

export type Capability = {
  readonly title: string;
  readonly body: string;
  readonly comingSoon?: boolean;
};

/** Benefits shared by the homepage and the Markdown overview. */
export const capabilities: ReadonlyArray<Capability> = [
  {
    title: "Start with what you have.",
    body: "Add an MCP server or deploy your own code. Executor gives your apps a home.",
  },
  {
    title: "Connect once. Use it again.",
    body: "Select the accounts each app needs. Reuse your connections across apps.",
  },
  {
    title: "Change it. Deploy again.",
    body: "Keep improving your app. Executor retains its source and earlier code versions.",
  },
  {
    title: "Use it from your agents.",
    body: "Your apps live on Executor Cloud, ready for Claude Code, Codex, Cursor, and other MCP clients.",
  },
];

export type Faq = { readonly question: string; readonly answer: string };

/** Product questions for the machine-readable overview. */
export const faqs: ReadonlyArray<Faq> = [
  {
    question: "What is personal software?",
    answer:
      "Apps built or adapted for your own needs. Start with an MCP server, a custom tool, or a skill. Add only what you need.",
  },
  {
    question: "Do I need to write the code myself?",
    answer:
      "You can start by adding an existing MCP server. When you want to extend it, ask your coding agent or write the code yourself. A skill is also enough to start.",
  },
  {
    question: "How are my credentials used?",
    answer:
      "Executor stores account credentials separately from app source and supplies the selected credentials to app server code when it runs. Only run app code you trust. OAuth refresh tokens and client secrets remain with the host.",
  },
  {
    question: "Can I use more than one account?",
    answer:
      "Yes. Make separate configured copies of an app for different accounts, or write an app that uses several accounts together.",
  },
  {
    question: "Can every app have a web page and saved data?",
    answer:
      "Private app pages and saved app data are available locally. Self-hosted supports private app pages. Cloud app pages and hosted app data are still in development.",
  },
];

/** Response helper shared by the Markdown endpoints. */
export const markdownResponse = (body: string): Response =>
  new Response(body, {
    headers: {
      "Content-Type": MARKDOWN_CONTENT_TYPE,
      "Cache-Control": MARKDOWN_CACHE_CONTROL,
    },
  });
