import type { APIRoute } from "astro";
import { Effect } from "effect";
import { createExecutor, makeTestConfig, type Tool } from "@executor-js/sdk";
import { openApiHttpPlugin } from "@executor-js/plugin-openapi/api";
import { graphqlHttpPlugin } from "@executor-js/plugin-graphql/api";

export const prerender = false;

function inferMethod(toolName: string, pluginKey: string): string {
  if (pluginKey === "graphql") {
    return toolName.startsWith("mutation.") ? "mutation" : "query";
  }
  if (pluginKey === "mcp") return "tool";

  // OpenAPI / Google Discovery: infer from tool name
  const lower = toolName.toLowerCase();
  if (/\.delete|\.remove|\.destroy/.test(lower)) return "DELETE";
  if (/\.create|\.insert|\.add|\.send|\.post/.test(lower)) return "POST";
  if (/\.update|\.patch/.test(lower)) return "PATCH";
  if (/\.put|\.merge|\.replace/.test(lower)) return "PUT";
  return "GET";
}

function inferPolicy(method: string, toolName: string): "read" | "write" | "destructive" {
  const m = method.toUpperCase();
  if (m === "DELETE") return "destructive";
  const lower = toolName.toLowerCase();
  if (/delete|remove|destroy|drop|purge/.test(lower)) return "destructive";
  if (m === "GET" || m === "HEAD" || m === "QUERY") return "read";
  if (/list|get|query|check|read|search|find|fetch/.test(lower)) return "read";
  return "write";
}

function formatTools(tools: readonly Tool[]) {
  return tools.map((t) => {
    const method = inferMethod(t.name, t.pluginId);
    return {
      name: t.name,
      desc: t.description?.slice(0, 80) || t.name,
      method,
      policy: inferPolicy(method, t.name),
    };
  });
}

export const POST: APIRoute = async ({ request }) => {
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: Astro route converts request/parsing failures to a stable HTTP response
  try {
    const body = (await request.json()) as { url?: string };
    const url = body.url?.trim();
    if (!url) {
      return new Response(JSON.stringify({ error: "URL is required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: URL constructor is the platform validator for request input
    try {
      new URL(url);
    } catch {
      return new Response(JSON.stringify({ error: "Invalid URL" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const program = Effect.gen(function* () {
      const config = makeTestConfig({
        plugins: [openApiHttpPlugin(), graphqlHttpPlugin(), googleDiscoveryHttpPlugin()],
      });
      const executor = yield* createExecutor(config);

      // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: ensure executor cleanup runs after best-effort marketing detection
      try {
        // Detect what kind of source lives at this URL
        const detected = yield* executor.sources.detect(url).pipe(Effect.timeout("10 seconds"));

        if (!detected || detected.length === 0) return null;

        const match = detected[0];

        // Add source to register its tools (Google Discovery needs auth so skip)
        if (match.kind === "openapi") {
          yield* executor.openapi.addSpec({
            spec: match.endpoint,
            namespace: match.namespace,
            scope: "test-scope",
          });
        } else if (match.kind === "graphql") {
          yield* executor.graphql.addSource({
            endpoint: match.endpoint,
            namespace: match.namespace,
            scope: "test-scope",
          });
        } else {
          // For kinds we can't fully add (e.g. Google Discovery needs auth),
          // return just the detection metadata
          return {
            kind: match.kind,
            name: match.name,
            count: 0,
            tools: [],
          };
        }

        const tools = yield* executor.tools.list({
          sourceId: match.namespace,
        });
        const mapped = formatTools(tools);

        return {
          kind: match.kind,
          name: match.name,
          count: mapped.length,
          tools: mapped.slice(0, 50),
        };
      } finally {
        yield* executor.close();
      }
    });

    const result = await Effect.runPromise(
      program.pipe(
        Effect.catchCause(() => Effect.succeed(null)),
        Effect.timeout("25 seconds"),
        Effect.catchCause(() => Effect.succeed(null)),
      ),
    );

    if (!result) {
      return new Response(
        JSON.stringify({
          error:
            "Could not detect an API at this URL. Try an OpenAPI spec, GraphQL endpoint, or Google Discovery document.",
        }),
        { status: 404, headers: { "Content-Type": "application/json" } },
      );
    }

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch {
    return new Response(JSON.stringify({ error: "Detection failed" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
};
