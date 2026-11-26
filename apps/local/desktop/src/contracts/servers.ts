import { Schema } from "effect";
import { AccountKey, DesktopId } from "./installed-apps.ts";

export const cloudDashboardOrigin = "https://app.executor.sh";
export const cloudOriginVariable = "EXECUTOR_DESKTOP_CLOUD_ORIGIN";
export const desktopClientName = "Executor desktop";
export const desktopScope = "desktop offline_access";
export const serversFileName = "servers.json";
export const preferencesFileName = "desktop-accounts.json";

export const HostedKind = Schema.Literals(["self-host", "cloud"]);
export type HostedKind = typeof HostedKind.Type;

export const ServerEndpoints = Schema.Struct({
  resource: Schema.String,
  api: Schema.String,
  token: Schema.String,
  revocation: Schema.NullOr(Schema.String),
  clientId: Schema.String,
});
export type ServerEndpoints = typeof ServerEndpoints.Type;

const hostedFields = {
  serverId: DesktopId,
  kind: HostedKind,
  origin: Schema.String,
  organizationId: DesktopId,
  organizationSlug: Schema.String,
  label: Schema.String,
  account: Schema.Struct({ id: Schema.String, email: Schema.String }),
  partition: Schema.String.check(Schema.isUUID()),
  state: Schema.Literals(["signed-in", "sign-in-again"]),
  endpoints: ServerEndpoints,
};

export const HostedServer = Schema.Struct({
  ...hostedFields,
  sealedRefreshToken: Schema.NullOr(Schema.String),
});
export type HostedServer = typeof HostedServer.Type;

export const ServersFile = Schema.Struct({
  version: Schema.Literal(2),
  accounts: Schema.Array(HostedServer),
});
export type ServersFile = typeof ServersFile.Type;

export const accountKey = (record: {
  readonly serverId: string;
  readonly organizationId: string;
}): AccountKey => `${record.serverId}.${record.organizationId}`;

export const AccountPreferences = Schema.Struct({
  version: Schema.Literal(1),
  local: Schema.Boolean,
  lastUsed: Schema.NullOr(AccountKey),
});
export type AccountPreferences = typeof AccountPreferences.Type;

export const ServerOrigins = Schema.Struct({
  dashboard: Schema.String,
  api: Schema.String,
  auth: Schema.String,
});
export type ServerOrigins = typeof ServerOrigins.Type;

export const HostedIdentity = Schema.Struct({
  serverId: DesktopId,
  kind: Schema.Literals(["local", "self-host", "cloud"]),
  origins: Schema.optionalKey(ServerOrigins),
});

export const ProtectedResource = Schema.Struct({
  resource: Schema.String,
  authorization_servers: Schema.NonEmptyArray(Schema.String),
});

export const AuthorizationServer = Schema.Struct({
  issuer: Schema.String,
  authorization_endpoint: Schema.String,
  token_endpoint: Schema.String,
  registration_endpoint: Schema.String,
  revocation_endpoint: Schema.optionalKey(Schema.String),
});

export const RegisteredClient = Schema.Struct({ client_id: Schema.NonEmptyString });

export const TokenResponse = Schema.Struct({
  access_token: Schema.NonEmptyString,
  refresh_token: Schema.NonEmptyString,
  expires_in: Schema.optionalKey(Schema.Number),
});

export const SessionLink = Schema.Struct({ url: Schema.String, expiresAt: Schema.String });

export const DashboardSession = Schema.NullOr(
  Schema.Struct({ user: Schema.Struct({ id: Schema.String }) }),
);

export const AppLocation = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("ready"),
    url: Schema.String,
    name: Schema.String,
    icon: Schema.Boolean,
    menuBar: Schema.Boolean,
  }),
  Schema.Struct({ status: Schema.Literals(["unavailable", "pending", "failed"]) }),
]);

export const DesktopAccount = Schema.Struct({
  user: Schema.Struct({ id: Schema.String, email: Schema.String }),
  organization: Schema.Struct({ id: Schema.String, slug: Schema.String, name: Schema.String }),
});

export class ServerRefused extends Schema.TaggedError<ServerRefused>()("ServerRefused", {
  message: Schema.String,
}) {}
export class SignInAgain extends Schema.TaggedError<SignInAgain>()("SignInAgain", {}) {}
export class RecordChanged extends Schema.TaggedError<RecordChanged>()("RecordChanged", {}) {}

export const hostedServerId = (serverId: string) =>
  HostedKind.literals.some((kind) => serverId.startsWith(`${kind}-`));

export const serverOfAccount = (account: string) => account.split(".")[0] ?? account;

export const linkRequestHeaders = "x-executor-desktop-link: 1\n";

export const linkCookieName = (origin: string) =>
  new URL(origin).protocol === "https:" ? "__Host-executor-desktop-link" : "executor-desktop-link";
