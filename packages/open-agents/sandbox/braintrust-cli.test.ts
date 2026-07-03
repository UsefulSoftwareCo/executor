import { describe, expect, test } from "bun:test";
import type { ExecResult, Sandbox } from "./interface";
import { installBraintrustCli, readBraintrustCliCredentials } from "./braintrust-cli";

function result(params: Partial<ExecResult> = {}): ExecResult {
  return {
    success: true,
    exitCode: 0,
    stdout: "",
    stderr: "",
    truncated: false,
    ...params,
  };
}

type RecordedSandbox = Sandbox & {
  readonly commands: string[];
  readonly directories: string[];
  readonly files: Map<string, string>;
};

function createSandbox(homeDirectory = "/home/vercel-sandbox"): RecordedSandbox {
  const commands: string[] = [];
  const directories: string[] = [];
  const files = new Map<string, string>();

  return {
    type: "cloud",
    workingDirectory: "/workspace",
    exec: async (command) => {
      commands.push(command);
      return command === 'printf %s "$HOME"' ? result({ stdout: homeDirectory }) : result();
    },
    readFile: async (path) => files.get(path) ?? "",
    writeFile: async (path, content) => {
      files.set(path, content);
    },
    readFileBuffer: async () => Buffer.from(""),
    access: async () => {},
    stat: async () => ({
      isDirectory: () => false,
      isFile: () => true,
      size: 0,
      mtimeMs: 0,
    }),
    mkdir: async (path) => {
      directories.push(path);
    },
    readdir: async () => [],
    exists: async () => true,
    stop: async () => {},
    commands,
    directories,
    files,
  } as RecordedSandbox;
}

describe("readBraintrustCliCredentials", () => {
  test("reads configured JSON credentials from the production secret", () => {
    const credentials = readBraintrustCliCredentials({
      OPEN_AGENTS_BRAINTRUST_CLI_SECRET: JSON.stringify({
        apiKey: "braintrust-key",
        apiUrl: "https://api.braintrust.dev",
        appUrl: "https://www.braintrust.dev",
        org: "Augment",
        project: "Augment-Prod",
      }),
    });

    expect(credentials).toEqual({
      apiKey: "braintrust-key",
      apiUrl: "https://api.braintrust.dev",
      appUrl: "https://www.braintrust.dev",
      org: "Augment",
      project: "Augment-Prod",
    });
  });
});

describe("installBraintrustCli", () => {
  test("installs Braintrust env, global wrapper, local wrapper, and permissions", async () => {
    const sandbox = createSandbox();

    await installBraintrustCli(sandbox, {
      apiKey: "braintrust-key",
      apiUrl: "https://api.braintrust.dev",
      appUrl: "https://www.braintrust.dev",
      org: "Augment",
      project: "Augment-Prod",
    });

    expect(sandbox.directories).toEqual([
      "/home/vercel-sandbox/.open-agents",
      "/home/vercel-sandbox/.local/bin",
    ]);
    expect(sandbox.files.get("/home/vercel-sandbox/.open-agents/braintrust.env")).toBe(
      [
        "BRAINTRUST_API_KEY='braintrust-key'",
        "BRAINTRUST_API_URL='https://api.braintrust.dev'",
        "BRAINTRUST_APP_URL='https://www.braintrust.dev'",
        "BRAINTRUST_ORG_NAME='Augment'",
        "BRAINTRUST_DEFAULT_PROJECT='Augment-Prod'",
        "",
      ].join("\n"),
    );

    const wrapper = sandbox.files.get("/usr/local/bin/bt");
    expect(wrapper).toContain("https://bt.dev/cli/install.sh");
    expect(wrapper).toContain('. "$ENV_FILE"');
    expect(sandbox.files.get("/home/vercel-sandbox/.local/bin/bt")).toBe(wrapper);
    expect(sandbox.commands).toEqual([
      'printf %s "$HOME"',
      "chmod 700 '/home/vercel-sandbox/.open-agents' && chmod 600 '/home/vercel-sandbox/.open-agents/braintrust.env' && chmod 755 '/usr/local/bin/bt' '/home/vercel-sandbox/.local/bin/bt'",
    ]);
  });
});
