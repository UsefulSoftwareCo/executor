import { Clock, Effect, Option, Result, Schema } from "effect";
import { Base64, Hex } from "effect/encoding";
import {
  NetworkRefused,
  type Placement,
  type PlacementPart,
  Placements,
  isPlacementField,
  placementKey,
  networkRefusalHeader,
  networkRefusalResponse,
  networkRefusalStatus,
  type HostAccount,
  type HostAccounts,
  type HostAccountSlots,
  type ResolvedAccountSlots,
  scopedSlots,
  renderPlacement,
  type ResolvedAccount,
  type ResolvedAccounts,
} from "apps/contracts";
import { isLoopbackHostname, isPrivateHostname } from "@executor-js/utils/url-policy";
import type { HostApiCheck } from "../contracts/host-api.ts";
import { executorUserAgent } from "./user-agent.ts";
import {
  hostApiChangingHeader,
  hostApiChangingResponse,
  hostApiChangingStatus,
  NetworkUnreachable,
  networkUnreachableHeader,
  networkUnreachableResponse,
  networkUnreachableStatus,
} from "./app-network.ts";

const handleLifetime = 60 * 60 * 1000;
export const credentialBodyLimit = 1024 * 1024;

const handleSource = "exsec2?_[0-9a-f]+_";
const handlePattern = new RegExp(handleSource, "gu");

const Sealed = Schema.Struct({
  app: Schema.String,
  account: Schema.String,
  provider: Schema.String,
  hosts: Schema.Array(Schema.String),
  expires: Schema.Number,
  value: Schema.String,
  request: Schema.optionalKey(Placements),
  field: Schema.optionalKey(Schema.String),
  exposed: Schema.optionalKey(Schema.Array(Schema.String)),
  managed: Schema.optionalKey(Schema.Literal(true)),
});
type Sealed = typeof Sealed.Type;

const formats = {
  anywhere: {
    prefix: "exsec_",
    data: new TextEncoder().encode("executor.credential-handle.v1"),
    json: Schema.fromJsonString(
      Sealed.check(
        Schema.makeFilter((sealed) => sealed.request === undefined && sealed.managed === undefined),
      ),
    ),
  },
  placed: {
    prefix: "exsec2_",
    data: new TextEncoder().encode("executor.credential-handle.v2"),
    json: Schema.fromJsonString(
      Sealed.check(Schema.makeFilter((sealed) => sealed.request !== undefined)),
    ),
  },
} as const;
const formatOf = (sealed: Sealed) =>
  sealed.request === undefined ? formats.anywhere : formats.placed;

export const credentialKey = (secret: string) =>
  Effect.promise(async () => {
    const material = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      "HKDF",
      false,
      ["deriveKey"],
    );
    return crypto.subtle.deriveKey(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: new Uint8Array(),
        info: new TextEncoder().encode("executor credential handles"),
      },
      material,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
  });

const seal = (key: CryptoKey, sealed: Sealed) =>
  Effect.promise(async () => {
    const format = formatOf(sealed);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = new TextEncoder().encode(Schema.encodeSync(format.json)(sealed));
    const ciphertext = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: format.data },
        key,
        plaintext,
      ),
    );
    const bytes = new Uint8Array(iv.length + ciphertext.length);
    bytes.set(iv);
    bytes.set(ciphertext, iv.length);
    return `${format.prefix}${Hex.encode(bytes)}_`;
  });

const open = (key: CryptoKey, handle: string) =>
  Effect.gen(function* () {
    const format = handle.startsWith(formats.placed.prefix) ? formats.placed : formats.anywhere;
    const bytes = Result.getOrUndefined(Hex.decode(handle.slice(format.prefix.length, -1)));
    if (bytes === undefined || bytes.length <= 12) return Option.none<Sealed>();
    const plaintext = yield* Effect.tryPromise(() =>
      crypto.subtle.decrypt(
        { name: "AES-GCM", iv: bytes.slice(0, 12), additionalData: format.data },
        key,
        bytes.slice(12),
      ),
    ).pipe(Effect.option);
    if (Option.isNone(plaintext)) return Option.none<Sealed>();
    return Schema.decodeUnknownOption(format.json)(new TextDecoder().decode(plaintext.value));
  });

const sealValue = (
  value: unknown,
  sealString: (value: string) => Effect.Effect<string>,
): Effect.Effect<unknown> => {
  if (typeof value === "string") return sealString(value);
  if (Array.isArray(value)) return Effect.forEach(value, (item) => sealValue(item, sealString));
  if (typeof value === "object" && value !== null)
    return Effect.forEach(Object.entries(value), ([name, item]) =>
      sealValue(item, sealString).pipe(Effect.map((sealed) => [name, sealed] as const)),
    ).pipe(Effect.map(Object.fromEntries));
  return Effect.succeed(value);
};

const sealAccount = (
  { managed, ...account }: HostAccount,
  context: { readonly app: string; readonly key: CryptoKey; readonly expires: number },
): Effect.Effect<ResolvedAccount> =>
  Effect.gen(function* () {
    const hosts = account.provider.hosts;
    if (hosts === undefined && managed === undefined) return account;
    const method = Object.hasOwn(account.provider.auth, account.method)
      ? account.provider.auth[account.method]
      : undefined;
    const exposed = new Set(
      managed === undefined ? [...(method?.plain ?? []), ...(method?.raw ?? [])] : [],
    );
    const request = method?.request ?? (managed === undefined ? undefined : []);
    const sealString = (field: string | undefined) => (value: string) =>
      seal(context.key, {
        app: context.app,
        account: account.id,
        provider: account.provider.name,
        hosts: hosts ?? [],
        expires: context.expires,
        value,
        ...(request === undefined
          ? {}
          : {
              request,
              exposed: [...exposed].sort(),
              ...(field === undefined ? {} : { field }),
              ...(managed === undefined ? {} : { managed }),
            }),
      });
    const fields = yield* Effect.forEach(Object.entries(account.fields), ([name, value]) =>
      (exposed.has(name)
        ? Effect.succeed(value)
        : typeof value === "string"
          ? sealString(name)(value)
          : sealValue(value, sealString(undefined))
      ).pipe(Effect.map((sealed) => [name, sealed] as const)),
    );
    return { ...account, fields: Object.fromEntries(fields) as ResolvedAccount["fields"] };
  });

type Selected = HostAccountSlots[string];
const isMany = (value: Selected): value is Extract<Selected, ReadonlyArray<unknown>> =>
  Array.isArray(value);
const accountsOf = (accounts: HostAccounts) =>
  scopedSlots(accounts).flatMap(([, selected]) => (isMany(selected) ? selected : [selected]));

export const unsealedAccounts = (accounts: HostAccounts): ResolvedAccounts | undefined =>
  accountsOf(accounts).some((account) => account.managed !== undefined) ? undefined : accounts;

export const sealAccounts = (
  accounts: HostAccounts,
  context: { readonly app: string; readonly key: Effect.Effect<CryptoKey> },
): Effect.Effect<ResolvedAccounts> =>
  Effect.gen(function* () {
    const unsealed = unsealedAccounts(accounts);
    if (
      unsealed !== undefined &&
      !accountsOf(accounts).some((account) => account.provider.hosts !== undefined)
    )
      return unsealed;
    const bound = {
      app: context.app,
      key: yield* context.key,
      expires: (yield* Clock.currentTimeMillis) + handleLifetime,
    };
    const sealSlot = (selected: Selected): Effect.Effect<ResolvedAccountSlots[string]> =>
      isMany(selected)
        ? Effect.forEach(selected, (account) => sealAccount(account, bound))
        : sealAccount(selected, bound);
    const sealScope = (slots: HostAccountSlots) =>
      Effect.forEach(Object.entries(slots), ([slot, selected]) =>
        sealSlot(selected).pipe(Effect.map((sealed) => [slot, sealed] as const)),
      ).pipe(Effect.map(Object.fromEntries<ResolvedAccountSlots[string]>));
    const app = yield* sealScope(accounts.app);
    return accounts.user === undefined ? { app } : { app, user: yield* sealScope(accounts.user) };
  });

export const credentialHostMatches = (pattern: string, url: URL) => {
  const separator = pattern.lastIndexOf(":");
  const [name, port] =
    separator === -1 ? [pattern, ""] : [pattern.slice(0, separator), pattern.slice(separator + 1)];
  if (port !== url.port) return false;
  const hostname = url.hostname.toLowerCase();
  if (!name.startsWith("*.")) return hostname === name;
  const suffix = name.slice(1);
  if (!hostname.endsWith(suffix)) return false;
  const label = hostname.slice(0, -suffix.length);
  return label.length > 0 && !label.includes(".");
};

const hostParts = (pattern: string) => {
  const lower = pattern.toLowerCase();
  const separator = lower.lastIndexOf(":");
  const name = separator === -1 ? lower : lower.slice(0, separator);
  return {
    name,
    port: separator === -1 ? "" : lower.slice(separator + 1),
    wildcard: name.startsWith("*."),
  };
};

const narrowerHost = (a: string, b: string) => {
  const [first, second] = [hostParts(a), hostParts(b)];
  if (first.port !== second.port) return undefined;
  if (first.wildcard === second.wildcard)
    return first.name === second.name ? a.toLowerCase() : undefined;
  const [exact, wildcard, pattern] = first.wildcard ? [second, first, b] : [first, second, a];
  const suffix = wildcard.name.slice(1);
  const label = exact.name.slice(0, -suffix.length);
  return exact.name.endsWith(suffix) && label.length > 0 && !label.includes(".")
    ? pattern.toLowerCase()
    : undefined;
};

export const intersectCredentialHosts = (
  first: readonly string[],
  second: readonly string[],
): readonly string[] =>
  [...new Set(first.flatMap((a) => second.flatMap((b) => narrowerHost(a, b) ?? [])))].sort();

const rewritable = (contentType: string | null) => {
  const type = contentType?.split(";")[0]?.trim().toLowerCase();
  if (type === undefined || type === "" || type === "text/event-stream") return undefined;
  if (type === "application/json" || type.endsWith("+json")) return "json" as const;
  if (type === "application/x-www-form-urlencoded") return "form" as const;
  if (type.startsWith("text/")) return "text" as const;
  return undefined;
};

type Body =
  | { readonly complete: true; readonly text: string }
  | { readonly complete: false; readonly stream: ReadableStream<Uint8Array> };

const readBody = async (stream: ReadableStream<Uint8Array>): Promise<Body> => {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    chunks.push(next.value);
    size += next.value.byteLength;
    if (size > credentialBodyLimit) {
      const replay = chunks.slice();
      return {
        complete: false,
        stream: new ReadableStream<Uint8Array>({
          async pull(controller) {
            const chunk = replay.shift();
            if (chunk !== undefined) return controller.enqueue(chunk);
            const rest = await reader.read();
            if (rest.done) controller.close();
            else controller.enqueue(rest.value);
          },
          cancel: (reason) => reader.cancel(reason),
        }),
      };
    }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { complete: true, text: new TextDecoder().decode(bytes) };
};

const handlesIn = (text: string) => [...text.matchAll(handlePattern)].map((match) => match[0]);

const replaceAll = (text: string, values: ReadonlyMap<string, string>) =>
  text.replace(handlePattern, (handle) => values.get(handle) ?? handle);

const encodings = {
  json: (value: string) => JSON.stringify(value).slice(1, -1),
  form: (value: string) => new URLSearchParams({ v: value }).toString().slice(2),
  text: (value: string) => value,
  url: (value: string) => encodeURIComponent(value),
};

const encoded = (values: ReadonlyMap<string, string>, encode: (value: string) => string) =>
  new Map([...values].map(([handle, value]) => [handle, encode(value)]));

const redact = (text: string, handles: ReadonlyMap<string, string>) =>
  [...handles]
    .sort(([, a], [, b]) => b.length - a.length)
    .reduce((current, [handle, value]) => current.split(value).join(handle), text);

const credentialHeaders = new Set(["authorization", "proxy-authorization"]);

const basicDecoded = (header: string) => {
  const match = /^basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(header);
  return match === null ? undefined : Result.getOrUndefined(Base64.decodeString(match[1] ?? ""));
};

const basicCredentials = (header: string, values: ReadonlyMap<string, string>) => {
  const decoded = basicDecoded(header);
  if (decoded === undefined || handlesIn(decoded).length === 0) return header;
  return `Basic ${Base64.encode(replaceAll(decoded, values))}`;
};

type Opened = ReadonlyMap<string, Sealed>;

interface Misplaced {
  readonly provider: string;
  readonly location: string;
}

const anyHandle = new RegExp(handleSource, "u");
const base64Run = /[A-Za-z0-9+/]{16,}={0,2}/gu;
const regExpText = /[.*+?^${}()|[\]\\]/gu;

const base64Readings = (run: string) =>
  [0, 1, 2, 3].flatMap((offset) => {
    const body = run.slice(offset).replace(/=+$/u, "");
    const whole = body.length % 4 === 1 ? body.slice(0, -1) : body;
    return Result.match(Base64.decodeString(whole + "=".repeat((4 - (whole.length % 4)) % 4)), {
      onFailure: () => [],
      onSuccess: (decoded) => [decoded],
    });
  });

const handlesWithin = (text: string) => [
  ...handlesIn(text),
  ...[...text.matchAll(base64Run)].flatMap(([run]) => base64Readings(run).flatMap(handlesIn)),
];

const formDecoded = (text: string) => new URLSearchParams(`v=${text}`).get("v") ?? "";

const fill = (
  placement: Placement,
  received: string,
  owner: Sealed,
  opened: Opened,
): string | undefined => {
  const exposed = new Set(owner.exposed ?? []);
  const key = placementKey(placement);
  const slot = (field: string, text: string) => {
    if (exposed.has(field)) return anyHandle.test(text) ? undefined : text;
    const sealed = opened.get(text);
    return sealed !== undefined &&
      sealed.app === owner.app &&
      sealed.account === owner.account &&
      sealed.field === field &&
      sealed.request?.some((granted) => placementKey(granted) === key) === true
      ? sealed.value
      : undefined;
  };
  const source = (part: PlacementPart) =>
    typeof part === "string"
      ? part.replace(regExpText, "\\$&")
      : isPlacementField(part)
        ? exposed.has(part.field)
          ? "([^]*?)"
          : `(${handleSource})`
        : "([A-Za-z0-9+/]*={0,2})";
  const render = (parts: readonly PlacementPart[], text: string): string | undefined => {
    const match = new RegExp(`^${parts.map(source).join("")}$`, "u").exec(text);
    if (match === null) return undefined;
    let rendered = "";
    let group = 1;
    for (const part of parts) {
      if (typeof part === "string") {
        rendered += part;
        continue;
      }
      const captured = match[group++] ?? "";
      const value = isPlacementField(part)
        ? slot(part.field, captured)
        : Result.match(Base64.decodeString(captured), {
            onFailure: () => undefined,
            onSuccess: (decoded) => {
              const inner = render(part.base64, decoded);
              return inner === undefined ? undefined : Base64.encode(inner);
            },
          });
      if (value === undefined) return undefined;
      rendered += value;
    }
    return rendered;
  };
  return render(placement.value, received);
};

const placeCredentials = (
  url: URL,
  headers: Headers,
  body: string | undefined,
  opened: Opened,
): Result.Result<{ readonly href: string; readonly headers: Headers }, Misplaced> => {
  const placed = (handles: readonly string[]) =>
    handles.flatMap((handle) => {
      const sealed = opened.get(handle);
      return sealed?.request === undefined ? [] : [sealed];
    });
  const misplaced = (handles: readonly string[], location: string) => {
    const [sealed] = placed(handles);
    return sealed === undefined ? undefined : { provider: sealed.provider, location };
  };
  const filled = (
    handles: readonly string[],
    location: Placement["in"],
    name: string,
    received: string,
  ) => {
    for (const owner of placed(handles))
      for (const placement of owner.request ?? [])
        if (placement.in === location && placement.name === name) {
          const value = fill(placement, received, owner, opened);
          if (value !== undefined) return value;
        }
    return undefined;
  };

  const inBody = body === undefined ? undefined : misplaced(handlesIn(body), "request body");
  if (inBody !== undefined) return Result.fail(inBody);
  const bare = new URL(url.href);
  bare.search = "";
  const inUrl = misplaced(handlesIn(bare.href), "URL");
  if (inUrl !== undefined) return Result.fail(inUrl);

  let search = url.search;
  const pairs = url.search.slice(1).split("&");
  for (const [index, pair] of pairs.entries()) {
    const separator = pair.indexOf("=");
    const name = formDecoded(separator === -1 ? pair : pair.slice(0, separator));
    const value = separator === -1 ? "" : formDecoded(pair.slice(separator + 1));
    const inName = misplaced(handlesIn(name), "query parameter names");
    if (inName !== undefined) return Result.fail(inName);
    const handles = handlesWithin(value);
    if (placed(handles).length === 0) continue;
    const rendered = filled(handles, "query", name, value);
    if (rendered === undefined) {
      const refused = misplaced(handles, `${name} query parameter`);
      if (refused !== undefined) return Result.fail(refused);
      continue;
    }
    pairs[index] = `${pair.slice(0, separator)}=${encodeURIComponent(rendered)}`;
    search = `?${pairs.join("&")}`;
  }
  const target = new URL(url.href);
  target.search = search;

  const sent = new Headers();
  for (const [name, value] of headers) {
    const handles = handlesWithin(value);
    if (placed(handles).length === 0) {
      sent.append(name, value);
      continue;
    }
    const rendered = filled(handles, "header", name, value);
    if (rendered === undefined) {
      const refused = misplaced(handles, `${name} header`);
      if (refused !== undefined) return Result.fail(refused);
      continue;
    }
    sent.append(name, rendered);
  }
  return Result.succeed({ href: target.href, headers: sent });
};

const placeManaged = (
  url: URL,
  headers: Headers,
  body: string | undefined,
  opened: Opened,
): Result.Result<Headers, Misplaced> => {
  const managed = (handles: readonly string[]) =>
    handles.flatMap((handle) => {
      const sealed = opened.get(handle);
      return sealed?.managed === undefined ? [] : [sealed];
    });
  const refused = (sealed: Sealed, location: string) =>
    Result.fail({ provider: sealed.provider, location });
  const [inBody] = body === undefined ? [] : managed(handlesIn(body));
  if (inBody !== undefined) return refused(inBody, "request body");
  const [inUrl] = managed([
    ...handlesIn(url.href),
    ...[...url.searchParams.values()].flatMap(handlesWithin),
  ]);
  if (inUrl !== undefined) return refused(inUrl, "URL");
  const filled = new Map<string, string>();
  for (const [name, value] of headers)
    for (const sealed of managed(handlesWithin(value))) {
      const [placement] = sealed.request ?? [];
      const rendered =
        placement?.in === "header" && placement.name === name && sealed.field !== undefined
          ? Result.getOrUndefined(renderPlacement(placement, { [sealed.field]: sealed.value }))
          : undefined;
      if (rendered === undefined || (filled.get(name) ?? rendered) !== rendered)
        return refused(sealed, `${name} header`);
      filled.set(name, rendered);
    }
  if (filled.size === 0) return Result.succeed(headers);
  const sent = new Headers(headers);
  for (const name of credentialHeaders) sent.delete(name);
  for (const [name, value] of filled) sent.set(name, value);
  return Result.succeed(sent);
};

export interface AppEgress {
  readonly refusePrivateAddresses: boolean;
  readonly selfOrigin: string | undefined;
  readonly privateOrigins?: ReadonlyArray<string>;
}

export const allowedPrivateOrigin = (url: URL, egress: AppEgress) =>
  egress.privateOrigins?.includes(url.origin) === true;

const secureTransport = (url: URL, egress: AppEgress) =>
  url.protocol === "https:" ||
  (url.protocol === "http:" && !egress.refusePrivateAddresses && isLoopbackHostname(url.hostname));

const listedPrivateHost = (url: URL, egress: AppEgress) =>
  egress.privateOrigins?.some((origin) => URL.parse(origin)?.hostname === url.hostname) === true;

const egressRefusal = (url: URL, egress: AppEgress) =>
  !egress.refusePrivateAddresses ||
  url.origin === egress.selfOrigin ||
  allowedPrivateOrigin(url, egress) ||
  (!isPrivateHostname(url.hostname) && !listedPrivateHost(url, egress))
    ? undefined
    : new NetworkRefused({ host: url.host, refusal: { reason: "private_address" } });

export interface CredentialOutbound {
  readonly app: string;
  readonly key: CryptoKey;
  readonly egress: AppEgress;
  readonly send: (request: Request) => Promise<Response>;
  readonly hostApi?: HostApiCheck;
}

export const credentialFetch = (request: Request, outbound: CredentialOutbound) =>
  forward(request, outbound)
    .then((response) => hostApiDocument(request, response, outbound.hostApi))
    .catch((error: unknown) => {
      if (Schema.is(NetworkUnreachable)(error)) return networkUnreachableResponse(error);
      throw error;
    });

const hostApiDocument = async (
  request: Request,
  response: Response,
  hostApi: HostApiCheck | undefined,
) => {
  const url = new URL(request.url);
  if (
    hostApi === undefined ||
    request.method !== "GET" ||
    !response.ok ||
    !hostApi.documents.some((document) => {
      const served = new URL(document);
      return served.origin === url.origin && served.pathname === url.pathname;
    })
  )
    return response;
  const body = await response.arrayBuffer();
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", body));
  if (Hex.encode(digest) === hostApi.revision)
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  return hostApiChangingResponse();
};

const sendFailed = (signal: AbortSignal) => (error: unknown) => {
  throw signal.aborted ? error : new NetworkUnreachable();
};

const scrubbed = (error: unknown, values: ReadonlyMap<string, string>) => {
  const forms = [...values].flatMap(([handle, value]) =>
    value === ""
      ? []
      : [...new Set(Object.values(encodings).map((encode) => encode(value)))].map(
          (form) => [form, handle] as const,
        ),
  );
  const scrub = (text: string) =>
    forms
      .toSorted(([a], [b]) => b.length - a.length)
      .reduce((current, [form, handle]) => current.split(form).join(handle), text);
  if (typeof error === "string") return scrub(error);
  if (!(error instanceof Error)) return error;
  const message = scrub(error.message);
  const stack = error.stack === undefined ? undefined : scrub(error.stack);
  if (message === error.message && stack === error.stack) return error;
  const copy = new Error(message);
  copy.name = error.name;
  if (stack !== undefined) copy.stack = stack;
  return copy;
};

const forward = async (request: Request, outbound: CredentialOutbound): Promise<Response> => {
  const url = new URL(request.url);
  const send = (sent: Request) => outbound.send(sent).catch(sendFailed(request.signal));
  const blocked = egressRefusal(url, outbound.egress);
  if (blocked !== undefined) return networkRefusalResponse(blocked);
  const requestHeaders = new Headers(request.headers);
  if (!requestHeaders.has("user-agent")) requestHeaders.set("user-agent", executorUserAgent);
  const kind = request.body === null ? undefined : rewritable(requestHeaders.get("content-type"));
  const body =
    kind === undefined || request.body === null ? undefined : await readBody(request.body);
  const found = new Set([
    ...handlesIn(url.href),
    ...[...url.searchParams.values()].flatMap(handlesWithin),
    ...[...requestHeaders].flatMap(([, value]) => handlesWithin(value)),
    ...(body?.complete === true ? handlesIn(body.text) : []),
  ]);
  if (found.size === 0)
    return send(
      new Request(
        request,
        body === undefined
          ? { headers: requestHeaders }
          : {
              headers: requestHeaders,
              body: body.complete ? body.text : body.stream,
              ...(body.complete ? {} : { duplex: "half" }),
            },
      ),
    ).then(unmarked);
  if (request.method.toUpperCase() === "TRACE")
    return networkRefusalResponse(
      new NetworkRefused({
        host: url.host,
        refusal: { reason: "credential_method", method: "TRACE" },
      }),
    );

  const now = Date.now();
  const values = new Map<string, string>();
  const opened = new Map<string, Sealed>();
  for (const handle of found) {
    const sealed = await Effect.runPromise(open(outbound.key, handle));
    if (Option.isNone(sealed) || sealed.value.app !== outbound.app)
      return networkRefusalResponse(
        new NetworkRefused({ host: url.host, refusal: { reason: "credential_app" } }),
      );
    const { provider, hosts, expires, value } = sealed.value;
    if (expires <= now)
      return networkRefusalResponse(
        new NetworkRefused({
          host: url.host,
          refusal: { reason: "credential_expired", provider },
        }),
      );
    if (!hosts.some((host) => credentialHostMatches(host, url)))
      return networkRefusalResponse(
        new NetworkRefused({
          host: url.host,
          refusal: { reason: "credential_host", provider, allowedHosts: hosts },
        }),
      );
    if (sealed.value.request !== undefined && !secureTransport(url, outbound.egress))
      return networkRefusalResponse(
        new NetworkRefused({
          host: url.host,
          refusal: { reason: "credential_transport", provider },
        }),
      );
    values.set(handle, value);
    opened.set(handle, sealed.value);
  }

  try {
    const searched = body?.complete === true ? body.text : undefined;
    const placed = Result.flatMap(placeManaged(url, requestHeaders, searched, opened), (headers) =>
      [...opened.values()].some((sealed) => sealed.request !== undefined)
        ? placeCredentials(url, headers, searched, opened)
        : Result.succeed({ href: url.href, headers }),
    );
    if (Result.isFailure(placed))
      return networkRefusalResponse(
        new NetworkRefused({
          host: url.host,
          refusal: { reason: "credential_placement", ...placed.failure },
        }),
      );
    const anywhere = new Map(
      [...opened].flatMap(([handle, sealed]) =>
        sealed.request === undefined ? [[handle, sealed.value] as const] : [],
      ),
    );
    const headers = new Headers();
    for (const [name, value] of placed.success.headers) {
      const credentials = credentialHeaders.has(name) ? basicCredentials(value, anywhere) : value;
      headers.set(name, replaceAll(credentials, anywhere));
    }
    const text =
      body?.complete === true
        ? replaceAll(body.text, encoded(anywhere, encodings[kind ?? "text"]))
        : undefined;
    if (text !== undefined) headers.delete("content-length");
    const response = await send(
      new Request(replaceAll(placed.success.href, encoded(anywhere, encodings.url)), {
        method: request.method,
        headers,
        body: text ?? (body?.complete === false ? body.stream : request.body),
        redirect: "manual",
        signal: request.signal,
        ...(text === undefined && request.body !== null ? { duplex: "half" } : {}),
      }),
    );
    return redactResponse(response, values);
  } catch (error) {
    throw scrubbed(error, values);
  }
};

const marks = [
  [networkRefusalStatus, networkRefusalHeader],
  [networkUnreachableStatus, networkUnreachableHeader],
  [hostApiChangingStatus, hostApiChangingHeader],
] as const;
const forged = (response: Response) =>
  marks.find(([status, header]) => response.status === status && response.headers.has(header))?.[1];

const unmarked = (response: Response) => {
  const mark = forged(response);
  if (mark === undefined) return response;
  const headers = new Headers(response.headers);
  headers.delete(mark);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};

const redactResponse = async (response: Response, values: ReadonlyMap<string, string>) => {
  if (response.status === 101) return response;
  const headers = new Headers();
  for (const [name, value] of response.headers) headers.append(name, redact(value, values));
  const mark = forged(response);
  if (mark !== undefined) headers.delete(mark);
  const kind =
    response.body === null ? undefined : rewritable(response.headers.get("content-type"));
  if (kind === undefined || response.body === null)
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  const body = await readBody(response.body);
  const text = body.complete ? redact(body.text, encoded(values, encodings[kind])) : undefined;
  if (text !== undefined) headers.delete("content-length");
  return new Response(text ?? (body.complete ? null : body.stream), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};
