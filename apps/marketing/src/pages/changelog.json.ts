import type { APIRoute } from "astro";

import { parseChangelog } from "../lib/changelog";
import markdown from "executor/CHANGELOG.md?raw";

export const GET: APIRoute = () =>
  new Response(
    JSON.stringify({
      releases: parseChangelog(markdown).slice(0, 20),
    }),
    {
      headers: {
        "access-control-allow-origin": "*",
        "cache-control": "public, max-age=300",
        "content-type": "application/json",
      },
    },
  );
