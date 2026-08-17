import { expect } from "@effect/vitest";
import { Effect } from "effect";

import { scenario } from "../src/scenario";
import { Mcp, Target } from "../src/services";
import {
  connectModernMcpClient,
  MODERN_MCP_PROTOCOL_VERSION,
  modernToolText,
} from "../src/surfaces/modern-mcp";
import type { Identity } from "../src/target";

const emailOf = (identity: Identity): string => identity.credentials?.email ?? identity.label;

scenario(
  "MCP modern protocol · self-host accepts a pinned 2026 client end to end",
  {},
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const mcp = yield* Mcp;
      const identity = yield* target.newIdentity();
      const bearer = yield* mcp.mintBearer(emailOf(identity));
      const client = yield* connectModernMcpClient({
        url: target.mcpUrl,
        bearer,
        mode: { pin: MODERN_MCP_PROTOCOL_VERSION },
      });

      expect(client.getProtocolEra(), "the self-host endpoint selects modern").toBe("modern");
      expect(client.getNegotiatedProtocolVersion(), "the pinned revision is exact").toBe(
        MODERN_MCP_PROTOCOL_VERSION,
      );
      expect(
        client.getDiscoverResult()?.supportedVersions,
        "self-host server/discover offers the pinned revision",
      ).toContain(MODERN_MCP_PROTOCOL_VERSION);

      const tools = yield* Effect.promise(() => client.listTools());
      expect(
        tools.tools.map((tool) => tool.name),
        "self-host advertises Executor's tools over modern MCP",
      ).toContain("execute");

      const result = yield* Effect.promise(() =>
        client.callTool({ name: "execute", arguments: { code: "return 20 + 22;" } }),
      );
      expect(result.isError, "the self-host modern call succeeds").not.toBe(true);
      expect(modernToolText(result), "the sandbox result crosses the modern wire").toBe("42");
    }),
  ),
);
