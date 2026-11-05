import { Option, Schema } from "effect";

export type ClientPrincipal = {
  readonly accountId: string;
  readonly organizationId: string;
};
export type ClientManifest = {
  readonly tools: readonly { readonly name: string; readonly [key: string]: unknown }[];
  readonly resources: readonly { readonly uri: string; readonly [key: string]: unknown }[];
  readonly prompts: readonly { readonly name: string; readonly [key: string]: unknown }[];
};
export const isClientManifest = (value: unknown): value is ClientManifest => {
  if (typeof value !== "object" || value === null) return false;
  if (!("tools" in value) || !Array.isArray(value.tools)) return false;
  if (!("resources" in value) || !Array.isArray(value.resources)) return false;
  if (!("prompts" in value) || !Array.isArray(value.prompts)) return false;
  return (
    value.tools.every((item) => typeof item === "object" && item !== null && "name" in item) &&
    value.resources.every((item) => typeof item === "object" && item !== null && "uri" in item) &&
    value.prompts.every((item) => typeof item === "object" && item !== null && "name" in item)
  );
};
export type ClientBinding = string;
export type ClientChannelEntry = {
  readonly principal: ClientPrincipal;
  readonly manifest: ClientManifest;
  readonly generation: number;
  readonly connected: boolean;
};
export type ClientChannelSnapshot = Readonly<Record<string, ClientChannelEntry>>;

const RequestSchema = Schema.Struct({
  method: Schema.String,
  params: Schema.optional(Schema.Unknown),
});
const decodeRequest = Schema.decodeUnknownOption(RequestSchema);

export const createClientChannelState = (initial: ClientChannelSnapshot = {}) => {
  const entries = new Map(Object.entries(initial));
  return {
    register(
      principal: ClientPrincipal,
      manifest: ClientManifest,
      clientId: string = crypto.randomUUID(),
    ): ClientBinding | { ok: false } {
      if (
        !principal?.accountId ||
        !principal?.organizationId ||
        !manifest ||
        !Array.isArray(manifest.tools) ||
        !Array.isArray(manifest.resources) ||
        !Array.isArray(manifest.prompts) ||
        manifest.tools.length + manifest.resources.length + manifest.prompts.length > 100
      )
        return { ok: false };
      const allItems = [...manifest.tools, ...manifest.resources, ...manifest.prompts];
      if (allItems.some((item) => typeof item !== "object" || item === null)) return { ok: false };
      const uniqueNames = [
        manifest.tools.map((item) => item.name),
        manifest.resources.map((item) => item.uri),
        manifest.prompts.map((item) => item.name),
      ];
      if (
        uniqueNames.some(
          (names) =>
            names.some((name) => typeof name !== "string" || !name || name.length > 200) ||
            new Set(names).size !== names.length,
        )
      )
        return { ok: false };
      if (entries.has(clientId)) return { ok: false };
      const binding = clientId;
      entries.set(binding, {
        principal,
        manifest: {
          tools: [...manifest.tools],
          resources: [...manifest.resources],
          prompts: [...manifest.prompts],
        },
        generation: 0,
        connected: true,
      });
      return binding;
    },
    snapshot(): ClientChannelSnapshot {
      return Object.fromEntries(entries);
    },
    get(binding: string) {
      return entries.get(binding);
    },
    disconnect(binding: string) {
      const entry = entries.get(binding);
      if (entry)
        entries.set(binding, { ...entry, connected: false, generation: entry.generation + 1 });
    },
  };
};

export const routeClientRequest = (
  state: ReturnType<typeof createClientChannelState>,
  binding: string,
  generation: number,
  raw: unknown,
): { readonly ok: boolean; readonly error?: string } => {
  if (JSON.stringify(raw ?? null).length > 65_536) return { ok: false, error: "request_too_large" };
  if (typeof raw === "object" && raw !== null && "principal" in raw) {
    return { ok: false, error: "client_identity_forbidden" };
  }
  const parsed = decodeRequest(raw);
  if (Option.isNone(parsed)) return { ok: false, error: "invalid_request" };
  const request = parsed.value;
  const entry = state.get(binding);
  if (!entry || !entry.connected || entry.generation !== generation)
    return { ok: false, error: "stale_client" };
  const params = request.params;
  const selector =
    typeof params === "object" && params !== null
      ? "name" in params && typeof params.name === "string"
        ? params.name
        : "uri" in params && typeof params.uri === "string"
          ? params.uri
          : undefined
      : undefined;
  const manifestMethods: Readonly<Record<string, string>> = {
    "tools/call": "name",
    "resources/read": "uri",
    "prompts/get": "name",
  };
  if (
    !(request.method in manifestMethods) &&
    !["tools/list", "resources/list", "prompts/list"].includes(request.method)
  ) {
    return { ok: false, error: "method_denied" };
  }
  const allowedSelectors =
    request.method === "tools/call"
      ? entry.manifest.tools.map((x) => x.name)
      : request.method === "resources/read"
        ? entry.manifest.resources.map((x) => x.uri)
        : request.method === "prompts/get"
          ? entry.manifest.prompts.map((x) => x.name)
          : [];
  if (
    request.method in manifestMethods &&
    (selector === undefined || !allowedSelectors.includes(selector))
  ) {
    return { ok: false, error: "manifest_denied" };
  }
  return { ok: true };
};

/** Resolve an opaque, server-issued channel credential. Never decode identity
 * from the credential: the durable record is the source of truth. */
export const authenticateClientToken = (
  state: ReturnType<typeof createClientChannelState>,
  token: string | null,
): {
  readonly principal: ClientPrincipal;
  readonly generation: number;
  readonly binding: string;
} | null => {
  if (!token || token.length > 128) return null;
  const entry = state.get(token);
  return entry?.connected
    ? { principal: entry.principal, generation: entry.generation, binding: token }
    : null;
};

export const clientChannelBelongsToPrincipal = (
  identity: { readonly principal: ClientPrincipal } | null,
  principal: ClientPrincipal,
): boolean =>
  identity !== null &&
  identity.principal.accountId === principal.accountId &&
  identity.principal.organizationId === principal.organizationId;

/** Filter standard MCP list-result arrays to the persisted manifest before
 * returning them through an overlay/session bridge. Unknown response shapes
 * fail closed rather than leaking an unfiltered catalog. */
export const filterClientManifestResponse = (
  state: ReturnType<typeof createClientChannelState>,
  binding: string,
  method: string,
  raw: unknown,
): unknown | null => {
  const entry = state.get(binding);
  if (!entry?.connected) return null;
  if (!["tools/list", "resources/list", "prompts/list"].includes(method)) return null;
  if (
    typeof raw !== "object" ||
    raw === null ||
    !("result" in raw) ||
    typeof raw.result !== "object" ||
    raw.result === null
  )
    return null;
  const result = raw.result as Record<string, unknown>;
  const key =
    method === "tools/list" ? "tools" : method === "resources/list" ? "resources" : "prompts";
  if (!(key in result) || !Array.isArray(result[key])) return null;
  const selector = key === "resources" ? "uri" : "name";
  const allowed = new Set(
    key === "tools"
      ? entry.manifest.tools.map((x) => x.name)
      : key === "resources"
        ? entry.manifest.resources.map((x) => x.uri)
        : entry.manifest.prompts.map((x) => x.name),
  );
  return {
    ...raw,
    result: {
      ...result,
      [key]: result[key].filter((item: unknown) => {
        if (typeof item !== "object" || item === null) return false;
        const itemSelector = (item as Record<string, unknown>)[selector];
        return typeof itemSelector === "string" && allowed.has(itemSelector);
      }),
    },
  };
};
