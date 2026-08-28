import { describe, expect, it } from "@effect/vitest";
import {
  AuthTemplateSlug,
  IntegrationSlug,
  OAuthClientSlug,
  ProviderItemId,
  ProviderKey,
  type OAuthProbeResult,
  type Owner,
} from "@executor-js/sdk/shared";

import type { AuthMethod } from "../lib/auth-placements";
import type { OAuthPopupReservation } from "../plugins/oauth-sign-in";
import {
  connectionNameFrom,
  connectionLabel,
  connectionLabelForHost,
  createCredentialPayloadOrigin,
  DEFAULT_CONNECTION_OWNER,
  mergeCustomMethods,
  oauthIdentityLabelFromHealth,
  runAutomaticOAuthConnect,
  runCimdConnect,
  typedIdentityLabel,
  uniqueConnectionName,
} from "./add-account-modal";

const apiKeyMethod = (id: string, source: "spec" | "custom", template = id): AuthMethod => ({
  id,
  label: `API key (${id})`,
  kind: "apikey",
  source,
  template: AuthTemplateSlug.make(template),
  placements: [{ carrier: "header", name: "Authorization", prefix: "" }],
});

type ProbeResult = OAuthProbeResult;

type RegisterArgs = {
  readonly owner: Owner;
  readonly slug: OAuthClientSlug;
  readonly issuer?: string | null;
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

type StartArgs = {
  readonly client: OAuthClientSlug;
  readonly owner: Owner;
  readonly reservation: OAuthPopupReservation;
};

// A reservation the browser honoured. The desktop shape is the one that carries
// no `Window`, so the orchestrators' ordering is testable without a DOM.
const RESERVED: OAuthPopupReservation = {
  kind: "desktop",
  bridge: { openExternal: (): Promise<void> => Promise.resolve() },
};

/** Records the reserve/release calls alongside the network steps, so a test can
 *  assert the window is claimed BEFORE the first round trip and closed again
 *  whenever the flow ends without signing in. */
const popupSpy = (reservation: OAuthPopupReservation = RESERVED) => {
  const calls: string[] = [];
  return {
    calls,
    reserve: (): OAuthPopupReservation => {
      calls.push("reserve");
      return reservation;
    },
    release: (): void => {
      calls.push("release");
    },
  };
};

type AutomaticOAuthDeps = Parameters<typeof runAutomaticOAuthConnect>[0];
type AutomaticOAuthInput = Parameters<typeof runAutomaticOAuthConnect>[1];

/** DCR-focused tests use defaults for the CIMD branch they intentionally do
 *  not exercise. Discovery-level tests call the orchestrator directly. */
const runDcrConnect = (
  deps: Omit<AutomaticOAuthDeps, "createCimdClient">,
  input: Omit<AutomaticOAuthInput, "cimd">,
) =>
  runAutomaticOAuthConnect(
    {
      ...deps,
      createCimdClient: (): Promise<OAuthClientSlug | null> => Promise.resolve(null),
    },
    {
      ...input,
      cimd: {
        integrationName: "Test MCP",
        clientIdMetadataDocumentUrl: "https://executor.example/api/oauth/client-id-metadata.json",
        existingClients: [],
      },
    },
  );

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

type CimdStartArgs = {
  readonly client: OAuthClientSlug;
  readonly owner: Owner;
  readonly reservation: OAuthPopupReservation;
};

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

describe("uniqueConnectionName", () => {
  const base = connectionNameFrom("", "user", "Gmail", "org_123");

  it("keeps the derived name when it is not taken", () => {
    expect(String(uniqueConnectionName(base, new Set()))).toBe("personalGmail");
  });

  it("suffixes past taken names so a second untyped connect mints a NEW connection", () => {
    expect(String(uniqueConnectionName(base, new Set(["personalGmail"])))).toBe("personalGmail2");
    expect(String(uniqueConnectionName(base, new Set(["personalGmail", "personalGmail2"])))).toBe(
      "personalGmail3",
    );
  });
});

describe("typedIdentityLabel", () => {
  it("returns undefined for empty/whitespace labels so oauth.start omits the label", () => {
    expect(typedIdentityLabel("")).toBeUndefined();
    expect(typedIdentityLabel("   ")).toBeUndefined();
  });

  it("returns the trimmed label the user typed", () => {
    expect(typedIdentityLabel("  Work Gmail ")).toBe("Work Gmail");
  });
});

describe("oauthIdentityLabelFromHealth", () => {
  const healthyResult = {
    status: "healthy" as const,
    identity: " user@example.com ",
    checkedAt: 1,
  };

  it("fills an unset label (untyped connect with no OIDC claims)", () => {
    expect(
      oauthIdentityLabelFromHealth({
        result: healthyResult,
        typedLabel: "",
        storedIdentityLabel: null,
      }),
    ).toBe("user@example.com");
  });

  it("does not overwrite a hand-typed label", () => {
    expect(
      oauthIdentityLabelFromHealth({
        result: healthyResult,
        typedLabel: "My Google Account",
        storedIdentityLabel: "My Google Account",
      }),
    ).toBeNull();
  });

  it("does not overwrite a stored custom label", () => {
    expect(
      oauthIdentityLabelFromHealth({
        result: healthyResult,
        typedLabel: "",
        storedIdentityLabel: "Finance Google",
      }),
    ).toBeNull();
  });

  it("does not overwrite a label already filled from OIDC claims", () => {
    expect(
      oauthIdentityLabelFromHealth({
        result: healthyResult,
        typedLabel: "",
        storedIdentityLabel: "alice@example.com",
      }),
    ).toBeNull();
  });

  it("requires a healthy result with an identity", () => {
    expect(
      oauthIdentityLabelFromHealth({
        result: { status: "degraded", checkedAt: 1 },
        typedLabel: "",
        storedIdentityLabel: null,
      }),
    ).toBeNull();
    expect(
      oauthIdentityLabelFromHealth({
        result: { status: "healthy", checkedAt: 1 },
        typedLabel: "",
        storedIdentityLabel: null,
      }),
    ).toBeNull();
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
        reserve: (): OAuthPopupReservation => RESERVED,
        release: (): void => {},
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
        reserve: (): OAuthPopupReservation => RESERVED,
        release: (): void => {},
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
    expect(startArgs).toEqual({ client: existingSlug, owner: "user", reservation: RESERVED });
  });
});

describe("runAutomaticOAuthConnect", () => {
  it("prefers advertised CIMD over DCR and keeps the original popup reservation", async () => {
    const popup = popupSpy();
    const calls: string[] = [];
    let createArgs: CimdCreateArgs | null = null;
    let startArgs: StartArgs | null = null;

    const outcome = await runAutomaticOAuthConnect(
      {
        ...popup,
        probe: (): Promise<ProbeResult> => {
          calls.push("probe");
          return Promise.resolve({
            authorizationUrl: "https://auth.example.com/authorize",
            tokenUrl: "https://auth.example.com/token",
            resource: "https://mcp.example.com/mcp",
            registrationEndpoint: "https://auth.example.com/register",
            clientIdMetadataDocumentSupported: true,
          });
        },
        createCimdClient: (args: CimdCreateArgs): Promise<OAuthClientSlug> => {
          calls.push("create-cimd");
          createArgs = args;
          return Promise.resolve(args.slug);
        },
        register: (): Promise<OAuthClientSlug> => {
          calls.push("register-dcr");
          return Promise.resolve(OAuthClientSlug.make("unexpected-dcr-client"));
        },
        start: (args: StartArgs): void => {
          calls.push("start");
          startArgs = args;
        },
      },
      {
        discoveryUrl: "https://mcp.example.com/mcp",
        resourceFallback: "https://mcp.example.com/mcp",
        owner: "user",
        integration: TEST_INTEGRATION,
        cimd: {
          integrationName: "Test MCP",
          clientIdMetadataDocumentUrl: "https://executor.example/api/oauth/client-id-metadata.json",
          existingClients: [],
        },
      },
    );

    expect(outcome).toEqual({ kind: "started", flow: "cimd" });
    expect(calls).toEqual(["probe", "create-cimd", "start"]);
    expect(createArgs).toMatchObject({
      clientId: "https://executor.example/api/oauth/client-id-metadata.json",
      clientSecret: "",
      resource: "https://mcp.example.com/mcp",
    });
    expect(startArgs!.reservation).toBe(RESERVED);
  });
});

describe("runDcrConnect popup reservation", () => {
  const probeOk = (): Promise<ProbeResult> =>
    Promise.resolve({
      authorizationUrl: "https://auth.example.com/authorize",
      tokenUrl: "https://auth.example.com/token",
      registrationEndpoint: "https://auth.example.com/register",
    });
  const dcrInput = {
    discoveryUrl: "https://mcp.example.com/mcp",
    owner: "user" as Owner,
    integration: TEST_INTEGRATION,
  };

  // The regression: probe and register are two round trips, and a browser stops
  // honouring `window.open` about five seconds after the click. Opening the
  // window after them is refused, so the connect ends with no popup, no error,
  // and the button back on "Connect". The window has to be claimed up front.
  it("claims the sign-in window BEFORE the first network call", async () => {
    const popup = popupSpy();
    const outcome = await runDcrConnect(
      {
        ...popup,
        probe: (): Promise<ProbeResult> => {
          popup.calls.push("probe");
          return probeOk();
        },
        register: (): Promise<OAuthClientSlug> => {
          popup.calls.push("register");
          return Promise.resolve(OAuthClientSlug.make("mcp-app"));
        },
        start: (): void => {
          popup.calls.push("start");
        },
      },
      dcrInput,
    );

    expect(outcome).toEqual({ kind: "started", flow: "dcr" });
    expect(popup.calls).toEqual(["reserve", "probe", "register", "start"]);
  });

  it("hands the reserved window to start, so the flow navigates it rather than opening a new one", async () => {
    let startArgs: StartArgs | null = null;
    const outcome = await runDcrConnect(
      {
        ...popupSpy(),
        probe: probeOk,
        register: (): Promise<OAuthClientSlug> => Promise.resolve(OAuthClientSlug.make("mcp-app")),
        start: (args: StartArgs): void => {
          startArgs = args;
        },
      },
      dcrInput,
    );

    expect(outcome).toEqual({ kind: "started", flow: "dcr" });
    expect(startArgs!.reservation).toBe(RESERVED);
  });

  it("gives up before any network call when the browser refuses the window", async () => {
    const popup = popupSpy({ kind: "blocked" });
    let probed = false;
    const outcome = await runDcrConnect(
      {
        ...popup,
        probe: (): Promise<ProbeResult> => {
          probed = true;
          return probeOk();
        },
        register: (): Promise<OAuthClientSlug> => Promise.resolve(OAuthClientSlug.make("mcp-app")),
        start: (): void => {},
      },
      dcrInput,
    );

    // No BYO fallback: registering an app by hand cannot open a window either.
    expect(outcome).toEqual({ kind: "popup-blocked" });
    expect(probed).toBe(false);
    expect(popup.calls).toEqual(["reserve"]);
  });

  // Reserving early means a flow that ends without signing in is holding an
  // about:blank window the user never asked for.
  it("closes the reserved window when the probe fails", async () => {
    const popup = popupSpy();
    const outcome = await runDcrConnect(
      {
        ...popup,
        probe: (): Promise<ProbeResult | null> => Promise.resolve(null),
        register: (): Promise<OAuthClientSlug> => Promise.resolve(OAuthClientSlug.make("mcp-app")),
        start: (): void => {},
      },
      dcrInput,
    );

    expect(outcome).toEqual({ kind: "fallback", reason: "probe-failed" });
    expect(popup.calls).toEqual(["reserve", "release"]);
  });

  it("closes the reserved window when the server advertises no registration endpoint", async () => {
    const popup = popupSpy();
    const outcome = await runDcrConnect(
      {
        ...popup,
        probe: (): Promise<ProbeResult> =>
          Promise.resolve({
            authorizationUrl: "https://auth.example.com/authorize",
            tokenUrl: "https://auth.example.com/token",
          }),
        register: (): Promise<OAuthClientSlug> => Promise.resolve(OAuthClientSlug.make("mcp-app")),
        start: (): void => {},
      },
      dcrInput,
    );

    expect(outcome.kind).toBe("fallback");
    expect(popup.calls).toEqual(["reserve", "release"]);
  });

  it("closes the reserved window when registration is rejected", async () => {
    const popup = popupSpy();
    const outcome = await runDcrConnect(
      {
        ...popup,
        probe: probeOk,
        register: (): Promise<{ readonly error: string }> =>
          Promise.resolve({ error: "redirect_uri not allowed" }),
        start: (): void => {},
      },
      dcrInput,
    );

    expect(outcome).toMatchObject({ reason: "registration-failed" });
    expect(popup.calls).toEqual(["reserve", "release"]);
  });

  it("keeps the reserved window open on the path that signs in", async () => {
    const popup = popupSpy();
    await runDcrConnect(
      {
        ...popup,
        probe: probeOk,
        register: (): Promise<OAuthClientSlug> => Promise.resolve(OAuthClientSlug.make("mcp-app")),
        start: (): void => {},
      },
      dcrInput,
    );

    expect(popup.calls).not.toContain("release");
  });
});

describe("runCimdConnect popup reservation", () => {
  const cimdInput = {
    owner: "user" as Owner,
    integrationName: "PostHog API",
    authorizationUrl: "https://us.posthog.com/oauth/authorize/",
    tokenUrl: "https://us.posthog.com/oauth/token/",
    resource: null,
    clientIdMetadataDocumentUrl: "https://executor.example/api/oauth/client-id-metadata.json",
    existingClients: [],
  };

  it("claims the sign-in window before minting the client", async () => {
    const popup = popupSpy();
    const outcome = await runCimdConnect(
      {
        ...popup,
        createClient: (args: CimdCreateArgs): Promise<OAuthClientSlug> => {
          popup.calls.push("createClient");
          return Promise.resolve(args.slug);
        },
        start: (): void => {
          popup.calls.push("start");
        },
      },
      cimdInput,
    );

    expect(outcome.kind).toBe("started");
    expect(popup.calls).toEqual(["reserve", "createClient", "start"]);
  });

  it("closes the reserved window when minting the client fails", async () => {
    const popup = popupSpy();
    const outcome = await runCimdConnect(
      {
        ...popup,
        createClient: (): Promise<OAuthClientSlug | null> => Promise.resolve(null),
        start: (): void => {},
      },
      cimdInput,
    );

    expect(outcome).toEqual({ kind: "failed", reason: "create-failed" });
    expect(popup.calls).toEqual(["reserve", "release"]);
  });

  it("never claims a window when the method is missing its endpoints", async () => {
    const popup = popupSpy();
    const outcome = await runCimdConnect(
      {
        ...popup,
        createClient: (): Promise<OAuthClientSlug | null> => Promise.resolve(null),
        start: (): void => {},
      },
      { ...cimdInput, tokenUrl: "  " },
    );

    expect(outcome).toEqual({ kind: "failed", reason: "missing-endpoints" });
    expect(popup.calls).toEqual([]);
  });
});

describe("runDcrConnect", () => {
  it("auto-registers (no picker) then starts: probe → register → start in order", async () => {
    const calls: string[] = [];
    let registerArgs: RegisterArgs | null = null;
    let startArgs: StartArgs | null = null;

    const probe = (_url: string): Promise<ProbeResult | null> => {
      calls.push("probe");
      return Promise.resolve({
        issuer: "https://auth.example.com",
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
      {
        reserve: (): OAuthPopupReservation => RESERVED,
        release: (): void => {},
        probe,
        register,
        start,
      },
      {
        discoveryUrl: "https://mcp.example.com/mcp",
        owner: "user",
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
    expect(String(registerArgs!.slug)).toBe("dcr-auth-example-com");
    expect(registerArgs!.issuer).toBe("https://auth.example.com");
    expect(registerArgs!.registrationEndpoint).toBe("https://auth.example.com/register");
    expect(registerArgs!.authorizationUrl).toBe("https://auth.example.com/authorize");
    expect(registerArgs!.tokenUrl).toBe("https://auth.example.com/token");
    expect(registerArgs!.resource).toBe("https://mcp.example.com/mcp");
    expect(registerArgs!.tokenEndpointAuthMethodsSupported).toEqual(["none"]);
    // Always the bare product name: brand-vetting servers (e.g. Mercury)
    // reject client_names containing their own brand.
    expect(registerArgs!.clientName).toBe("Executor");
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
        reserve: (): OAuthPopupReservation => RESERVED,
        release: (): void => {},
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
        reserve: (): OAuthPopupReservation => RESERVED,
        release: (): void => {},
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
        reserve: (): OAuthPopupReservation => RESERVED,
        release: (): void => {},
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
        reserve: (): OAuthPopupReservation => RESERVED,
        release: (): void => {},
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
        reserve: (): OAuthPopupReservation => RESERVED,
        release: (): void => {},
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
        reserve: (): OAuthPopupReservation => RESERVED,
        release: (): void => {},
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

  it("mints a deterministic server-keyed slug WITHOUT the picker's slug list", async () => {
    // Part B removed the DCR connect path's dependency on the picker's app list:
    // the slug is derived from the authorization server (Part A), so callers no
    // longer thread `existingSlugs`. This omits it entirely and still succeeds.
    let registerArgs: RegisterArgs | null = null;
    const outcome = await runDcrConnect(
      {
        reserve: (): OAuthPopupReservation => RESERVED,
        release: (): void => {},
        probe: (): Promise<ProbeResult | null> =>
          Promise.resolve({
            issuer: "https://auth.example.com",
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
        discoveryUrl: "https://mcp.example.com/mcp",
        owner: "user",
        integration: TEST_INTEGRATION,
      },
    );
    expect(outcome.kind).toBe("started");
    expect(registerArgs).not.toBeNull();
    // Slug comes from the issuer host, independent of any picker state.
    expect(String(registerArgs!.slug)).toBe("dcr-auth-example-com");
  });
});
