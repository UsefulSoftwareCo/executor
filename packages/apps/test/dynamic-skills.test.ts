/** Dynamic skills load only for skill reads and join the static catalog. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createAppHandler, hostContext } from "../src/host.ts";
import { defineApp, dynamicSkills, object, query } from "../src/index.ts";
import { SkillLoadFailed } from "../src/skills.ts";

const skill = (name: string) => ({
  name,
  description: `The ${name} skill.`,
  files: [
    {
      path: "SKILL.md",
      content: `---\nname: ${name}\ndescription: The ${name} skill.\n---\nUse ${name}.`,
    },
  ],
});
const read = query({ input: object({}), output: object({}) }, async () => ({}));

const run = async (
  app: unknown,
  operation: "skills" | "inspect",
  files?: readonly { path: string; content: string }[],
) => {
  const response = await createAppHandler(app)(
    new Request("https://test", { method: "POST", body: JSON.stringify({ operation }) }),
    { ...hostContext({}), ...(files === undefined ? {} : { files }) },
  );
  return { status: response.status, body: await response.json() };
};
const names = (body: { value: readonly { name: string }[] }) => body.value.map((item) => item.name);

test("inspect never lists dynamic skills; a skills read does", async () => {
  let calls = 0;
  const app = defineApp({ accounts: {} }, async () => ({
    queries: { read },
    dynamicSkills: dynamicSkills({
      list: async () => {
        calls += 1;
        return [skill("remote")];
      },
    }),
  }));
  assert.equal((await run(app, "inspect")).status, 200);
  assert.equal(calls, 0);
  const skills = await run(app, "skills");
  assert.equal(skills.status, 200);
  assert.equal(calls, 1);
  assert.deepEqual(names(skills.body), ["remote"]);
});

test("dynamic skills join an explicit static catalog", async () => {
  const app = defineApp({ accounts: {} }, async () => ({
    skills: [skill("bundled")],
    dynamicSkills: dynamicSkills({ list: () => [skill("remote")] }),
  }));
  assert.deepEqual(names((await run(app, "skills")).body), ["bundled", "remote"]);
});

test("dynamic skills join packaged skill folders when skills is omitted", async () => {
  const app = defineApp({ accounts: {} }, async () => ({
    dynamicSkills: dynamicSkills({ list: () => [skill("remote")] }),
  }));
  const packaged = skill("packaged").files.map((file) => ({
    path: `skills/packaged/${file.path}`,
    content: file.content,
  }));
  assert.deepEqual(names((await run(app, "skills", packaged)).body), ["packaged", "remote"]);
});

test("a name in both catalogs fails the skill read", async () => {
  const app = defineApp({ accounts: {} }, async () => ({
    skills: [skill("triage")],
    dynamicSkills: dynamicSkills({ list: () => [skill("triage")] }),
  }));
  const result = await run(app, "skills");
  assert.equal(result.status, 500);
  assert.deepEqual(result.body.error, { _tag: "HostDeclarationInvalid" });
});

test("a dynamic skill failure fails only the skills read", async () => {
  const app = defineApp({ accounts: {} }, async () => ({
    queries: { read },
    dynamicSkills: dynamicSkills({
      list: () => {
        throw new SkillLoadFailed({
          reason: "rate_limited",
          message: "GitHub is rate limiting skill requests (HTTP 403).",
          status: 403,
        });
      },
    }),
  }));
  const skills = await run(app, "skills");
  assert.equal(skills.status, 502);
  assert.deepEqual(skills.body.error, {
    _tag: "SkillLoadFailed",
    reason: "rate_limited",
    message: "GitHub is rate limiting skill requests (HTTP 403).",
    status: 403,
  });
  const inspected = await run(app, "inspect");
  assert.equal(inspected.status, 200);
  assert.equal(inspected.body.ok, true);
});

test("other dynamic skill errors never expose their message", async () => {
  const app = defineApp({ accounts: {} }, async () => ({
    dynamicSkills: dynamicSkills({
      list: async () => {
        throw new Error("secret token abc123");
      },
    }),
  }));
  assert.deepEqual((await run(app, "skills")).body.error, { _tag: "HostEvaluationFailed" });
});
