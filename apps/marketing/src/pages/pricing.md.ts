import type { APIRoute } from "astro";

import { markdownResponse, pricingTiers } from "../content/site-copy";

// ---------------------------------------------------------------------------
// `/pricing.md` — Executor Cloud pricing as Markdown.
//
// `/pricing` redirects to the `#pricing` section of the homepage, so the tier
// data lives in src/content/site-copy.ts and both surfaces read it.
// ---------------------------------------------------------------------------

const tierSections = pricingTiers.map(({ name, price, audience, featuresLabel, features, cta }) =>
  [
    `## ${name}`,
    "",
    `**${price}** — ${audience}`,
    "",
    ...(featuresLabel === undefined ? [] : [`${featuresLabel}:`, ""]),
    ...features.map((f) => `- ${f}`),
    "",
    cta,
  ].join("\n"),
);

const body = `# Executor pricing

> Start free, pay per member. Pricing covers Executor Cloud; the CLI, desktop
> app, and self-hosted server are MIT licensed and free.

${tierSections.join("\n\n")}

## Questions

Email rhys@executor.sh, or read the docs at https://executor.sh/docs.

Other machine-readable pages: [/index.md](https://executor.sh/index.md),
[/setup-prompt.md](https://executor.sh/setup-prompt.md),
[/llms.txt](https://executor.sh/llms.txt).
`;

export const GET: APIRoute = () => markdownResponse(body);
