// Cloud-only: MCP browser approval URLs must preserve the session's org scope.
//
// The MCP session is created in org A, then the browser cookie is moved to org B
// before the human opens the approval link. The returned approval URL itself
// must carry org A's slug so the rendered approval page scopes both GET and
// resume POST requests to org A, not the cookie-pinned org B.
import { randomBytes } from "node:crypto";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import type { Page, Request } from "playwright";
import { composePluginApi } from "@executor-js/api/server";

import { scenario } from "../src/scenario";
import { Api, Browser, Mcp, Target } from "../src/services";
import { type McpBrowserApproval, parseBrowserApproval } from "../src/surfaces/mcp";

const coreApi = composePluginApi([] as const);

const GATE_TOOL = "executor.coreTools.policies.list";

const GATED_CODE = `
const result = await tools.executor.coreTools.policies.list({});
return JSON.stringify(result);
`;

const cookiePair = (response: Response, name: string): string | undefined => {
  for (const header of response.headers.getSetCookie?.() ?? []) {
    if (header.startsWith(`${name}=`)) return header.split(";")[0];
  }
  return undefined;
};

const cookieValue = (pair: string): string => {
  const [, value] = pair.split(/=(.*)/s);
  if (!value) throw new Error("cookie pair has no value");
  return value;
};

const cookieOf = (identity: { readonly headers?: Record<string, string> }): string =>
  identity.headers?.cookie ?? "";

const originHeaders = (baseUrl: string) => ({ origin: new URL(baseUrl).origin });

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const setWorkosSessionCookie = async (page: Page, baseUrl: string, cookie: string) => {
  await page.context().addCookies([
    {
      name: "wos-session",
      value: cookieValue(cookie),
      url: baseUrl,
    },
  ]);
};

const expectOrgShell = async (
  page: Page,
  org: { readonly name: string; readonly slug: string },
) => {
  await page.waitForURL(
    (url) => url.pathname === `/${org.slug}` || url.pathname === `/${org.slug}/`,
    {
      timeout: 30_000,
    },
  );
  await page.getByRole("button", { name: new RegExp(escapeRegExp(org.name)) }).waitFor();
  await page.getByRole("heading", { name: "Integrations" }).waitFor();
};

const activeOrg = (baseUrl: string, cookie: string) =>
  Effect.promise(async () => {
    const response = await fetch(new URL("/api/auth/me", baseUrl), {
      headers: { cookie },
    });
    if (!response.ok) throw new Error(`/api/auth/me failed (${response.status})`);
    const body = (await response.json()) as {
      organization: { id: string; name: string; slug: string } | null;
    };
    if (!body.organization) throw new Error("identity has no active organization");
    return body.organization;
  });

const createOrganization = (baseUrl: string, cookie: string, name: string) =>
  Effect.promise(async () => {
    const response = await fetch(new URL("/api/auth/create-organization", baseUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie,
        ...originHeaders(baseUrl),
      },
      body: JSON.stringify({ name }),
    });
    if (!response.ok) {
      throw new Error(`/api/auth/create-organization failed (${response.status})`);
    }
    const session = cookiePair(response, "wos-session");
    if (!session) throw new Error("create organization did not refresh the session");
    const org = (await response.json()) as { id: string; name: string; slug: string };
    return { org, session };
  });

const approvalApiRequest =
  (approval: McpBrowserApproval, method: "GET" | "POST") =>
  (request: Request): boolean => {
    const url = request.url();
    const executionPath = `/executions/${encodeURIComponent(approval.executionId)}`;
    return (
      request.method() === method &&
      url.includes("/api/mcp-sessions/") &&
      url.includes(executionPath) &&
      (method === "POST" ? url.endsWith(`${executionPath}/resume`) : !url.endsWith("/resume"))
    );
  };

scenario(
  "MCP approval · URL-scoped org survives approval while the session cookie points elsewhere",
  {
    timeout: 180_000,
    // `mcpSession.listTools()` drives mcporter's OWN generic MCP-session OAuth
    // login (its consentStrategy hook against the WorkOS emulator's
    // /oauth2/authorize), unrelated to the org-scoped-approval-URL behavior
    // this scenario actually tests. That handshake hangs and mcporter's own
    // code-wait times out after 60s ("OAuth authorization required ...
    // Waiting for browser approval..." -> McpError -32001), before any of
    // this scenario's assertions run. Same root cause as
    // scenarios/browser-approval.test.ts's cloud-only skip. Real
    // harness/product defect (suspect: cloud's mcporter<->WorkOS-emulator
    // OAuth session flow), needs a live-debugged fix, tracked separately.
    skip: "cloud's mcporter MCP-session OAuth login (listTools' consentStrategy handshake against the WorkOS emulator) hangs and times out after 60s, before this scenario's org-scope assertions ever run — suspect: cloud mcporter<->WorkOS-emulator OAuth session flow",
  },
  Effect.gen(function* () {
    const target = yield* Target;
    const api = yield* Api;
    const browser = yield* Browser;
    const mcp = yield* Mcp;

    const identity = yield* target.newIdentity();
    const sessionA = cookieOf(identity);
    const orgA = yield* activeOrg(target.baseUrl, sessionA);
    const client = yield* api.client(coreApi, identity);

    const policy = yield* client.policies.create({
      payload: { owner: "org", pattern: GATE_TOOL, action: "require_approval" },
    });

    yield* Effect.gen(function* () {
      const mcpSession = mcp.session(identity, { elicitationMode: "browser" });
      yield* mcpSession.listTools();

      const paused = yield* mcpSession.call("execute", { code: GATED_CODE });
      const approval = parseBrowserApproval(paused);
      const approvalUrl = new URL(approval.approvalUrl);
      expect(approvalUrl.pathname, "the real MCP approval URL is pinned to the session org").toBe(
        `/${orgA.slug}/resume/${approval.executionId}`,
      );

      const { org: orgB, session: sessionB } = yield* createOrganization(
        target.baseUrl,
        sessionA,
        `MCP Approval Org B ${randomBytes(3).toString("hex")}`,
      );
      expect(orgB.slug, "the browser can be pinned to a different org").not.toBe(orgA.slug);

      const [resumed] = yield* Effect.all(
        [
          mcpSession.awaitResume(approval.executionId),
          browser.session(identity, async ({ page, step }) => {
            await step("Land in the original organization", async () => {
              await page.goto(`/${orgA.slug}`, { waitUntil: "networkidle" });
              await expectOrgShell(page, orgA);
            });

            await step("The browser session is switched to another organization", async () => {
              await setWorkosSessionCookie(page, target.baseUrl, sessionB);
              await page.goto(`/${orgB.slug}`, { waitUntil: "networkidle" });
              await expectOrgShell(page, orgB);
            });

            await step("Open the original organization's approval URL and approve", async () => {
              const loadRequest = page.waitForRequest(approvalApiRequest(approval, "GET"), {
                timeout: 30_000,
              });
              await page.goto(approval.approvalUrl, { waitUntil: "networkidle" });
              expect(
                (await loadRequest).headers()["x-executor-organization"],
                "loading the approval page scopes the paused execution lookup to org A",
              ).toBe(orgA.slug);

              await page.getByRole("button", { name: "Approve" }).waitFor();
              const resumeRequest = page.waitForRequest(approvalApiRequest(approval, "POST"), {
                timeout: 30_000,
              });
              await page.getByRole("button", { name: "Approve" }).click();
              expect(
                (await resumeRequest).headers()["x-executor-organization"],
                "approving the paused execution scopes the resume POST to org A",
              ).toBe(orgA.slug);
              await page.getByText("Approve sent").waitFor();
            });
          }),
        ],
        { concurrency: "unbounded" },
      );

      expect(resumed.ok, "the approved execution completed without error").toBe(true);
      expect(resumed.text, "the gated tool ran in org A and returned its policy").toContain(
        policy.id,
      );
    }).pipe(
      Effect.ensuring(
        client.policies
          .remove({ params: { policyId: policy.id }, payload: { owner: "org" } })
          .pipe(Effect.ignore),
      ),
    );
  }),
);
