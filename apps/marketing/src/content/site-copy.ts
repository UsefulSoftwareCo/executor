// ---------------------------------------------------------------------------
// Shared marketing copy. One source for text that must read the same in the
// HTML homepage and in the machine-readable Markdown endpoints
// (`/index.md`, `/setup-prompt.md`, `/pricing.md`).
//
// Import from here rather than duplicating strings: the homepage renders the
// human view, the endpoints render the agent view, and both must stay in step.
// ---------------------------------------------------------------------------

/**
 * Copied to the clipboard by the "Set up with your agent" hero CTA, and served
 * verbatim at `/setup-prompt.md`. A visitor pastes it into their coding agent
 * (Claude, Cursor, ...) and the agent picks the right form of Executor,
 * installs it, connects over MCP, and gets a first connection working. Keep in
 * sync with the docs "Set up with your agent" section (apps/docs/index.mdx).
 */
export const setupPrompt = `Help me set up Executor and get my first connection working.

Executor is an open source integration layer for AI agents: one place to configure every integration (MCP servers, OpenAPI specs, GraphQL APIs) and connect to them over MCP.

Start by helping me pick the right form to run it in. Chat with me about it rather than jumping straight to a yes/no question, and recommend one. If I just want the fastest path, suggest Executor Cloud (free tier, nothing to install). All forms expose the same functionality, just packaged differently:

Local (everything stays on my machine):
- Desktop app: a desktop app for Mac, Windows, and Linux. Best for a regular desktop environment.
- CLI (\`executor\`): best for a headless or server environment.
Both run a local HTTP server as a background service that any MCP client can connect to.

Hosted (use it from multiple agents, including cloud ones, with nothing running locally):
- Executor Cloud: hosted, generous free tier, sign in and start immediately.
- Self-hosted: a Docker image.

How to think about it:
- Want all your data on your own machine? Go local: the desktop app for a regular environment, the CLI for a headless one.
- Want to use it from multiple agents (including cloud agents like ChatGPT), or not run anything locally? Go hosted: Executor Cloud is the fastest start; the self-hosted Docker version gives you full control.

Terms you'll come across:
- Integration: anything you add (an MCP server, an OpenAPI spec, a GraphQL API).
- Connection: one configured instance of an integration. An integration can have many connections, and a connection doesn't have to be authenticated.
- Policy: whether each tool is always allowed, requires approval, or is blocked. Policies start from a sensible default derived from the imported spec (for example, GET requests on an OpenAPI spec are allowed by default).

Once you know which form I want:
1. Walk me through installing it.
2. Connect Executor to you over MCP. Most MCP clients only load servers at startup, so after adding it I may need to restart the client or open a new chat before the Executor tools appear. Tell me if that's needed and wait for me to do it before continuing.
3. Once the tools are available, help me add my first integration and get one tool working end to end.

Docs: https://executor.sh/docs
Source (and the place to start if something breaks): https://github.com/UsefulSoftwareCo/executor`;

/** Canonical GitHub repository. */
export const GITHUB_URL = "https://github.com/UsefulSoftwareCo/executor";

/** One-line description of the product, used as the Markdown tagline. */
export const tagline =
  "Executor is an MCP gateway. Anything that speaks MCP, like Claude Code, Cursor, or Codex, points at one endpoint and reaches every tool you connect.";

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
 * Pricing tiers, mirroring the `#pricing` section of the homepage. `/pricing`
 * redirects to that anchor, so the homepage is the human source of truth.
 */
export const pricingTiers: ReadonlyArray<PricingTier> = [
  {
    name: "Free",
    price: "$0 / month",
    audience: "For small teams getting started",
    features: ["Up to 3 members", "100,000 executions per month", "Unlimited integrations"],
    cta: "Start free: https://executor.sh/cloud",
  },
  {
    name: "Team",
    price: "$15 / member / month",
    audience: "For growing organizations (recommended)",
    features: [
      "14-day free trial, then $15 / member / month",
      "Unlimited executions",
      "Verified domains & join by team domain",
    ],
    cta: "Start free trial: https://executor.sh/cloud",
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

/** The six capability cards from the homepage "What you get" section. */
export const capabilities: ReadonlyArray<Capability> = [
  {
    title: "One tool shape",
    body: "MCP, OpenAPI, GraphQL, or a custom integration. Under the hood they all become a tool name, an input schema, and an output schema.",
  },
  {
    title: "Call it any way",
    body: "Today it is a code-mode MCP. It could just as well be the Executor CLI, a one-off script, a gen-UI dashboard, or a reusable workflow. Same tools, every surface.",
  },
  {
    title: "Trace every call",
    body: "One place to see every run and tool call. Audit any decision after the fact.",
    comingSoon: true,
  },
  {
    title: "Set up once, whole team has it",
    body: "Per-user credentials and shared ones. No onboarding ritual, no toggling MCPs on and off mid-task.",
  },
  {
    title: "Destructive actions pull you back in",
    body: "Executor keeps the semantics it imported: GET vs DELETE for OpenAPI, destructiveHint for MCP, mutations for GraphQL. Agents auto-run the safe stuff and ask before the rest.",
  },
  {
    title: "Sandboxed execution",
    body: "Tool calls run in an isolated JavaScript sandbox. Secrets are injected host-side at call time and never enter the sandbox heap, so the agent and model never see a raw token.",
  },
];

export type Faq = { readonly question: string; readonly answer: string };

/** The homepage FAQ. */
export const faqs: ReadonlyArray<Faq> = [
  {
    question: "Where does my code run, and what touches my credentials?",
    answer:
      "Tool calls run in an isolated JavaScript sandbox. Credentials are resolved host-side at call time and injected into the outbound request only. They never enter the sandbox heap, the code your agent wrote, the agent, or the model.",
  },
  {
    question: "Can the agent or the model ever see a raw token?",
    answer:
      "No. Secrets stay host-side by design. The sandbox calls a tool by name; Executor attaches the credential to the real request outside the sandbox, so a token is never present in anything the model can read.",
  },
  {
    question: "What can call Executor?",
    answer:
      "Any MCP client (Claude Code, Cursor, Codex, and others), the Executor CLI, or a native client you drop in. Because tools share one shape, the calling surface is interchangeable.",
  },
  {
    question: "How does it know what is safe to auto-run?",
    answer:
      "Executor preserves the semantics of whatever it imported: GET vs DELETE for OpenAPI, destructiveHint for MCP, and mutations for GraphQL. That tells the agent what it can run on its own and what should pull you back into the loop.",
  },
  {
    question: "Is it open source? Can I self-host?",
    answer:
      "Yes. Executor is MIT licensed and built on the SDK we publish to npm. Run the desktop app locally, self-host the server, or use the hosted cloud. Same code paths, different deployment.",
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
