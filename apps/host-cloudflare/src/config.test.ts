import { readFileSync } from "node:fs";

import { describe, expect, it } from "@effect/vitest";
import { parse } from "jsonc-parser";

import { loadConfig } from "./config";

type ConfigEnv = Parameters<typeof loadConfig>[0];

const makeEnv = (overrides: Partial<ConfigEnv> = {}): ConfigEnv => ({
  EXECUTOR_SECRET_KEY: "test-secret-key-0123456789abcdef",
  VITE_PUBLIC_SITE_URL: "https://executor.example.com",
  ...overrides,
});

describe("loadConfig", () => {
  it("rejects missing Cloudflare Access configuration outside local development", () => {
    expect(() => loadConfig(makeEnv())).toThrowError(
      "Cloudflare Access is not configured. Set ACCESS_TEAM_DOMAIN and ACCESS_AUD before serving requests.",
    );
  });

  it("rejects the repository's former team-domain placeholder", () => {
    expect(() =>
      loadConfig(
        makeEnv({
          ACCESS_TEAM_DOMAIN: "your-team.cloudflareaccess.com",
          ACCESS_AUD: "aud-tag",
        }),
      ),
    ).toThrowError(
      "Cloudflare Access is not configured. Set ACCESS_TEAM_DOMAIN before serving requests.",
    );
  });

  it("allows local development to bypass Cloudflare Access", () => {
    expect(loadConfig(makeEnv({ ENABLE_DEV_AUTH: "true" }))).toMatchObject({
      accessTeamDomain: "",
      accessAud: "",
      enableDevAuth: true,
    });
  });

  it("normalises configured Access values without requiring an administrator", () => {
    expect(
      loadConfig(
        makeEnv({
          ACCESS_TEAM_DOMAIN: "https://Team.cloudflareaccess.com/",
          ACCESS_AUD: " aud-tag ",
        }),
      ),
    ).toMatchObject({
      accessTeamDomain: "Team.cloudflareaccess.com",
      accessAud: "aud-tag",
      adminEmails: [],
      accessServiceTokenSubjects: {},
      enableDevAuth: false,
    });
  });

  it("normalises dedicated service-token subject mappings", () => {
    expect(
      loadConfig(
        makeEnv({
          ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
          ACCESS_AUD: "aud-tag",
          ACCESS_SERVICE_TOKEN_SUBJECTS: "ABC123.access=user-123, DEF456.access=user-456",
        }),
      ).accessServiceTokenSubjects,
    ).toEqual({
      "abc123.access": "user-123",
      "def456.access": "user-456",
    });
  });

  it("rejects malformed service-token subject mappings", () => {
    expect(() =>
      loadConfig(
        makeEnv({
          ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
          ACCESS_AUD: "aud-tag",
          ACCESS_SERVICE_TOKEN_SUBJECTS: "missing-subject",
        }),
      ),
    ).toThrowError("ACCESS_SERVICE_TOKEN_SUBJECTS");
  });

  it("rejects duplicate service-token subject mappings", () => {
    expect(() =>
      loadConfig(
        makeEnv({
          ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
          ACCESS_AUD: "aud-tag",
          ACCESS_SERVICE_TOKEN_SUBJECTS: "ABC123.access=user-123, abc123.access=user-456",
        }),
      ),
    ).toThrowError("ACCESS_SERVICE_TOKEN_SUBJECTS");
  });
});

describe("Cloudflare deployment configuration", () => {
  it("preserves operator-managed Access variables across deploys", () => {
    const config = parse(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8")) as {
      readonly keep_vars?: boolean;
      readonly vars?: Readonly<Record<string, unknown>>;
    };

    expect(config.keep_vars).toBe(true);
    expect(config.vars).not.toHaveProperty("ACCESS_TEAM_DOMAIN");
    expect(config.vars).not.toHaveProperty("ACCESS_AUD");
    expect(config.vars).not.toHaveProperty("ADMIN_EMAILS");
    expect(config.vars).not.toHaveProperty("ACCESS_SERVICE_TOKEN_SUBJECTS");
    expect(config.vars).toHaveProperty("ENABLE_DEV_AUTH", "false");
  });
});
