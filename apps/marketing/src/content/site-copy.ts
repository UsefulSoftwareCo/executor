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
export const setupPrompt = (siteOrigin: string) => `Help me build something useful with Executor.

Executor is a place to deploy software that my agents and I can use: custom tools, skills, automations, and apps with saved data and a UI. An existing MCP or API can be a starting point, or you can write the code for something new.

Ask what I want to do. Start with the smallest useful version. Explain what it will do before building it.

Help me sign in at ${siteOrigin}/login and connect Executor to you over MCP. If your client needs a restart to load its tools, tell me and wait until they are available.

Read Executor's app-authoring guide through its skills tool. Check what this Executor host supports. Use its management tools to build and deploy the app. Connect any required accounts through the secure connection flow and select them for the app. Never ask me to paste credentials into this chat or put them in source code.

Explain what the app can read or change, and ask before actions that send, delete, or publish anything. Verify the result with a safe call. Keep its source so I can ask you or another agent to change it later. Add features only when they serve the task I asked for.

Docs: ${siteOrigin}/docs`;

/** Canonical GitHub repository. */
export const GITHUB_URL = "https://github.com/UsefulSoftwareCo/executor";

/** One-line description of the product, used as the Markdown tagline. */
export const tagline = "Built by your agents. Run by Executor.";

/** Shared introduction for the landing page and its Markdown representation. */
export const introduction =
  "Bring your own agents. Build tools, automations, and apps once. Run them on Executor and use them across all your agents.";

/** Introduce personal software through a familiar starting point and a growing app. */
export const homepageStory = {
  start: {
    title: "Start with something useful.",
    body: "Bring a tool you already use, give your agent a skill, or ask it to build something you wish existed. Start small. You can change it as you go.",
  },
  build: {
    title: "Ask for what you actually need.",
    body: "Executor is not an agent. It’s a place for your agent to build and run software.",
    prompt:
      "Pull together my signups and open issues. Give my agents one way to check what's changed.",
  },
  automate: {
    title: "Let it keep working.",
    body: "Give that tool a schedule. Keep a history of what it finds. Add a page you can open. Executor runs the app, even after the conversation ends.",
    prompt: "Run this every weekday at 9. Save the results and build me a page to read them.",
  },
  apps: {
    title: "That's an Executor app.",
    body: "A tool your agent can call. An automation that runs on its own. An interface you can use. They can all be parts of the same app, built around what you need.",
  },
} as const;

/** Plain definition shared by the illustrated section and Markdown overview. */
export const appDefinition = homepageStory.apps.body;

/** Capabilities an app can include, with tools first. */
export const appParts = [
  { title: "Tools", body: "Call anything, it's just JavaScript." },
  { title: "Skills", body: "Give your agent instructions it can use again." },
  { title: "UI", body: "A page for your app, at its own URL." },
  { title: "Storage", body: "Keep data and state between runs." },
  { title: "Triggers", body: "Run on a schedule or respond to webhooks." },
  { title: "Workflows", body: "Durable work across multiple steps." },
] as const;

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
export const pricingTiers = (siteOrigin: string): ReadonlyArray<PricingTier> => [
  {
    name: "Free",
    price: "$0 / month",
    audience: "For small teams getting started",
    features: ["Up to 3 members", "Unlimited integrations"],
    cta: `Start free: ${siteOrigin}/login`,
  },
  {
    name: "Team",
    price: "$15 / member / month",
    audience: "For growing organizations (recommended)",
    features: [
      "14-day free trial, then $15 / member / month",
      "Verified domains & join by team domain",
    ],
    cta: `Start free trial: ${siteOrigin}/login`,
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
