import type { APIRoute } from "astro";

import { markdownResponse, setupPrompt } from "../content/site-copy";
import { appOrigin, siteOrigin } from "../content/site-origin.ts";

export const GET: APIRoute = () =>
  markdownResponse(`${setupPrompt({ site: siteOrigin, app: appOrigin })}\n`);
