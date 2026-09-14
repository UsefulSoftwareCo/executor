import { describe, expect, it } from "@effect/vitest";

import { ENDPOINT_ENV_VAR, resolvePiExecutorConfig } from "./config";

const resolve = (env: Record<string, string | undefined>) => resolvePiExecutorConfig(env);

describe("resolvePiExecutorConfig", () => {
  it("reports a missing endpoint instead of throwing, so startup survives it", () => {
    const resolved = resolve({});
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.reason, "the reason names the variable to set").toContain(ENDPOINT_ENV_VAR);
  });

  it("treats a blank endpoint as unset", () => {
    expect(resolve({ [ENDPOINT_ENV_VAR]: "   " }).ok).toBe(false);
  });

  it("rejects an endpoint that is not a URL", () => {
    const resolved = resolve({ [ENDPOINT_ENV_VAR]: "127.0.0.1:4788/mcp" });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.reason).toContain("not a valid URL");
  });

  it("pins elicitation_mode=model, because the resume schema depends on it", () => {
    const resolved = resolve({ [ENDPOINT_ENV_VAR]: "https://executor.example/acme/mcp" });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.config.endpoint).toBe(
      "https://executor.example/acme/mcp?elicitation_mode=model",
    );
  });

  it("replaces a browser elicitation mode rather than trusting the pasted URL", () => {
    const resolved = resolve({
      [ENDPOINT_ENV_VAR]: "https://executor.example/mcp?elicitation_mode=browser&artifacts=false",
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    const url = new URL(resolved.config.endpoint);
    expect(url.searchParams.get("elicitation_mode"), "browser mode is overridden").toBe("model");
    expect(url.searchParams.get("artifacts"), "unrelated options survive").toBe("false");
  });

  it("prefers a hosted API key over a local server token, like the CLI does", () => {
    const resolved = resolve({
      [ENDPOINT_ENV_VAR]: "https://executor.example/mcp",
      EXECUTOR_API_KEY: "key_123",
      EXECUTOR_AUTH_TOKEN: "token_456",
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.config.authorization).toBe("Bearer key_123");
    expect(resolved.config.tokenSource, "and the source is kept, for the rejection hint").toBe(
      "EXECUTOR_API_KEY",
    );
  });

  it("falls back to the local server token", () => {
    const resolved = resolve({
      [ENDPOINT_ENV_VAR]: "https://executor.example/mcp",
      EXECUTOR_AUTH_TOKEN: "token_456",
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.config.authorization).toBe("Bearer token_456");
    expect(resolved.config.tokenSource).toBe("EXECUTOR_AUTH_TOKEN");
  });

  it("carries no header when no token is configured", () => {
    const resolved = resolve({
      [ENDPOINT_ENV_VAR]: "http://127.0.0.1:4788/mcp",
      EXECUTOR_API_KEY: "",
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.config.authorization).toBeNull();
    expect(resolved.config.tokenSource).toBeNull();
  });
});
