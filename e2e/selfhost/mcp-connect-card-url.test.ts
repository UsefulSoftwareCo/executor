// Selfhost (browser): the MCP URL the "Connect an agent" card actually shows a
// user must be a URL this deployment serves. Every other MCP scenario builds
// `${baseUrl}/mcp` itself and connects to that — so none of them notice when the
// card hands out a DIFFERENT path. This one reads the URL straight out of the
// rendered card and checks the server actually serves it.
//
// Regression pin: the self-host connect card appends `/<organizationId>/mcp`
// (a cloud-only convention — the cloud worker routes the org segment, the
// self-host server only serves `/mcp`), so the printed URL 404s. A connecting
// client OAuths successfully and then fails to reconnect with HTTP 404. This
// asserts the card's own URL answers as an MCP endpoint (401 challenge), not
// 404.
import { expect } from "@effect/vitest";
import { Effect } from "effect";

import { scenario } from "../src/scenario";
import { Browser, Target } from "../src/services";

scenario(
  "MCP · the URL printed by the Connect card is actually served",
  { timeout: 180_000 },
  Effect.gen(function* () {
    const target = yield* Target;
    const browser = yield* Browser;
    const identity = yield* target.newIdentity();

    // Pull the MCP endpoint out of the card exactly as a user would copy it.
    let cardUrl = "";
    yield* browser.session(identity, async ({ page, step }) => {
      await step("Read the MCP URL from the Connect-an-agent card", async () => {
        await page.goto("/", { waitUntil: "networkidle" });
        await page.waitForTimeout(2000); // let the card resolve the server origin
        // The card renders `npx add-mcp <url> --transport http --name executor`.
        // The CodeBlock tokenizes it across spans; read the concatenated text.
        const text = await page.locator("body").innerText();
        const match = text.match(/(https?:\/\/[^\s'"]+\/mcp)\b/);
        expect(
          match,
          `the card should show an MCP http URL — page text was:\n${text.slice(0, 600)}`,
        ).not.toBeNull();
        cardUrl = match![1]!;
      });
    });

    // Connect to THAT url like a client would: an MCP initialize POST. A served
    // endpoint answers 401 (OAuth challenge) when unauthenticated; a wrong path
    // answers 404 — which is the bug.
    const status = yield* Effect.promise(() =>
      fetch(cardUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "connect-card-probe", version: "0" },
          },
        }),
      }).then((r) => r.status),
    );

    expect(status, `the Connect-card URL ${cardUrl} is served as an MCP endpoint, not a 404`).toBe(
      401,
    );
  }),
);
