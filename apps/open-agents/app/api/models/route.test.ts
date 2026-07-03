import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const requestedUrls: string[] = [];

let modelsDevApiData: unknown = {};
let currentSession: {
  authProvider?: "vercel" | "github";
  user: { id: string; email?: string; username?: string; avatar?: string };
} | null = null;

const originalFetch = globalThis.fetch;

function getRequestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
}

mock.module("server-only", () => ({}));

mock.module("@/lib/session/get-server-session", () => ({
  getServerSession: async () => currentSession,
}));

const routeModulePromise = import("./route");

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("/api/models direct Anthropic catalog", () => {
  beforeEach(() => {
    requestedUrls.length = 0;
    modelsDevApiData = {};
    currentSession = null;

    globalThis.fetch = mock((input: RequestInfo | URL, _init?: RequestInit) => {
      requestedUrls.push(getRequestUrl(input));
      return Promise.resolve(
        new Response(JSON.stringify(modelsDevApiData), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }) as unknown as typeof fetch;
  });

  test("returns the direct Anthropic language models", async () => {
    const { GET } = await routeModulePromise;
    const response = await GET(new Request("http://localhost/api/models"));

    expect(response.ok).toBe(true);

    const body = (await response.json()) as {
      models: Array<{ id: string; modelType?: string }>;
    };

    expect(body.models.map((model) => model.id)).toEqual([
      "openai/gpt-4.1-mini",
      "anthropic/claude-opus-4.6",
      "anthropic/claude-sonnet-4.6",
      "anthropic/claude-haiku-4.5",
    ]);
    expect(body.models.every((model) => model.modelType === "language")).toBe(
      true,
    );
  });

  test("overrides direct catalog context windows from models.dev", async () => {
    modelsDevApiData = {
      anthropic: {
        models: {
          "claude-opus-4.6": {
            limit: { context: 1_000_000 },
          },
        },
      },
    };

    const { GET } = await routeModulePromise;
    const response = await GET(new Request("http://localhost/api/models"));

    expect(response.ok).toBe(true);

    const body = (await response.json()) as {
      models: Array<{ id: string; context_window?: number }>;
    };
    const contextById = new Map(
      body.models.map((model) => [model.id, model.context_window]),
    );

    expect(contextById.get("anthropic/claude-opus-4.6")).toBe(1_000_000);
    expect(contextById.get("anthropic/claude-sonnet-4.6")).toBe(200_000);
    expect(requestedUrls).toContain("https://models.dev/api.json");
  });

  test("hides Claude Opus models for managed trial users", async () => {
    currentSession = {
      authProvider: "vercel",
      user: { id: "user-1", email: "person@example.com" },
    };

    const { GET } = await routeModulePromise;
    const response = await GET(
      new Request("https://open-agents.dev/api/models"),
    );
    const body = (await response.json()) as {
      models: Array<{ id: string }>;
    };

    expect(body.models.map((model) => model.id)).toEqual([
      "openai/gpt-4.1-mini",
      "anthropic/claude-sonnet-4.6",
      "anthropic/claude-haiku-4.5",
    ]);
  });

  test("keeps direct catalog context window when models.dev only has related ids", async () => {
    modelsDevApiData = {
      anthropic: {
        models: {
          "claude-sonnet-4.5": {
            limit: { context: 1_000_000 },
          },
        },
      },
    };

    const { GET } = await routeModulePromise;
    const response = await GET(new Request("http://localhost/api/models"));

    expect(response.ok).toBe(true);

    const body = (await response.json()) as {
      models: Array<{ id: string; context_window?: number }>;
    };
    const sonnet = body.models.find(
      (model) => model.id === "anthropic/claude-sonnet-4.6",
    );

    expect(sonnet?.context_window).toBe(200_000);
  });

  test("keeps valid models.dev metadata when sibling fields are invalid", async () => {
    modelsDevApiData = {
      invalidProvider: "bad",
      anthropic: {
        models: {
          "claude-haiku-4.5": {
            limit: { context: "400_000" },
            cost: {
              input: 1.25,
              output: 10,
              context_over_200k: {
                input: 2.5,
              },
            },
          },
          broken: {
            limit: { context: "not-a-number" },
            cost: { input: "expensive" },
          },
        },
      },
    };

    const { GET } = await routeModulePromise;
    const response = await GET(new Request("http://localhost/api/models"));

    expect(response.ok).toBe(true);

    const body = (await response.json()) as {
      models: Array<{
        id: string;
        context_window?: number;
        cost?: {
          input?: number;
          output?: number;
          context_over_200k?: {
            input?: number;
          };
        };
      }>;
    };
    const haiku = body.models.find(
      (model) => model.id === "anthropic/claude-haiku-4.5",
    );

    expect(haiku).toMatchObject({
      id: "anthropic/claude-haiku-4.5",
      context_window: 200_000,
      cost: {
        input: 1.25,
        output: 10,
        context_over_200k: {
          input: 2.5,
        },
      },
    });
  });
});
