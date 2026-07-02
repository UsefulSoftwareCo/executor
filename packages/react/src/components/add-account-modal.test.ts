import { describe, expect, it } from "@effect/vitest";
import {
  AuthTemplateSlug,
  IntegrationSlug,
  OAuthClientSlug,
  ProviderItemId,
  ProviderKey,
  type Owner,
} from "@executor-js/sdk/shared";

import type { AuthMethod } from "../lib/auth-placements";
import {
  connectionNameFrom,
  connectionLabel,
  connectionLabelForHost,
  createCredentialPayloadOrigin,
  dcrClientNameForIntegration,
  DEFAULT_CONNECTION_OWNER,
  mergeCustomMethods,
  runCimdConnect,
  runDcrConnect,
} from "./add-account-modal";

const apiKeyMethod = (id: string, source: "spec" | "custom", template = id): AuthMethod => ({
  id,
  label: `API key (${id})`,
  kind: "apikey",
  source,
  template: AuthTemplateSlug.make(template),
  placements: [{ carrier: "header", name: "Authorization", prefix: "" }],
});

type ProbeResult = {
  readonly authorizationUrl: string;
  readonly tokenUrl: string;
  readonly resource?: string | null;
  readonly scopesSupported?: readonly string[];
  readonly registrationEndpoint?: string | null;
  readonly tokenEndpointAuthMethodsSupported?: readonly string[];
};

type RegisterArgs = {
  readonly owner: Owner;
  readonly slug: OAuthClientSlug;
  readonly registrationEndpoint: string;
  readonly authorizationUrl: string;
  readonly tokenUrl: string;
  readonly resource?: string | null;
  readonly scopes: readonly string[];
  readonly tokenEndpointAuthMethodsSupported?: readonly string[];
  readonly clientName: string;
  readonly redirectUri?: string;
  readonly originIntegration?: IntegrationSlug;
};

type StartArgs = { readonly client: OAuthClientSlug; readonly owner: Owner };

type CimdCreateArgs = {
  readonly owner: Owner;
  readonly slug: OAuthClientSlug;
  readonly authorizationUrl: string;
  readonly tokenUrl: string;
  readonly resource?: string | null;
  readonly grant: "authorization_code";
  readonly clientId: string;
  readonly clientSecret: "";
};

type CimdStartArgs = { readonly client: OAuthClientSlug; readonly owner: Owner };

const TEST_INTEGRATION = IntegrationSlug.make("linear_mcp");

describe("connectionLabel (name placeholder derivation)", () => {
  // The name field is optional but prefilled-via-derivation. With an empty
  // label this is the derived name shown as the input's placeholder, so the
  // intent ("leave blank ⇒ use this name") is visible.
  it("derives '<owner> <integration>' for an empty label (the placeholder)", () => {
    expect(connectionLabel("", "user", "GitHub")).toBe("Personal GitHub");
    expect(connectionLabel("", "org", "GitHub")).toBe("Workspace GitHub");
  });

  it("treats whitespace-only labels as empty (still derives the placeholder)", () => {
    expect(connectionLabel("   ", "user", "GitHub")).toBe("Personal GitHub");
  });

  it("uses the typed label (trimmed) when one is provided", () => {
    expect(connectionLabel("  My Bot  ", "user", "GitHub")).toBe("My Bot");
  });

  it("uses Local in derived labels for non-org-scoped hosts", () => {
    expect(connectionLabelForHost("", "org", "GitHub", null)).toBe("Local GitHub");
    expect(connectionLabelForHost("", "org", "GitHub", "org_123")).toBe("Workspace GitHub");
  });
});

describe("connectionNameFrom", () => {
  it("derives the JS-callable name from the display name", () => {
    expect(String(connectionNameFrom("Autumn Production", "user", "Autumn", "org_123"))).toBe(
      "autumnProduction",
    );
    expect(String(connectionNameFrom("linear-mcp-oauth", "user", "Linear MCP", "org_123"))).toBe(
      "linearMcpOauth",
    );
  });

  it("derives a callable default from owner and integration when the display name is empty", () => {
    expect(String(connectionNameFrom("", "org", "GitHub", "org_123"))).toBe("workspaceGithub");
    expect(String(connectionNameFrom("", "org", "GitHub", null))).toBe("localGithub");
  });
});

describe("DEFAULT_CONNECTION_OWNER", () => {
  // The 'saved to' owner defaults to Personal: a connection is most often a
  // personal credential.
  it("defaults a new connection's owner to Personal (user)", () => {
    expect(DEFAULT_CONNECTION_OWNER).toBe("user");
  });
});

describe("mergeCustomMethods (in-session custom method append)", () => {
  // A just-created custom method joins the selectable list (custom last) so it
  // can be selected before the catalog refresh lands.
  it("appends a session-created method after the declared methods", () => {
    const declared = [apiKeyMethod("spec-1", "spec")];
    const created = [apiKeyMethod("custom_a", "custom")];
    const merged = mergeCustomMethods(declared, created);
    expect(merged.map((m: AuthMethod) => m.id)).toEqual(["spec-1", "custom_a"]);
  });

  it("dedupes by stable identity (a refreshed catalog method wins over its session copy)", () => {
    const declared = [apiKeyMethod("spec-1", "spec"), apiKeyMethod("custom_a", "custom")];
    const created = [apiKeyMethod("custom_a", "custom")];
    const merged = mergeCustomMethods(declared, created);
    expect(merged.map((m: AuthMethod) => m.id)).toEqual(["spec-1", "custom_a"]);
  });

  it("dedupes custom methods by template even when their rendered ids differ", () => {
    const declared = [
      apiKeyMethod("spec-1", "spec"),
      apiKeyMethod("custom_a_refreshed", "custom", "custom_a"),
    ];
    const created = [apiKeyMethod("custom_a", "custom", "custom_a")];
    const merged = mergeCustomMethods(declared, created);
    expect(merged.map((m: AuthMethod) => m.id)).toEqual(["spec-1", "custom_a_refreshed"]);
  });

  it("returns the declared list unchanged when nothing was created", () => {
    const declared = [apiKeyMethod("spec-1", "spec")];
    expect(mergeCustomMethods(declared, [])).toEqual(declared);
  });
});

describe("createCredentialPayloadOrigin", () => {
  it("creates an empty-string sentinel value for no-auth connection methods", () => {
    expect(
      createCredentialPayloadOrigin({
        origin: "paste",
        inputs: [],
        values: {},
        onePasswordItemId: "",
        singleInput: true,
      }),
    ).toEqual({ values: { token: "" } });
  });

  it("keeps pasted credential values trimmed and keyed by input variable", () => {
    expect(
      createCredentialPayloadOrigin({
        origin: "paste",
        inputs: [{ variable: "token", label: "Authorization" }],
        values: { token: "  secret-token  " },
        onePasswordItemId: "",
        singleInput: true,
      }),
    ).toEqual({ values: { token: "secret-token" } });
  });

  it("creates a 1Password external origin for single-input methods", () => {
    expect(
      createCredentialPayloadOrigin({
        origin: "onepassword",
        inputs: [{ variable: "token", label: "Authorization" }],
        values: {},
        onePasswordItemId: " op://Private/Vercel/token ",
        singleInput: true,
      }),
    ).toEqual({
      from: {
        provider: ProviderKey.make("onepassword"),
        id: ProviderItemId.make("op://Private/Vercel/token"),
      },
    });
  });

  it("does not allow 1Password selection for multi-input methods yet", () => {
    expect(
      createCredentialPayloadOrigin({
        origin: "onepassword",
        inputs: [
          { variable: "apiKey", label: "API key" },
          { variable: "appKey", label: "Application key" },
        ],
        values: {},
        onePasswordItemId: "op://Private/Datadog/api-key",
        singleInput: false,
      }),
    ).toBeNull();
  });
});

describe("runCimdConnect", () => {
  it("creates a public metadata-document OAuth client and starts OAuth", async () => {
    let createArgs: CimdCreateArgs | null = null;
    let startArgs: CimdStartArgs | null = null;

    const outcome = await runCimdConnect(
      {
        createClient: (args: CimdCreateArgs): Promise<OAuthClientSlug | null> => {
          createArgs = args;
          return Promise.resolve(args.slug);
        },
        start: (args: CimdStartArgs): void => {
          startArgs = args;
        },
      },
      {
        owner: "user",
        integrationName: "PostHog API",
        authorizationUrl: "https://us.posthog.com/oauth/authorize/",
        tokenUrl: "https://us.posthog.com/oauth/token/",
        resource: "https://us.posthog.com",
        clientIdMetadataDocumentUrl:
          "https://executor.example/api/oauth/client-id-metadata/acme.json",
        existingClients: [],
      },
    );

    expect(outcome.kind).toBe("started");
    expect(createArgs).toMatchObject({
      owner: "user",
      authorizationUrl: "https://us.posthog.com/oauth/authorize/",
      tokenUrl: "https://us.posthog.com/oauth/token/",
      resource: "https://us.posthog.com",
      grant: "authorization_code",
      clientId: "https://executor.example/api/oauth/client-id-metadata/acme.json",
      clientSecret: "",
    });
    expect(String(createArgs!.slug)).toBe("posthog-api-cimd");
    expect(String(startArgs!.client)).toBe("posthog-api-cimd");
    expect(startArgs!.owner).toBe("user");
  });

  it("reuses an existing matching metadata-document client", async () => {
    const existingSlug = OAuthClientSlug.make("posthog-api-cimd");
    let created = false;
    let startArgs: CimdStartArgs | null = null;

    const outcome = await runCimdConnect(
      {
        createClient: (): Promise<OAuthClientSlug | null> => {
          created = true;
          return Promise.resolve(OAuthClientSlug.make("new-client"));
        },
        start: (args: CimdStartArgs): void => {
          startArgs = args;
        },
      },
      {
        owner: "user",
        integrationName: "PostHog API",
        authorizationUrl: "https://us.posthog.com/oauth/authorize/",
        tokenUrl: "https://us.posthog.com/oauth/token/",
        resource: "https://us.posthog.com",
        clientIdMetadataDocumentUrl: "https://executor.example/api/oauth/client-id-metadata.json",
        existingClients: [
          {
            owner: "user",
            slug: existingSlug,
            grant: "authorization_code",
            authorizationUrl: "https://us.posthog.com/oauth/authorize/",
            tokenUrl: "https://us.posthog.com/oauth/token/",
            resource: "https://us.posthog.com",
            clientId: "https://executor.example/api/oauth/client-id-metadata.json",
          },
        ],
      },
    );

    expect(outcome).toEqual({ kind: "started", client: existingSlug, reused: true });
    expect(created).toBe(false);
    expect(startArgs).toEqual({ client: existingSlug, owner: "user" });
  });
});

describe("runDcrConnect", () => {
  it("names dynamically registered OAuth apps as Executor clients", () => {
    expect(dcrClientNameForIntegration("PostHog MCP")).toBe("Executor for PostHog MCP");
    expect(dcrClientNameForIntegration("   ")).toBe("Executor");
  });

  it("auto-registers (no picker) then starts: probe → register → start in order", async () => {
    const calls: string[] = [];
    let registerArgs: RegisterArgs | null = null;
    let startArgs: StartArgs | null = null;

    const probe = (_url: string): Promise<ProbeResult | null> => {
      calls.push("probe");
      return Promise.resolve({
        authorizationUrl: "https://auth.example.com/authorize",
        tokenUrl: "https://auth.example.com/token",
        resource: "https://mcp.example.com/mcp",
        scopesSupported: ["mcp.read"],
        registrationEndpoint: "https://auth.example.com/register",
        tokenEndpointAuthMethodsSupported: ["none"],
      });
    };
    const register = (args: RegisterArgs): Promise<OAuthClientSlug | null> => {
      calls.push("register");
      registerArgs = args;
      return Promise.resolve(OAuthClientSlug.make("linear-mcp"));
    };
    const start = (args: StartArgs): void => {
      calls.push("start");
      startArgs = args;
    };

    const outcome = await runDcrConnect(
      { probe, register, start },
      {
        discoveryUrl: "https://mcp.example.com/mcp",
        owner: "user",
        integrationName: "Linear MCP",
        existingSlugs: [],
        redirectUri: "https://localhost:5394/api/oauth/callback",
        integration: TEST_INTEGRATION,
      },
    );

    expect(outcome.kind).toBe("started");
    expect(calls).toEqual(["probe", "register", "start"]);
    // Registered with the probed registration endpoint + probed auth methods.
    // DCR always mints an authorization-code/PKCE client; callers do not choose
    // a grant here.
    expect(registerArgs).not.toBeNull();
    expect(registerArgs!.registrationEndpoint).toBe("https://auth.example.com/register");
    expect(registerArgs!.authorizationUrl).toBe("https://auth.example.com/authorize");
    expect(registerArgs!.tokenUrl).toBe("https://auth.example.com/token");
    expect(registerArgs!.resource).toBe("https://mcp.example.com/mcp");
    expect(registerArgs!.tokenEndpointAuthMethodsSupported).toEqual(["none"]);
    expect(registerArgs!.clientName).toBe("Executor for Linear MCP");
    expect(registerArgs!.scopes).toEqual(["mcp.read"]);
    expect(registerArgs!.redirectUri).toBe("https://localhost:5394/api/oauth/callback");
    expect(registerArgs!.originIntegration).toBe(TEST_INTEGRATION);
    // Started with the minted client slug under the chosen owner.
    expect(startArgs).not.toBeNull();
    expect(String(startArgs!.client)).toBe("linear-mcp");
    expect(startArgs!.owner).toBe("user");
  });

  it("prefers declared scopes over probed scopes when present", async () => {
    let registerArgs: RegisterArgs | null = null;
    const outcome = await runDcrConnect(
      {
        probe: (): Promise<ProbeResult | null> =>
          Promise.resolve({
            authorizationUrl: "https://auth.example.com/authorize",
            tokenUrl: "https://auth.example.com/token",
            scopesSupported: ["probed.scope"],
            registrationEndpoint: "https://auth.example.com/register",
          }),
        register: (args: RegisterArgs): Promise<OAuthClientSlug | null> => {
          registerArgs = args;
          return Promise.resolve(OAuthClientSlug.make("app"));
        },
        start: (): void => {},
      },
      {
        discoveryUrl: "https://mcp.example.com/mcp",
        resourceFallback: "https://mcp.example.com/mcp",
        owner: "user",
        integrationName: "App",
        existingSlugs: [],
        declaredScopes: ["declared.scope"],
        integration: TEST_INTEGRATION,
      },
    );
    expect(outcome.kind).toBe("started");
    expect(registerArgs!.scopes).toEqual(["declared.scope"]);
    // PRM named no `resource`, so the genuine discovery URL (MCP) seeds the
    // RFC 8707 resource indicator.
    expect(registerArgs!.resource).toBe("https://mcp.example.com/mcp");
  });

  it("never seeds the resource indicator from the token endpoint (non-MCP DCR)", async () => {
    // A DCR integration with no discovery URL: `discoveryUrl` falls back to the
    // token endpoint for probing, but the token endpoint is not an RFC 8707
    // resource identifier, so it must NOT become the resource. With no genuine
    // discovery URL and no PRM-named resource, the indicator stays null.
    let registerArgs: RegisterArgs | null = null;
    const outcome = await runDcrConnect(
      {
        probe: (): Promise<ProbeResult | null> =>
          Promise.resolve({
            authorizationUrl: "https://auth.example.com/authorize",
            tokenUrl: "https://auth.example.com/token",
            registrationEndpoint: "https://auth.example.com/register",
          }),
        register: (args: RegisterArgs): Promise<OAuthClientSlug | null> => {
          registerArgs = args;
          return Promise.resolve(OAuthClientSlug.make("app"));
        },
        start: (): void => {},
      },
      {
        // discoveryUrl collapsed to the token endpoint (no real discovery URL).
        discoveryUrl: "https://auth.example.com/token",
        owner: "user",
        integrationName: "App",
        existingSlugs: [],
        integration: TEST_INTEGRATION,
      },
    );
    expect(outcome.kind).toBe("started");
    expect(registerArgs!.resource).toBeNull();
  });

  it("falls back to BYO when there is no registration endpoint (no register/start)", async () => {
    const calls: string[] = [];
    const outcome = await runDcrConnect(
      {
        probe: (): Promise<ProbeResult | null> => {
          calls.push("probe");
          return Promise.resolve({
            authorizationUrl: "https://auth.example.com/authorize",
            tokenUrl: "https://auth.example.com/token",
            registrationEndpoint: null,
          });
        },
        register: (): Promise<OAuthClientSlug | null> => {
          calls.push("register");
          return Promise.resolve(OAuthClientSlug.make("app"));
        },
        start: (): void => {
          calls.push("start");
        },
      },
      {
        discoveryUrl: "https://mcp.example.com/mcp",
        owner: "user",
        integrationName: "App",
        existingSlugs: [],
        integration: TEST_INTEGRATION,
      },
    );
    expect(outcome).toMatchObject({
      kind: "fallback",
      reason: "no-registration-endpoint",
      probe: {
        authorizationUrl: "https://auth.example.com/authorize",
        tokenUrl: "https://auth.example.com/token",
      },
    });
    expect(calls).toEqual(["probe"]);
  });

  it("falls back to BYO when the probe fails (no register/start)", async () => {
    const calls: string[] = [];
    const outcome = await runDcrConnect(
      {
        probe: (): Promise<ProbeResult | null> => {
          calls.push("probe");
          return Promise.resolve(null);
        },
        register: (): Promise<OAuthClientSlug | null> => {
          calls.push("register");
          return Promise.resolve(OAuthClientSlug.make("app"));
        },
        start: (): void => {
          calls.push("start");
        },
      },
      {
        discoveryUrl: "https://mcp.example.com/mcp",
        owner: "user",
        integrationName: "App",
        existingSlugs: [],
        integration: TEST_INTEGRATION,
      },
    );
    expect(outcome).toEqual({ kind: "fallback", reason: "probe-failed" });
    expect(calls).toEqual(["probe"]);
  });

  it("falls back when registration itself fails (start not called)", async () => {
    const calls: string[] = [];
    const outcome = await runDcrConnect(
      {
        probe: (): Promise<ProbeResult | null> =>
          Promise.resolve({
            authorizationUrl: "https://auth.example.com/authorize",
            tokenUrl: "https://auth.example.com/token",
            registrationEndpoint: "https://auth.example.com/register",
          }),
        register: (): Promise<OAuthClientSlug | null> => {
          calls.push("register");
          return Promise.resolve(null);
        },
        start: (): void => {
          calls.push("start");
        },
      },
      {
        discoveryUrl: "https://mcp.example.com/mcp",
        owner: "user",
        integrationName: "App",
        existingSlugs: [],
        integration: TEST_INTEGRATION,
      },
    );
    expect(outcome).toMatchObject({
      kind: "fallback",
      reason: "registration-failed",
      probe: {
        authorizationUrl: "https://auth.example.com/authorize",
        tokenUrl: "https://auth.example.com/token",
      },
    });
    expect(calls).toEqual(["register"]);
  });

  it("threads the register failure message into the fallback (registration-failed)", async () => {
    const message =
      "Automatic OAuth setup failed: this server only approves loopback redirect URLs " +
      "(http://localhost or http://127.0.0.1) for automatic registration, but Executor is " +
      "using https://app.example.com/api/oauth/callback. Register an OAuth app manually with " +
      "that redirect URL approved by the server, or run Executor on http://localhost.";
    let started = false;
    const outcome = await runDcrConnect(
      {
        probe: (): Promise<ProbeResult | null> =>
          Promise.resolve({
            authorizationUrl: "https://auth.example.com/authorize",
            tokenUrl: "https://auth.example.com/token",
            registrationEndpoint: "https://auth.example.com/register",
          }),
        register: (): Promise<{ readonly error: string }> => Promise.resolve({ error: message }),
        start: (): void => {
          started = true;
        },
      },
      {
        discoveryUrl: "https://mcp.example.com/mcp",
        owner: "user",
        integrationName: "App",
        existingSlugs: [],
        integration: TEST_INTEGRATION,
      },
    );
    // The redirect-URI rejection reaches the caller verbatim so the BYO fallback
    // can show why instead of the generic copy, and the OAuth start is skipped.
    expect(outcome).toEqual({
      kind: "fallback",
      reason: "registration-failed",
      probe: {
        authorizationUrl: "https://auth.example.com/authorize",
        tokenUrl: "https://auth.example.com/token",
        registrationEndpoint: "https://auth.example.com/register",
      },
      message,
    });
    expect(started).toBe(false);
  });
});
