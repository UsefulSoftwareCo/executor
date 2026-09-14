import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import * as z from "zod/v4";
import type * as Cause from "effect/Cause";

import { SkillName, SkillNotFoundError, type Skill, type SkillSummary } from "@executor-js/sdk";
import type { ExecutionEngine } from "@executor-js/execution";

import { createExecutorMcpServer } from "./tool-server";
import {
  MCP_SKILLS_EXTENSION_ID,
  resolveWorkspaceSkill,
  type McpSkillsPort,
} from "./workspace-skills";

// Workspace skills on the MCP surface: the `skills` tool grows a workspace
// section and a `file` argument, and the server speaks the MCP Skills
// Extension (SEP-2640). Both read the same port, faked here as a static list.

const makeStubEngine = <E extends Cause.YieldableError = never>(): ExecutionEngine<E> => ({
  execute: () => Effect.succeed({ result: "default" }),
  executeWithPause: () => Effect.succeed({ status: "completed", result: { result: "default" } }),
  resume: () => Effect.succeed(null),
  getPausedExecution: () => Effect.succeed(null),
  pausedExecutionCount: () => Effect.succeed(0),
  hasPausedExecutions: () => Effect.succeed(false),
  getDescription: Effect.succeed("test executor"),
  shutdown: Effect.void,
});

const SKILL_MD = [
  "---",
  "name: pdf-processing",
  "description: Extract text from PDFs. Use when the user mentions PDFs.",
  "metadata:",
  '  version: "1.0"',
  "---",
  "",
  "# PDF processing",
  "",
  "Read `references/FORMS.md` before filling forms.",
].join("\n");

const skill = (owner: "org" | "user", name = "pdf-processing"): Skill => ({
  owner,
  name: SkillName.make(name),
  description: "Extract text from PDFs. Use when the user mentions PDFs.",
  frontmatter: {
    name,
    description: "Extract text from PDFs. Use when the user mentions PDFs.",
    metadata: { version: "1.0" },
  },
  files: [
    {
      path: "SKILL.md",
      content: SKILL_MD.replace("pdf-processing", name),
      size: 111,
      digest: `sha256:${"a".repeat(64)}`,
    },
    {
      path: "references/FORMS.md",
      content: "# Forms\n\nFill every field.",
      size: 26,
      digest: `sha256:${"b".repeat(64)}`,
    },
  ],
  createdAt: new Date(0),
  updatedAt: new Date(0),
});

const summaryOf = (s: Skill): SkillSummary => ({
  ...s,
  files: s.files.map(({ path, size, digest }) => ({ path, size, digest })),
});

const portOf = (skills: readonly Skill[]): McpSkillsPort => ({
  list: () => Effect.succeed(skills.map(summaryOf)),
  get: (ref) => {
    const found = skills.find((s) => s.owner === ref.owner && s.name === ref.name);
    return found
      ? Effect.succeed(found)
      : Effect.fail(new SkillNotFoundError({ owner: ref.owner, name: SkillName.make(ref.name) }));
  },
});

const withClient = async (
  skills: McpSkillsPort | undefined,
  fn: (client: Client) => Promise<void>,
) => {
  const mcpServer = await Effect.runPromise(
    createExecutorMcpServer({ engine: makeStubEngine(), ...(skills ? { skills } : {}) }),
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
  await mcpServer.connect(serverTransport);
  await client.connect(clientTransport);
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: test helper must close MCP transports after async client assertions
  try {
    await fn(client);
  } finally {
    await clientTransport.close();
    await serverTransport.close();
  }
};

const textOf = (result: Awaited<ReturnType<Client["callTool"]>>): string =>
  (result.content as Array<{ type: string; text: string }>)[0].text;

const SkillsListResult = z.object({
  skills: z.array(
    z.object({
      uri: z.string(),
      frontmatter: z.record(z.string(), z.unknown()),
      resources: z.array(z.object({ uri: z.string(), digest: z.string(), size: z.number() })),
    }),
  ),
});
const SkillsGetResult = z.object({ skill: SkillsListResult.shape.skills.element });

describe("resolveWorkspaceSkill", () => {
  const both = [summaryOf(skill("org")), summaryOf(skill("user"))];
  it("prefers the personal skill on a bare-name clash", () => {
    expect(resolveWorkspaceSkill("pdf-processing", both)?.owner).toBe("user");
  });
  it("honours an explicit owner", () => {
    expect(resolveWorkspaceSkill("org/pdf-processing", both)?.owner).toBe("org");
    expect(resolveWorkspaceSkill("user/nope", both)).toBeUndefined();
  });
});

describe("skills tool without a skills source", () => {
  it("keeps the docs-only description and input", async () => {
    await withClient(undefined, async (client) => {
      const { tools } = await client.listTools();
      const tool = tools.find((t) => t.name === "skills");
      expect(tool?.description).toContain("Not a general skill reader");
      expect(Object.keys(tool?.inputSchema.properties ?? {})).toEqual(["name"]);
      expect(client.getServerCapabilities()?.extensions).toBeUndefined();
    });
  });
});

describe("skills tool with workspace skills", () => {
  it("advertises the catalog in the description", async () => {
    await withClient(portOf([skill("org")]), async (client) => {
      const { tools } = await client.listTools();
      const tool = tools.find((t) => t.name === "skills");
      expect(tool?.description).toContain("`pdf-processing` (workspace)");
      expect(tool?.description).toContain("Use when the user mentions PDFs");
      expect(Object.keys(tool?.inputSchema.properties ?? {}).sort()).toEqual(["file", "name"]);
    });
  });

  it("lists built-in docs and workspace skills in the index", async () => {
    await withClient(portOf([skill("user")]), async (client) => {
      const text = textOf(await client.callTool({ name: "skills", arguments: {} }));
      expect(text).toContain("`execute`");
      expect(text).toContain("`pdf-processing` (personal)");
    });
  });

  it("returns the body with frontmatter stripped and lists bundled files", async () => {
    await withClient(portOf([skill("org")]), async (client) => {
      const result = await client.callTool({
        name: "skills",
        arguments: { name: "pdf-processing" },
      });
      const text = textOf(result);
      expect(result.isError).toBeFalsy();
      expect(text).toContain('<skill_content name="pdf-processing" owner="org">');
      expect(text).toContain("# PDF processing");
      expect(text).not.toContain("description: Extract text");
      expect(text).toContain("<file>references/FORMS.md</file>");
      expect(text).not.toContain("Fill every field");
      expect(result.structuredContent).toBeUndefined();
    });
  });

  it("reads a bundled file by path and reports a missing one", async () => {
    await withClient(portOf([skill("org")]), async (client) => {
      const hit = await client.callTool({
        name: "skills",
        arguments: { name: "org/pdf-processing", file: "references/FORMS.md" },
      });
      expect(textOf(hit)).toBe("# Forms\n\nFill every field.");
      const miss = await client.callTool({
        name: "skills",
        arguments: { name: "pdf-processing", file: "references/NOPE.md" },
      });
      expect(miss.isError).toBe(true);
      expect(textOf(miss)).toContain("- `references/FORMS.md`");
    });
  });

  it("still serves the built-in docs and refuses `file` on them", async () => {
    await withClient(portOf([skill("org")]), async (client) => {
      const doc = await client.callTool({ name: "skills", arguments: { name: "execute" } });
      expect(textOf(doc)).toContain("## Workflow");
      const bad = await client.callTool({
        name: "skills",
        arguments: { name: "execute", file: "x.md" },
      });
      expect(bad.isError).toBe(true);
    });
  });

  it("names both sections on a miss", async () => {
    await withClient(portOf([skill("org")]), async (client) => {
      const result = await client.callTool({ name: "skills", arguments: { name: "nope" } });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('No skill named "nope"');
      expect(textOf(result)).toContain("`execute`");
      expect(textOf(result)).toContain("`pdf-processing`");
    });
  });
});

describe("MCP Skills Extension", () => {
  it("declares the extension and answers skills/list with digest manifests", async () => {
    await withClient(portOf([skill("org"), skill("user", "release-notes")]), async (client) => {
      expect(client.getServerCapabilities()?.extensions).toEqual({
        [MCP_SKILLS_EXTENSION_ID]: {},
      });
      const result = await client.request({ method: "skills/list", params: {} }, SkillsListResult);
      expect(result.skills.map((s) => s.uri)).toEqual([
        "skill://org/pdf-processing/SKILL.md",
        "skill://user/release-notes/SKILL.md",
      ]);
      const [first] = result.skills;
      expect(first?.frontmatter).toEqual({
        name: "pdf-processing",
        description: "Extract text from PDFs. Use when the user mentions PDFs.",
        metadata: { version: "1.0" },
      });
      expect(first?.resources).toEqual([
        {
          uri: "skill://org/pdf-processing/SKILL.md",
          digest: `sha256:${"a".repeat(64)}`,
          size: 111,
        },
        {
          uri: "skill://org/pdf-processing/references/FORMS.md",
          digest: `sha256:${"b".repeat(64)}`,
          size: 26,
        },
      ]);
    });
  });

  it("answers skills/get by SKILL.md URI and -32602 for anything else", async () => {
    await withClient(portOf([skill("org")]), async (client) => {
      const result = await client.request(
        { method: "skills/get", params: { uri: "skill://org/pdf-processing/SKILL.md" } },
        SkillsGetResult,
      );
      expect(result.skill.uri).toBe("skill://org/pdf-processing/SKILL.md");
      await expect(
        client.request(
          { method: "skills/get", params: { uri: "skill://user/pdf-processing/SKILL.md" } },
          SkillsGetResult,
        ),
      ).rejects.toMatchObject({ code: -32602 });
      await expect(
        client.request(
          {
            method: "skills/get",
            params: { uri: "skill://org/pdf-processing/references/FORMS.md" },
          },
          SkillsGetResult,
        ),
      ).rejects.toMatchObject({ code: -32602 });
    });
  });

  it("serves every file as a skill:// resource and lists one entry per skill", async () => {
    await withClient(portOf([skill("org")]), async (client) => {
      const listed = await client.listResources();
      expect(listed.resources.map((r) => r.uri)).toEqual(["skill://org/pdf-processing/SKILL.md"]);
      expect(listed.resources[0]?.mimeType).toBe("text/markdown");

      const read = await client.readResource({
        uri: "skill://org/pdf-processing/references/FORMS.md",
      });
      expect(read.contents[0]).toMatchObject({
        uri: "skill://org/pdf-processing/references/FORMS.md",
        mimeType: "text/markdown",
        text: "# Forms\n\nFill every field.",
      });
      await expect(
        client.readResource({ uri: "skill://org/pdf-processing/missing.md" }),
      ).rejects.toMatchObject({ code: -32602 });
    });
  });
});
