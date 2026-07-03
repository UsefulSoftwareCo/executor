import { describe, it, expect } from "@effect/vitest";
import { Effect, Schema } from "effect";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import { FileSystem } from "effect";
import { join } from "node:path";

import { ExecutorFileConfig } from "./schema";
import { ConfigParseError, loadConfig } from "./load";
import {
  addSourceToConfig,
  removeSourceFromConfig,
  writeConfig,
  addSecretToConfig,
  removeSecretFromConfig,
} from "./write";

const decodeExecutorFileConfig = Schema.decodeUnknownSync(ExecutorFileConfig);

const withTmpDir = <A, E>(fn: (dir: string) => Effect.Effect<A, E, FileSystem.FileSystem>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped({
      prefix: "executor-config-test-",
    });
    return yield* fn(dir);
  }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer));

describe("ExecutorFileConfig schema", () => {
  it("decodes a minimal config", () => {
    const raw = { sources: [] };
    const result = decodeExecutorFileConfig(raw);
    expect(result.sources).toEqual([]);
  });

  it("decodes a full config with all source types", () => {
    const raw = {
      name: "test",
      sources: [
        {
          kind: "openapi",
          spec: "https://example.com/openapi.json",
          namespace: "example",
          headers: {
            Authorization: { value: "secret-public-ref:my-token", prefix: "Bearer " },
          },
        },
        {
          kind: "graphql",
          endpoint: "https://example.com/graphql",
          namespace: "gql",
        },
        {
          kind: "mcp",
          transport: "remote",
          name: "Remote MCP",
          endpoint: "https://mcp.example.com/sse",
        },
      ],
      secrets: {
        "my-token": {
          name: "My Token",
          provider: "keychain",
          purpose: "Auth",
        },
      },
    };

    const result = decodeExecutorFileConfig(raw);
    expect(result.sources).toHaveLength(3);
    expect(result.name).toBe("test");
    expect(result.secrets!["my-token"]!.name).toBe("My Token");
  });

  it("rejects invalid source kind", () => {
    const raw = {
      sources: [{ kind: "invalid", endpoint: "http://example.com" }],
    };
    expect(() => decodeExecutorFileConfig(raw)).toThrow();
  });
});

describe("loadConfig", () => {
  it.effect("returns null for missing file", () =>
    withTmpDir((dir) =>
      Effect.gen(function* () {
        const result = yield* loadConfig(join(dir, "nonexistent.jsonc"));
        expect(result).toBeNull();
      }),
    ),
  );

  it.effect("loads a valid JSONC file with comments", () =>
    withTmpDir((dir) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = join(dir, "executor.jsonc");
        yield* fs.writeFileString(
          path,
          `{
  // This is a comment
  "name": "test",
  "sources": [
    {
      "kind": "openapi",
      "spec": "https://example.com/spec.json"
    }
  ]
}`,
        );

        const result = yield* loadConfig(path);
        expect(result).not.toBeNull();
        expect(result!.name).toBe("test");
        expect(result!.sources).toHaveLength(1);
      }),
    ),
  );

  it.effect("fails on invalid JSON", () =>
    withTmpDir((dir) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = join(dir, "executor.jsonc");
        yield* fs.writeFileString(path, "{ invalid json }");

        const result = yield* loadConfig(path).pipe(
          Effect.catchTag("ConfigParseError", (error) => Effect.succeed(error)),
        );
        expect(result).toBeInstanceOf(ConfigParseError);
      }),
    ),
  );
});

describe("write operations", () => {
  it.effect("addSourceToConfig creates file and adds source", () =>
    withTmpDir((dir) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = join(dir, "executor.jsonc");

        yield* addSourceToConfig(path, {
          kind: "openapi",
          spec: "https://example.com/spec.json",
          namespace: "example",
        });

        const content = yield* fs.readFileString(path);
        expect(content).toContain("openapi");
        expect(content).toContain("example");

        const config = yield* loadConfig(path);
        expect(config!.sources).toHaveLength(1);
        expect(config!.sources![0]!.kind).toBe("openapi");
      }),
    ),
  );

  it.effect("addSourceToConfig appends to existing sources", () =>
    withTmpDir((dir) =>
      Effect.gen(function* () {
        const path = join(dir, "executor.jsonc");

        yield* addSourceToConfig(path, {
          kind: "openapi",
          spec: "https://example.com/spec.json",
          namespace: "first",
        });

        yield* addSourceToConfig(path, {
          kind: "graphql",
          endpoint: "https://example.com/graphql",
          namespace: "second",
        });

        const config = yield* loadConfig(path);
        expect(config!.sources).toHaveLength(2);
        expect(config!.sources![0]!.kind).toBe("openapi");
        expect(config!.sources![1]!.kind).toBe("graphql");
      }),
    ),
  );

  it.effect("addSourceToConfig preserves comments", () =>
    withTmpDir((dir) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = join(dir, "executor.jsonc");

        yield* fs.writeFileString(
          path,
          `{
  // My project config
  "name": "test",
  "sources": [
    {
      "kind": "openapi",
      "spec": "https://example.com/spec.json",
      "namespace": "first"
    }
  ]
}`,
        );

        yield* addSourceToConfig(path, {
          kind: "graphql",
          endpoint: "https://example.com/graphql",
          namespace: "second",
        });

        const content = yield* fs.readFileString(path);
        expect(content).toContain("// My project config");
        expect(content).toContain("graphql");
      }),
    ),
  );

  it.effect("addSourceToConfig replaces existing source with same namespace", () =>
    withTmpDir((dir) =>
      Effect.gen(function* () {
        const path = join(dir, "executor.jsonc");

        yield* addSourceToConfig(path, {
          kind: "openapi",
          spec: "https://example.com/v1.json",
          namespace: "example",
        });

        // Add again with same namespace but different spec
        yield* addSourceToConfig(path, {
          kind: "openapi",
          spec: "https://example.com/v2.json",
          namespace: "example",
        });

        const config = yield* loadConfig(path);
        // Should have 1, not 2
        expect(config!.sources).toHaveLength(1);
        expect((config!.sources![0] as { spec: string }).spec).toBe("https://example.com/v2.json");
      }),
    ),
  );

  it.effect("removeSourceFromConfig removes by namespace", () =>
    withTmpDir((dir) =>
      Effect.gen(function* () {
        const path = join(dir, "executor.jsonc");

        yield* writeConfig(path, {
          sources: [
            {
              kind: "openapi",
              spec: "https://example.com/spec.json",
              namespace: "keep",
            },
            {
              kind: "graphql",
              endpoint: "https://example.com/graphql",
              namespace: "remove-me",
            },
          ],
        });

        yield* removeSourceFromConfig(path, "remove-me");

        const config = yield* loadConfig(path);
        expect(config!.sources).toHaveLength(1);
        expect(config!.sources![0]!.kind).toBe("openapi");
      }),
    ),
  );

  it.effect("addSecretToConfig and removeSecretFromConfig", () =>
    withTmpDir((dir) =>
      Effect.gen(function* () {
        const path = join(dir, "executor.jsonc");

        yield* writeConfig(path, { sources: [] });

        yield* addSecretToConfig(path, "my-token", {
          name: "My Token",
          provider: "keychain",
        });

        let config = yield* loadConfig(path);
        expect(config!.secrets!["my-token"]!.name).toBe("My Token");

        yield* removeSecretFromConfig(path, "my-token");

        config = yield* loadConfig(path);
        expect(config!.secrets?.["my-token"]).toBeUndefined();
      }),
    ),
  );
});
