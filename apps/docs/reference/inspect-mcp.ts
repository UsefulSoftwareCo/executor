import { Effect } from "effect";
import { HttpEffect, HttpServer } from "effect/http";
import {
  defaultMcpLimits,
  ElicitationMode,
  makeMcp,
  type McpBackend,
} from "../../../packages/mcp/src/index.ts";

const unused = () => Effect.die("Reference generation only reads MCP metadata");
const backend: McpBackend<Error> = {
  listApps: () => Effect.succeed([]),
  listSkills: unused,
  bundleSkills: unused,
  readSkill: unused,
  authorizeElicitation: unused,
  listAccounts: unused,
  listTools: unused,
  searchableTools: unused,
  searchTools: unused,
  callTool: unused,
  findEventSubscription: unused,
  subscribeEvent: unused,
  unsubscribeEvent: unused,
  resumeInvocation: unused,
};

const stateless = "2026-07-28";
const clientInfo = { name: "reference", version: "1" };

const inspect = Effect.forEach(ElicitationMode.literals, (mode) =>
  Effect.gen(function* () {
    const server = yield* makeMcp({
      backend,
      browser: { url: unused },
      caller: Effect.succeed("reference"),
      mode: Effect.succeed(mode),
      instructions: "",
      limits: defaultMcpLimits,
      annotateSkillRead: () => Effect.void,
    });
    const handle = HttpEffect.toWebHandler(server.http);
    return yield* Effect.promise(async () => {
      const request = async (
        protocol: string,
        method: string,
        params: object = {},
        session?: string | null,
      ) => {
        const response = await handle(
          new Request("http://reference.invalid/mcp", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              accept: "application/json, text/event-stream",
              "mcp-protocol-version": protocol,
              ...(protocol === stateless ? { "mcp-method": method } : {}),
              ...(session ? { "mcp-session-id": session } : {}),
            },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method,
              params:
                protocol === stateless
                  ? {
                      ...params,
                      _meta: {
                        "io.modelcontextprotocol/protocolVersion": protocol,
                        "io.modelcontextprotocol/clientInfo": clientInfo,
                        "io.modelcontextprotocol/clientCapabilities": {},
                      },
                    }
                  : params,
            }),
          }),
        );
        const text = await response.text();
        const json = response.headers.get("content-type")?.startsWith("text/event-stream")
          ? text
              .split("\n")
              .find((line) => line.startsWith("data: "))
              ?.slice(6)
          : text;
        if (json === undefined) throw new Error(`No MCP response to ${method}`);
        return { payload: JSON.parse(json), session: response.headers.get("mcp-session-id") };
      };

      const discovery = (await request(stateless, "server/discover")).payload;
      const protocols: string[] =
        discovery.result?.supportedVersions ?? discovery.error?.data?.supported;
      if (!Array.isArray(protocols) || protocols.length === 0)
        throw new Error(`MCP did not advertise supported versions: ${JSON.stringify(discovery)}`);

      const profiles = [];
      for (const protocol of protocols) {
        const initialized =
          protocol === stateless
            ? { payload: discovery, session: null }
            : await request(protocol, "initialize", {
                protocolVersion: protocol,
                capabilities: {},
                clientInfo,
              });
        const identity = initialized.payload.result;
        const tools = (await request(protocol, "tools/list", {}, initialized.session)).payload
          .result?.tools;
        if (!identity?.capabilities || !Array.isArray(tools) || tools.length === 0)
          throw new Error(`Cannot inspect the ${mode} MCP server for ${protocol}`);
        profiles.push({ protocol, capabilities: identity.capabilities, tools });
      }
      return { mode, profiles };
    });
  }),
);

const result = await Effect.runPromise(
  inspect.pipe(Effect.provide(HttpServer.layerServices), Effect.scoped),
);
console.log(JSON.stringify(result));
