import type { APIRoute } from "astro";

import { changelogBodyToText } from "../lib/changelog-html";
import { parseChangelog } from "../lib/changelog";
import markdown from "executor/CHANGELOG.md?raw";

// Read cross-origin by every self-hosted install, so the payload carries no
// markup at all: each body is flattened to plain text. Consumers render the
// highlights as text, and a consumer that did inject a body could not be handed
// anything to execute.
const payload = JSON.stringify({
  releases: parseChangelog(markdown)
    .slice(0, 20)
    .map((release) => ({
      ...release,
      entries: release.entries.map((entry) => ({
        ...entry,
        body: changelogBodyToText(entry.body),
      })),
    })),
});

export const GET: APIRoute = () =>
  new Response(payload, {
    headers: {
      "access-control-allow-origin": "*",
      "cache-control": "public, max-age=300",
      "content-type": "application/json",
      "x-content-type-options": "nosniff",
    },
  });
