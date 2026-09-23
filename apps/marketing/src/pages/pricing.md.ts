import type { APIRoute } from "astro";

import { markdownResponse, pricingTiers } from "../content/site-copy";
import { siteOrigin } from "../content/site-origin.ts";

// ---------------------------------------------------------------------------
// `/pricing.md` — Executor Cloud pricing as Markdown.
//
// `/pricing` is the pricing page, so the tier
// data lives in src/content/site-copy.ts and both surfaces read it.
// ---------------------------------------------------------------------------

const tierSections = pricingTiers(siteOrigin).map(
  ({ name, price, audience, featuresLabel, features, cta }) =>
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

Email rhys@executor.sh, or read the docs at ${siteOrigin}/docs.

Other machine-readable pages: [/index.md](${siteOrigin}/index.md),
[/setup-prompt.md](${siteOrigin}/setup-prompt.md),
[/llms.txt](${siteOrigin}/llms.txt).
`;

export const GET: APIRoute = () => markdownResponse(body);
