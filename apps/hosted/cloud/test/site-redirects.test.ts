import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect } from "effect";
import { siteRedirects } from "../src/implementation/site-redirects.ts";

test("fixed pages do not consume the dynamic redirect budget", async () => {
  const fixed = Array.from({ length: 150 }, (_, index) => `/page-${index} /page-${index}.html 200`);
  const output = await Effect.runPromise(siteRedirects(["/org/* /dashboard.html 200", ...fixed]));
  const lines = output.trim().split("\n");
  assert.equal(lines.length, 151);
  assert.equal(lines.at(-1), "/org/* /dashboard.html 200");
  assert.ok(lines.slice(0, -1).every((line) => line.startsWith("/page-")));
});

test("an oversized combined redirect file fails the build", async () => {
  const rules = Array.from({ length: 101 }, (_, index) => `/page-${index}/* /dashboard.html 200`);
  const failure = await Effect.runPromise(Effect.flip(siteRedirects(rules)));
  assert.equal(failure.kind, "dynamic");
  assert.equal(failure.count, 101);
  assert.equal(failure.limit, 100);
});
