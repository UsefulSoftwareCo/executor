import { expect, test } from "@effect/vitest";

import { invalidOriginHelp, originOf, rewriteInvalidOrigin } from "./invalid-origin-help";

const req = (headers: Record<string, string>) =>
  new Request("https://svc.internal/api/auth/sign-up/email", { method: "POST", headers });

test("originOf prefers Origin, then x-forwarded-host, then host", () => {
  expect(originOf(req({ origin: "https://app.example.com" }))).toBe("https://app.example.com");
  expect(
    originOf(req({ "x-forwarded-host": "app.example.com", "x-forwarded-proto": "https" })),
  ).toBe("https://app.example.com");
  expect(originOf(req({ host: "app.example.com" }))).toBe("https://app.example.com");
});

test("the help message names the URL to set", () => {
  const msg = invalidOriginHelp("https://app.example.com", "http://localhost:4788");
  expect(msg).toContain("EXECUTOR_WEB_BASE_URL");
  expect(msg).toContain("https://app.example.com");
  expect(msg).toContain("http://localhost:4788");
});

test("rewriteInvalidOrigin replaces a 403 'Invalid origin' with the setup message, keeping the code", async () => {
  const original = new Response(
    JSON.stringify({ code: "INVALID_ORIGIN", message: "Invalid origin" }),
    {
      status: 403,
      headers: { "content-type": "application/json" },
    },
  );
  const rewritten = await rewriteInvalidOrigin(
    req({ origin: "https://app.example.com" }),
    original,
    "http://localhost:4788",
  );
  expect(rewritten).not.toBeNull();
  expect(rewritten!.status).toBe(403);
  const body = (await rewritten!.json()) as { code: string; message: string };
  expect(body.code).toBe("INVALID_ORIGIN");
  expect(body.message).toContain("EXECUTOR_WEB_BASE_URL");
  expect(body.message).toContain("https://app.example.com");
});

test("rewriteInvalidOrigin passes other responses through untouched", async () => {
  expect(await rewriteInvalidOrigin(req({}), new Response("ok", { status: 200 }), "x")).toBeNull();
  const otherErr = new Response(JSON.stringify({ message: "An invite code is required" }), {
    status: 403,
  });
  expect(await rewriteInvalidOrigin(req({}), otherErr, "x")).toBeNull();
});
