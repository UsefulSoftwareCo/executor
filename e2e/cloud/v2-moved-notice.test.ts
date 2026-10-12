// Cloud-only: the notice for an organization Executor v2 has already
// imported. v2 records the move on the v1 WorkOS organization's metadata
// (`executor_v2_org_slug`, `executor_v2_moved_at`); each scenario writes those
// keys through the WorkOS emulator's real Update Organization route, reads the
// real `/api/auth/v2-import` answer, and checks the dashboard in the browser.
//
// The notice's analytics events are not asserted here: the e2e stack mounts no
// PostHog client, so `trackEvent` is a no-op. Their names and properties are
// fixed by the typed catalog in `packages/react/src/api/analytics.tsx`.
import { expect } from "@effect/vitest";
import { Duration, Effect } from "effect";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Locator, Page } from "playwright";

import { scenario } from "../src/scenario";
import { Browser, Mcp, Target } from "../src/services";
import { revisit, settle, visit } from "../src/surfaces/browser";
import type { Identity, Target as TargetShape } from "../src/target";
import { WORKOS_EMULATOR_PORT } from "../targets/cloud";
import { configuredMcpSessionTimeoutMs } from "../setup/mcp-session-timeouts";
import { E2E_MCP_V2_MOVED_RECHECK_MS } from "../setup/v2-moved-recheck";
import { verifyAdmin } from "./support/admin-mfa";
import { cookieOf } from "./support/session";

const V2_IMPORT_API = "/api/auth/v2-import";
const V2_SLUG = "moved-example";
// Noon UTC, so the badge reads the same calendar day in any browser timezone
// between UTC-11 and UTC+11.
const MOVED_AT = "2026-10-09T12:00:00.000Z";
const MOVED_BADGE = "Moved Oct 9, 2026";
// v2's MCP path on the v2 MCP origin v1 is configured with. OAuth clients only
// accept `/mcp` (v2's protected resource); they choose the org when signing in.
const V2_MCP_PATH = "/mcp";
const CHOOSE_ORG_HINT = `Choose ${V2_SLUG} when you sign in.`;

interface V2ImportAnswer {
  readonly url: string | null;
  readonly moved: {
    readonly v2Url: string;
    readonly v2Slug: string;
    readonly movedAt: string;
    readonly v2McpUrl?: string;
  } | null;
}

const v2ImportOf = (target: TargetShape, identity: Identity): Effect.Effect<V2ImportAnswer> =>
  Effect.promise(async () => {
    const response = await fetch(new URL(V2_IMPORT_API, target.baseUrl), {
      headers: identity.headers,
    });
    if (!response.ok) throw new Error(`${V2_IMPORT_API} failed (${response.status})`);
    return (await response.json()) as V2ImportAnswer;
  });

/** The identity's active org, with the name the dashboard shows. */
const orgOf = (
  target: TargetShape,
  identity: Identity,
): Effect.Effect<{ readonly id: string; readonly slug: string; readonly name: string }> =>
  Effect.promise(async () => {
    const response = await fetch(new URL("/api/auth/me", target.baseUrl), {
      headers: { cookie: cookieOf(identity) },
    });
    if (!response.ok) throw new Error(`/api/auth/me failed (${response.status})`);
    const body = (await response.json()) as {
      organization: { id: string; slug: string; name: string } | null;
    };
    if (!body.organization) throw new Error("identity has no active organization");
    return body.organization;
  });

/** Write WorkOS organization metadata the way v2 does: Update Organization. */
const setOrgMetadata = (
  organizationId: string,
  metadata: Record<string, string>,
): Effect.Effect<void> =>
  Effect.promise(async () => {
    const response = await fetch(
      `http://127.0.0.1:${WORKOS_EMULATOR_PORT}/organizations/${organizationId}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json", authorization: "Bearer sk_test_emulate" },
        body: JSON.stringify({ metadata }),
      },
    );
    if (!response.ok) throw new Error(`WorkOS update organization failed (${response.status})`);
    await response.body?.cancel();
  });

const markMoved = (organizationId: string, slug: string = V2_SLUG) =>
  setOrgMetadata(organizationId, {
    executor_v2_org_slug: slug,
    executor_v2_moved_at: MOVED_AT,
  });

/** Rename the identity's active org through the product's own settings route. */
const renameOrg = (target: TargetShape, identity: Identity, name: string): Effect.Effect<void> =>
  Effect.promise(async () => {
    const response = await fetch(new URL("/api/account/name", target.baseUrl), {
      method: "PATCH",
      headers: {
        ...identity.headers,
        origin: new URL(target.baseUrl).origin,
        "content-type": "application/json",
      },
      body: JSON.stringify({ name }),
    });
    if (!response.ok) throw new Error(`/api/account/name failed (${response.status})`);
    await response.body?.cancel();
  });

const noticeOf = (page: Page) => page.getByRole("dialog");

/** The answer's v2 MCP URL, checked to be v2's OAuth MCP server. */
const v2McpUrlOf = (target: TargetShape, answer: V2ImportAnswer): string => {
  const raw = answer.moved?.v2McpUrl;
  expect(raw, "the move answer carries the org's v2 MCP URL").toEqual(expect.any(String));
  const url = new URL(raw!);
  expect(url.href, "v2's OAuth MCP resource, not an org-pinned path").toBe(
    `${url.origin}${V2_MCP_PATH}`,
  );
  expect(url.origin, "v2's MCP host, not v1's").not.toBe(new URL(target.baseUrl).origin);
  expect(url.origin, "v2's MCP host, not v2's app host").not.toBe(
    new URL(answer.moved!.v2Url).origin,
  );
  return raw!;
};

const emailOf = (identity: Identity): string => identity.credentials?.email ?? identity.label;

/** A real MCP client, connected (the `initialize` handshake done) for the
 *  scope, closed after. */
const connectedClient = (mcpUrl: string, bearer: string) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const client = new Client({ name: "executor-e2e-v2-moved", version: "0.0.1" });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(mcpUrl), {
          requestInit: { headers: { authorization: `Bearer ${bearer}` } },
        }),
      );
      return client;
    }),
    (client) => Effect.promise(() => client.close().catch(() => undefined)),
  );

/** A real MCP client's handshake: the server's `initialize` instructions. */
const initializeInstructions = (mcpUrl: string, bearer: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const client = yield* connectedClient(mcpUrl, bearer);
      return yield* Effect.promise(async () => ({
        instructions: client.getInstructions(),
        tools: (await client.listTools()).tools.map((tool) => tool.name),
      }));
    }),
  );

/** The HTTP status a request on the client's session answers, or 200. */
const listToolsStatus = (client: Client): Effect.Effect<number> =>
  Effect.promise(() =>
    client.listTools().then(
      () => 200,
      (error: unknown) => {
        if (error instanceof StreamableHTTPError && error.code !== undefined) return error.code;
        throw error;
      },
    ),
  );

const movedInstructions = (v2McpUrl: string, slug: string = V2_SLUG) =>
  "This organization moved to Executor v2 on October 9, 2026. " +
  `Its MCP server is now ${v2McpUrl}; ask the user to reconnect their agent there ` +
  `and choose the ${slug} organization when signing in. ` +
  "Changes made through this server won't reach v2.";

/** Where an element's text is drawn, which overflows the element's own box
 *  when the text cannot wrap. */
const textExtent = (locator: Locator) =>
  locator.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const box = range.getBoundingClientRect();
    return { left: box.left, right: box.right };
  });

const boxOf = async (locator: Locator, label: string) => {
  const box = await locator.boundingBox();
  if (box === null) throw new Error(`${label} has no layout box`);
  return { left: box.x, right: box.x + box.width };
};

/** Open the dashboard and wait for the v2 answer it renders the notice from. */
const openDashboard = async (page: Page, slug: string) => {
  const answered = page.waitForResponse((response) => response.url().endsWith(V2_IMPORT_API));
  await visit(page, `/${slug}`);
  await answered;
  await settle(page);
};

scenario(
  "v2 moved · a moved org's dashboard says where it lives in v2, and ✕ hides it",
  { timeout: 180_000 },
  Effect.gen(function* () {
    const target = yield* Target;
    const browser = yield* Browser;
    const identity = yield* target.newIdentity();
    const org = yield* orgOf(target, identity);

    yield* markMoved(org.id);

    const answer = yield* v2ImportOf(target, identity);
    expect(answer.url, "a moved org is not offered the import again").toBeNull();
    expect(answer.moved, "the move v2 recorded is answered").not.toBeNull();
    const v2Url = new URL(answer.moved!.v2Url);
    expect(v2Url.pathname, "the link opens the org's page in v2").toBe(`/org/${V2_SLUG}`);
    expect(v2Url.origin, "the org's page is on v2's host, not v1's").not.toBe(
      new URL(target.baseUrl).origin,
    );
    expect(answer.moved!.movedAt).toBe(MOVED_AT);
    const v2McpUrl = v2McpUrlOf(target, answer);

    yield* browser.session(identity, async ({ page, step }) => {
      await step("Open the moved org's dashboard", async () => {
        await openDashboard(page, org.slug);
      });

      await step("See the notice with the org's v1 and v2 homes", async () => {
        const notice = noticeOf(page);
        await notice.waitFor();
        await notice
          .getByRole("heading", { name: `${org.name} now lives in Executor v2`, exact: true })
          .waitFor();
        expect(await notice.getByText(MOVED_BADGE).count(), "the move date badge").toBe(1);
        const pair = await notice.getByTestId("v2-moved-pair").textContent();
        expect(pair).toContain(`v1 · ${org.name}`);
        expect(pair).toContain(`v2 · ${V2_SLUG}`);
        expect(await notice.getByText("Changes made here won't sync to v2.").count()).toBe(1);

        const mcp = notice.getByRole("region", { name: "v2 MCP server URL" });
        expect(
          await mcp
            .getByText(
              `Connect your agents to v2 instead, and choose ${V2_SLUG} when you sign in:`,
              { exact: true },
            )
            .count(),
          "the notice names the org to choose at sign-in",
        ).toBe(1);
        expect(
          await mcp.getByTestId("mcp-server-url").textContent(),
          "the notice shows the org's v2 MCP URL",
        ).toBe(v2McpUrl);
        expect(await mcp.getByRole("button", { name: "Copy" }).count(), "with a copy button").toBe(
          1,
        );

        const open = notice.getByRole("link", { name: "Open in v2", exact: true });
        expect(await open.getAttribute("href"), "the button opens the org in v2").toBe(
          answer.moved!.v2Url,
        );
        expect(await open.getAttribute("target"), "it opens in a new tab").toBe("_blank");
        expect(await notice.getByRole("button", { name: "Keep using v1" }).count()).toBe(1);
      });

      await step("Close it with ✕", async () => {
        await noticeOf(page).getByRole("button", { name: "Close" }).click();
        await noticeOf(page).waitFor({ state: "hidden" });
      });

      await step("See the Connect card lead with the v2 MCP server", async () => {
        expect(
          await page
            .getByText("This organization moved to Executor v2. Connect your agents there instead:")
            .count(),
        ).toBe(1);
        const next = page.getByRole("region", { name: "New MCP server" });
        expect(await next.getByTestId("mcp-server-url").textContent()).toBe(v2McpUrl);
        expect(await next.textContent(), "the install command targets v2").toContain(
          `npx add-mcp ${v2McpUrl} --transport http --name executor`,
        );
        expect(
          await next.getByText(CHOOSE_ORG_HINT, { exact: true }).count(),
          "it names the org to choose at sign-in",
        ).toBe(1);
        const old = page.getByRole("region", { name: "Old MCP server URL" });
        expect(await old.getByText("Old v1 URL").count()).toBe(1);
        expect(
          await old.getByTestId("mcp-server-url").textContent(),
          "v1's URL stays, labelled as the old one",
        ).toBe(`${new URL(target.baseUrl).origin}/${org.slug}/mcp`);
        expect(await old.getByText("Won't receive changes made in Executor v2.").count()).toBe(1);
      });

      await step(
        'See "Open in Executor v2" in the sidebar instead of the import link',
        async () => {
          const link = page.getByRole("link", { name: "Open in Executor v2" });
          expect(await link.getAttribute("href")).toBe(answer.moved!.v2Url);
          expect(await link.getAttribute("target")).toBe("_blank");
          expect(await page.getByRole("link", { name: "Move to Executor v2" }).count()).toBe(0);
        },
      );

      await step("Reload and see the notice stays hidden", async () => {
        const answered = page.waitForResponse((response) => response.url().endsWith(V2_IMPORT_API));
        await revisit(page);
        await answered;
        await settle(page);
        await page.getByRole("link", { name: "Open in Executor v2" }).waitFor();
        expect(await noticeOf(page).count(), "✕ snoozes the notice in this browser").toBe(0);
      });

      await step("Open the MCP setup page and see it lead with the v2 MCP server", async () => {
        await visit(page, "/setup-mcp");
        const next = page.getByRole("region", { name: "New MCP server" });
        await next.waitFor();
        expect(
          await page
            .getByText("This organization moved to Executor v2. Connect your agents there instead:")
            .count(),
        ).toBe(1);
        expect(await next.getByTestId("mcp-server-url").textContent()).toBe(v2McpUrl);
        expect(await next.textContent(), "the install command targets v2").toContain(
          `npx add-mcp ${v2McpUrl} --transport http --name executor`,
        );
        expect(
          await next.getByText(CHOOSE_ORG_HINT, { exact: true }).count(),
          "it names the org to choose at sign-in",
        ).toBe(1);
        const old = page.getByRole("region", { name: "Old MCP server URL" });
        expect(await old.getByText("Old v1 URL").count()).toBe(1);
        // The page reads its own origin after hydration, then shows v1's URL.
        await old
          .getByTestId("mcp-server-url")
          .getByText(`${new URL(target.baseUrl).origin}/${org.slug}/mcp`, { exact: true })
          .waitFor();
        expect(
          await page.getByRole("region", { name: "MCP server URL", exact: true }).count(),
          "v1's URL is not offered as the one to use",
        ).toBe(0);
      });
    });
  }),
);

scenario(
  "v2 moved · keeping v1 asks why, and sending the answer hides the notice",
  { timeout: 180_000 },
  Effect.gen(function* () {
    const target = yield* Target;
    const browser = yield* Browser;
    const identity = yield* target.newIdentity();
    const org = yield* orgOf(target, identity);
    yield* markMoved(org.id);

    yield* browser.session(identity, async ({ page, step }) => {
      const notice = noticeOf(page);
      const send = notice.getByRole("button", { name: "Send and stay in v1" });
      const answerField = notice.getByRole("textbox");

      await step("Open the moved org's dashboard", async () => {
        await openDashboard(page, org.slug);
        await notice.waitFor();
      });

      await step('Click "Keep using v1" and see the feedback step', async () => {
        await notice.getByRole("button", { name: "Keep using v1" }).click();
        await notice.getByRole("heading", { name: "What went wrong?" }).waitFor();
        expect(
          await notice.getByText("Tell us why you're staying on v1, so we can fix it.").count(),
        ).toBe(1);
        expect(await notice.getByRole("radio").count(), "free text only, no options").toBe(0);
        expect(await send.isDisabled(), "nothing to send yet").toBe(true);
      });

      await step("Type only spaces and see Send stays disabled", async () => {
        await answerField.fill("   ");
        expect(await send.isDisabled(), "a blank answer is not an answer").toBe(true);
      });

      await step("Go back, then return to the feedback step", async () => {
        await notice.getByRole("button", { name: "Back" }).click();
        await notice.getByRole("button", { name: "Keep using v1" }).waitFor();
        await notice.getByRole("button", { name: "Keep using v1" }).click();
        await notice.getByRole("heading", { name: "What went wrong?" }).waitFor();
      });

      await step("Write why and send it", async () => {
        await answerField.fill("Synthetic feedback: a feature I use is not in v2 yet.");
        expect(await send.isDisabled(), "a written answer can be sent").toBe(false);
        await send.click();
        await notice.waitFor({ state: "hidden" });
      });

      await step("Reload and see the notice stays hidden", async () => {
        const answered = page.waitForResponse((response) => response.url().endsWith(V2_IMPORT_API));
        await revisit(page);
        await answered;
        await settle(page);
        await page.getByRole("link", { name: "Open in Executor v2" }).waitFor();
        expect(await noticeOf(page).count(), "sending the answer snoozes the notice").toBe(0);
      });
    });
  }),
);

scenario(
  "v2 moved · malformed move metadata shows no notice and keeps the import link",
  { timeout: 180_000 },
  Effect.gen(function* () {
    const target = yield* Target;
    const browser = yield* Browser;
    const identity = yield* target.newIdentity();
    const org = yield* orgOf(target, identity);

    yield* setOrgMetadata(org.id, {
      executor_v2_org_slug: "Not A Slug",
      executor_v2_moved_at: "yesterday",
    });

    const answer = yield* v2ImportOf(target, identity);
    expect(answer.moved, "malformed metadata is not a move").toBeNull();
    expect(answer.url, "the sole member of a free org is still offered the import").not.toBeNull();

    yield* browser.session(identity, async ({ page, step }) => {
      await step("Open the dashboard", async () => {
        await openDashboard(page, org.slug);
      });
      await step("See the import link and no notice", async () => {
        await page.getByRole("link", { name: "Move to Executor v2" }).waitFor();
        expect(await noticeOf(page).count()).toBe(0);
        expect(
          await page.getByRole("region", { name: "New MCP server" }).count(),
          "the Connect card points nowhere else",
        ).toBe(0);
      });
    });
  }),
);

scenario(
  "v2 moved · a long organization name stays inside the notice",
  { timeout: 180_000 },
  Effect.gen(function* () {
    const target = yield* Target;
    const browser = yield* Browser;
    const identity = yield* target.newIdentity();
    const longName = "Synthetic Extraordinarily Long Organization Name For Layout Checks";
    // Renaming is an organization setting, which needs a verified admin session; the browser
    // below uses the plain session.
    yield* renameOrg(target, yield* verifyAdmin(target.baseUrl, identity), longName);
    const org = yield* orgOf(target, identity);
    expect(org.name, "the rename reached the dashboard's org").toBe(longName);
    yield* markMoved(org.id);

    yield* browser.session(identity, async ({ page, step }) => {
      await step("Open the moved org's dashboard", async () => {
        await openDashboard(page, org.slug);
        await noticeOf(page)
          .getByRole("heading", { name: `${longName} now lives in Executor v2` })
          .waitFor();
      });

      await step("See the pair, the v2 MCP URL and both buttons inside the notice", async () => {
        const notice = noticeOf(page);
        const box = await notice.boundingBox();
        if (box === null) throw new Error("the notice has no layout box");
        const right = box.x + box.width;
        for (const [label, part] of [
          ["the v1 → v2 pair", notice.getByTestId("v2-moved-pair")],
          ["the v2 MCP URL", notice.getByRole("region", { name: "v2 MCP server URL" })],
          ["Keep using v1", notice.getByRole("button", { name: "Keep using v1" })],
          ["Open in v2", notice.getByRole("link", { name: "Open in v2", exact: true })],
        ] as const) {
          const partBox = await part.boundingBox();
          if (partBox === null) throw new Error(`${label} has no layout box`);
          expect(partBox.x, `${label} starts inside the notice`).toBeGreaterThanOrEqual(box.x);
          expect(partBox.x + partBox.width, `${label} ends inside the notice`).toBeLessThanOrEqual(
            right,
          );
        }
      });
    });
  }),
);

scenario(
  "v2 moved · a moved org's MCP sessions tell the agent where to reconnect",
  { timeout: 180_000 },
  Effect.gen(function* () {
    const target = yield* Target;
    const mcp = yield* Mcp;
    const identity = yield* target.newIdentity();
    const org = yield* orgOf(target, identity);
    const bearer = yield* mcp.mintBearer(emailOf(identity));

    const before = yield* initializeInstructions(target.mcpUrl, bearer);
    expect(before.instructions, "an org that has not moved gets no notice").toBeUndefined();

    yield* markMoved(org.id);
    const v2McpUrl = v2McpUrlOf(target, yield* v2ImportOf(target, identity));

    const after = yield* initializeInstructions(target.mcpUrl, bearer);
    expect(after.instructions, "the initialize result names the org's v2 MCP server").toBe(
      movedInstructions(v2McpUrl),
    );
    expect(after.tools, "the tools are unchanged").toEqual(before.tools);
  }),
);

/**
 * An agent connected before the move got `initialize` instructions without the
 * notice, and instructions only travel in `initialize`. Its session ends (HTTP
 * 404, which tells a Streamable HTTP client to start a new session), and the
 * new session's `initialize` carries the notice. `wait` is how long the agent
 * stays quiet after the move.
 */
const connectedBeforeTheMove = (wait: Duration.Input) =>
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const mcp = yield* Mcp;
      const identity = yield* target.newIdentity();
      const org = yield* orgOf(target, identity);
      const bearer = yield* mcp.mintBearer(emailOf(identity));

      const early = yield* connectedClient(target.mcpUrl, bearer);
      expect(early.getInstructions(), "an org that has not moved gets no notice").toBeUndefined();
      expect(yield* listToolsStatus(early), "the session works before the move").toBe(200);

      yield* markMoved(org.id);
      const v2McpUrl = v2McpUrlOf(target, yield* v2ImportOf(target, identity));
      yield* Effect.sleep(wait);

      expect(
        yield* listToolsStatus(early),
        "the next request ends the session, so the client starts a new one",
      ).toBe(404);

      const again = yield* connectedClient(target.mcpUrl, bearer);
      expect(again.getInstructions(), "the new session's initialize carries the notice").toBe(
        movedInstructions(v2McpUrl),
      );
      // Past the re-read window, a session that already got the notice keeps
      // working: the client is not sent round again.
      yield* Effect.sleep(Duration.millis(E2E_MCP_V2_MOVED_RECHECK_MS * 2));
      expect(yield* listToolsStatus(again), "the new session keeps working").toBe(200);
      expect(yield* listToolsStatus(again), "and keeps working").toBe(200);
    }),
  );

scenario(
  "v2 moved · an agent connected before the move is told on its next request",
  { timeout: 180_000 },
  // Longer than the re-read window and shorter than the idle timeout, so the
  // session's runtime is still in memory and re-reads the move.
  connectedBeforeTheMove(Duration.millis(E2E_MCP_V2_MOVED_RECHECK_MS * 1.5)),
);

scenario(
  "v2 moved · an agent connected before the move is told after its session is restored",
  { timeout: 180_000 },
  // Past the idle timeout, with room for the alarm: the session's runtime is
  // released, and the next request restores it without an `initialize`.
  connectedBeforeTheMove(Duration.millis(configuredMcpSessionTimeoutMs() + 4_000)),
);

// v2's slug rule allows 45 characters with no hyphen, which is one word the
// browser cannot break by default.
const UNBROKEN_SLUG = "syntheticorgslugwithnohyphensforlayoutchecks0";

scenario(
  "v2 moved · the longest unbroken v2 slug stays inside the notice and the Connect card on a phone",
  { timeout: 180_000 },
  Effect.gen(function* () {
    expect(UNBROKEN_SLUG, "the longest slug v2 allows").toHaveLength(45);
    const target = yield* Target;
    const browser = yield* Browser;
    const identity = yield* target.newIdentity();
    const org = yield* orgOf(target, identity);
    yield* markMoved(org.id, UNBROKEN_SLUG);

    yield* browser.session(identity, async ({ page, step }) => {
      // The narrowest common phone width.
      await page.setViewportSize({ width: 320, height: 640 });

      await step("Open the moved org's dashboard on a phone-sized screen", async () => {
        await openDashboard(page, org.slug);
        await noticeOf(page).waitFor();
      });

      await step("See the org to choose at sign-in wrap inside the notice", async () => {
        const notice = noticeOf(page);
        const hint = notice
          .getByRole("region", { name: "v2 MCP server URL" })
          .getByText(
            `Connect your agents to v2 instead, and choose ${UNBROKEN_SLUG} when you sign in:`,
            { exact: true },
          );
        const dialog = await boxOf(notice, "the notice");
        const text = await textExtent(hint);
        expect(text.left, "the sentence starts inside the notice").toBeGreaterThanOrEqual(
          dialog.left,
        );
        expect(text.right, "the sentence ends inside the notice").toBeLessThanOrEqual(dialog.right);
      });

      await step("Close the notice and see the hint wrap inside the Connect card", async () => {
        await noticeOf(page).getByRole("button", { name: "Close" }).click();
        await noticeOf(page).waitFor({ state: "hidden" });
        const next = page.getByRole("region", { name: "New MCP server" });
        const card = page.locator('[data-slot="card-stack"]').filter({ has: next });
        const hint = next.getByText(`Choose ${UNBROKEN_SLUG} when you sign in.`, { exact: true });
        await hint.scrollIntoViewIfNeeded();
        const cardBox = await boxOf(card, "the Connect card");
        const text = await textExtent(hint);
        expect(text.left, "the hint starts inside the card").toBeGreaterThanOrEqual(cardBox.left);
        expect(text.right, "the hint ends inside the card").toBeLessThanOrEqual(cardBox.right);
      });
    });
  }),
);
