import type { APIRoute } from "astro";

import { markdownResponse, setupPrompt } from "../content/site-copy";
import { siteOrigin } from "../content/site-origin.ts";

// ---------------------------------------------------------------------------
// `/setup-prompt.md` — the exact string the homepage "Set up with your agent"
// button copies to the clipboard. An agent can fetch it instead of asking the
// visitor to paste it.
// ---------------------------------------------------------------------------

export const GET: APIRoute = () => markdownResponse(`${setupPrompt(siteOrigin)}\n`);
