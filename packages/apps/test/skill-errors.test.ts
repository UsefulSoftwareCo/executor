/** Skill loader failures keep their message and safe cause across the host boundary. */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createAppHandler, hostContext } from "../src/host.ts";
import { defineApp } from "../src/index.ts";
import { githubSkills, SkillLoadFailed, skillReader } from "../src/skills.ts";

const original = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = original;
});

const hostError = async (
  factory: (ctx: { fetch: typeof fetch; signal: AbortSignal }) => Promise<unknown>,
  respond: () => Response,
  operation: "skills" | "inspect" = "skills",
) => {
  globalThis.fetch = (async () => respond()) as typeof fetch;
  const app = defineApp({ accounts: {} }, async (ctx) => ({
    skills: (await factory(ctx)) as never,
  }));
  const response = await createAppHandler(app)(
    new Request("https://test", { method: "POST", body: JSON.stringify({ operation }) }),
    hostContext({}),
  );
  const { error } = await response.json();
  assert.equal(response.status, error._tag === "SkillLoadFailed" ? 502 : 500);
  return error;
};

const github = (ctx: { fetch: typeof fetch; signal: AbortSignal }) =>
  githubSkills({ repo: "example/skills", path: "skills", fetch: ctx.fetch, signal: ctx.signal });

test("a GitHub rate limit names GitHub for skills and tool inspection", async () => {
  for (const operation of ["skills", "inspect"] as const) {
    const error = await hostError(
      github,
      () =>
        new Response('{"message":"API rate limit exceeded"}', {
          status: 403,
          headers: { "x-ratelimit-remaining": "0" },
        }),
      operation,
    );
    assert.deepEqual(error, {
      _tag: "SkillLoadFailed",
      reason: "rate_limited",
      message: "GitHub is rate limiting skill requests (HTTP 403).",
      status: 403,
    });
  }
});

test("rejected and unreachable GitHub requests keep no response content", async () => {
  assert.deepEqual(await hostError(github, () => new Response("private body", { status: 500 })), {
    _tag: "SkillLoadFailed",
    reason: "request",
    message: "GitHub returned HTTP 500 while loading skills.",
    status: 500,
  });
  assert.deepEqual(
    await hostError(github, () => {
      throw new TypeError("fetch failed for https://token@example.com");
    }),
    {
      _tag: "SkillLoadFailed",
      reason: "request",
      message: "Could not reach GitHub to load skills.",
    },
  );
});

test("a custom loader built on skillReader names its own service", async () => {
  const gitlabSkills = async (ctx: { fetch: typeof fetch; signal: AbortSignal }) => {
    const remote = skillReader({ service: "GitLab", fetch: ctx.fetch, signal: ctx.signal });
    return remote.json("https://gitlab.example/api/v4/projects/1/repository/tree");
  };
  assert.deepEqual(await hostError(gitlabSkills, () => new Response("{}", { status: 429 })), {
    _tag: "SkillLoadFailed",
    reason: "rate_limited",
    message: "GitLab is rate limiting skill requests (HTTP 429).",
    status: 429,
  });
});

test("a thrown SkillLoadFailed message reaches the host unchanged", async () => {
  const error = await hostError(
    async () => {
      throw new SkillLoadFailed({
        reason: "source",
        message: "The GitLab project example/skills does not exist.",
      });
    },
    () => new Response("{}"),
  );
  assert.deepEqual(error, {
    _tag: "SkillLoadFailed",
    reason: "source",
    message: "The GitLab project example/skills does not exist.",
  });
});

test("other thrown errors never expose their message", async () => {
  const error = await hostError(
    async () => {
      throw new Error("secret token abc123");
    },
    () => new Response("{}"),
  );
  assert.deepEqual(error, { _tag: "HostEvaluationFailed" });
});
