import { array, decodeJson, number, object, ResponseStatusError, string, type Webhook } from "apps";
import type { WebhookCtx } from "./context.ts";
import { searchMail } from "./tools.ts";

const Repository = object({ owner: string(), repo: string() });
const Hook = object({ id: number(), config: object({ url: string() }) });
const Registration = object({ owner: string(), repo: string(), hookId: number() });
const Issue = object({ action: string(), issue: object({ number: number(), html_url: string() }) });
const repositoryPath = (config: { owner: string; repo: string }) =>
  `/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}/hooks`;

async function github(context: WebhookCtx, path: string, init: RequestInit = {}) {
  return context.fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${context.accounts.github.fields.access_token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    },
  });
}

// Lookup by the stable callback URL recovers a registration whose response was lost.
async function findHook(context: WebhookCtx, path: string, callbackUrl: string) {
  for (let page = 1; ; page++) {
    const hooks = await decodeJson(
      await github(context, `${path}?per_page=100&page=${page}`),
      array(Hook),
    );
    const match = hooks.find((hook) => hook.config.url === callbackUrl);
    if (match !== undefined || hooks.length < 100) return match;
  }
}

/** Register with GitHub; read Gmail on verified delivery using the subscription's saved account IDs. */
export const issueOpened = {
  account: "github",
  config: Repository,
  state: Registration,
  register: async (context, { config, callbackUrl, secret }) => {
    const path = repositoryPath(config);
    const existing = await findHook(context, path, callbackUrl);
    const hook = await decodeJson(
      await github(context, existing === undefined ? path : `${path}/${existing.id}`, {
        method: existing === undefined ? "POST" : "PATCH",
        body: JSON.stringify({
          name: "web",
          active: true,
          events: ["issues"],
          config: { url: callbackUrl, content_type: "json", secret },
        }),
      }),
      Hook,
    );
    return { ...config, hookId: hook.id };
  },
  handle: async (context, { request, secret, state }) => {
    const bytes = await request.arrayBuffer();
    const signature = request.headers.get("x-hub-signature-256");
    if (signature === null || !/^sha256=[a-f0-9]{64}$/.test(signature))
      return new Response(null, { status: 401 });
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const digest = Uint8Array.from(signature.slice(7).match(/../g) ?? [], (pair) =>
      Number.parseInt(pair, 16),
    );
    if (!(await crypto.subtle.verify("HMAC", key, digest, bytes)))
      return new Response(null, { status: 401 });
    if (request.headers.get("x-github-event") !== "issues")
      return new Response(null, { status: 204 });
    // Providers can challenge/ping before register has returned. Ordinary events wait for saved state.
    if (state === null) return new Response(null, { status: 503 });
    const event = await decodeJson(new Response(bytes), Issue);
    if (event.action === "opened") {
      const messages = await searchMail(context, { query: event.issue.html_url });
      console.info({ issue: event.issue.number, matchingMessages: messages.length });
    }
    return new Response(null, { status: 204 });
  },
  unregister: async (context, { config, state, callbackUrl }) => {
    const path = repositoryPath(config);
    const hookId = state === null ? (await findHook(context, path, callbackUrl))?.id : state.hookId;
    if (hookId === undefined) return;
    const response = await github(context, `${path}/${hookId}`, { method: "DELETE" });
    if (response.status !== 204 && response.status !== 404)
      throw new ResponseStatusError({ status: response.status });
  },
} satisfies Webhook<WebhookCtx, typeof Repository, typeof Registration>;
