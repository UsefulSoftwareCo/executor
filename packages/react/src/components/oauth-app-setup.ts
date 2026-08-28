import { slackMcpUserScopes } from "../lib/slack-mcp-oauth";

export { slackMcpUserScopes } from "../lib/slack-mcp-oauth";

export interface OAuthAppSetup {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly steps: readonly string[];
  readonly createLabel: string;
  readonly createUrl: (callbackUrl: string) => string;
}

interface OAuthAppSetupProvider extends OAuthAppSetup {
  readonly hosts: readonly string[];
}

interface SlackManifest {
  readonly display_information: {
    readonly name: string;
  };
  readonly oauth_config: {
    readonly redirect_urls: readonly string[];
    readonly scopes: {
      readonly user: readonly string[];
    };
  };
  readonly settings: {
    readonly org_deploy_enabled: boolean;
    readonly socket_mode_enabled: boolean;
    readonly token_rotation_enabled: boolean;
    readonly is_mcp_enabled: boolean;
  };
}

const slackManifest = (callbackUrl: string): SlackManifest => ({
  display_information: { name: "Executor" },
  oauth_config: {
    redirect_urls: [callbackUrl],
    scopes: { user: slackMcpUserScopes },
  },
  settings: {
    org_deploy_enabled: false,
    socket_mode_enabled: false,
    token_rotation_enabled: false,
    is_mcp_enabled: true,
  },
});

const providers: readonly OAuthAppSetupProvider[] = [
  {
    id: "slack",
    hosts: ["slack.com"],
    title: "Slack requires a pre-registered app",
    body: "Slack's MCP server doesn't support automatic registration. The link below creates a Slack app that's already configured for MCP access, with the right scopes and this callback URL.",
    steps: [
      "Create the app and click Create on Slack's confirmation screen.",
      "Install the app to your workspace when prompted.",
      "Copy the Client ID and Client Secret from Basic Information and paste them below.",
    ],
    createLabel: "Create the Slack app",
    createUrl: (callbackUrl: string) =>
      `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(
        JSON.stringify(slackManifest(callbackUrl)),
      )}`,
  },
];

const hostnameFromUrl = (value: string | null | undefined): string | null => {
  if (!value) return null;
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return null;
  }
};

const hostMatches = (hostname: string, providerHost: string): boolean =>
  hostname === providerHost || hostname.endsWith(`.${providerHost}`);

export function oauthAppSetupFor(input: {
  readonly authorizationUrl?: string;
  readonly tokenUrl?: string;
  readonly issuer?: string | null;
  readonly resource?: string | null;
}): OAuthAppSetup | undefined {
  const hostnames = [
    hostnameFromUrl(input.authorizationUrl),
    hostnameFromUrl(input.tokenUrl),
    hostnameFromUrl(input.issuer),
    hostnameFromUrl(input.resource),
  ].filter((hostname): hostname is string => hostname !== null);

  return providers.find((provider: OAuthAppSetupProvider) =>
    hostnames.some((hostname: string) =>
      provider.hosts.some((providerHost: string) => hostMatches(hostname, providerHost)),
    ),
  );
}
