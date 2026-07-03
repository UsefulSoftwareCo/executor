import { describe, expect, test } from "bun:test";
import type { ExecResult, Sandbox } from "./interface";
import { installSnowflakeCli, readSnowflakeCliCredentials } from "./snowflake-cli";

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

describe("readSnowflakeCliCredentials", () => {
  test("reads configured JSON credentials from the production secret", () => {
    const credentials = readSnowflakeCliCredentials({
      OPEN_AGENTS_SNOWFLAKE_CLI_SECRET: JSON.stringify({
        account: "example-account",
        private_key: "private-key",
        role: "ANALYST",
        user: "SVC_AGENT",
        warehouse: "REPORTING_WH",
        database: "ANALYTICS",
        schema: "PUBLIC",
      }),
    });

    expect(credentials).toEqual({
      account: "example-account",
      private_key: "private-key",
      role: "ANALYST",
      user: "SVC_AGENT",
      warehouse: "REPORTING_WH",
      database: "ANALYTICS",
      schema: "PUBLIC",
    });
  });
});

describe("installSnowflakeCli", () => {
  test("installs Snowflake config, private key, wrapper, and permissions", async () => {
    const sandbox = createSandbox();

    await installSnowflakeCli(sandbox, {
      account: "example-account",
      private_key: "-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----\n",
      role: "ANALYST",
      user: "SVC_AGENT",
      warehouse: "REPORTING_WH",
      database: "ANALYTICS",
      schema: "PUBLIC",
    });

    expect(sandbox.directories).toEqual(["/home/vercel-sandbox/.snowflake"]);
    expect(sandbox.files.get("/home/vercel-sandbox/.snowflake/openagents_key.p8")).toBe(
      "-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----\n",
    );
    expect(sandbox.files.get("/home/vercel-sandbox/.snowflake/config.toml")).toBe(
      [
        "[connections.openagents]",
        'account = "example-account"',
        'user = "SVC_AGENT"',
        'authenticator = "SNOWFLAKE_JWT"',
        'private_key_file = "/home/vercel-sandbox/.snowflake/openagents_key.p8"',
        'role = "ANALYST"',
        'warehouse = "REPORTING_WH"',
        'database = "ANALYTICS"',
        'schema = "PUBLIC"',
        "",
      ].join("\n"),
    );

    const wrapper = sandbox.files.get("/usr/local/bin/snow");
    expect(wrapper).toContain("uvx_bin");
    expect(wrapper).toContain("--from snowflake-cli snow --config-file");
    expect(sandbox.commands).toEqual([
      'printf %s "$HOME"',
      "chmod 700 '/home/vercel-sandbox/.snowflake' && chmod 600 '/home/vercel-sandbox/.snowflake/openagents_key.p8' '/home/vercel-sandbox/.snowflake/config.toml' && chmod 755 '/usr/local/bin/snow'",
    ]);
  });
});
