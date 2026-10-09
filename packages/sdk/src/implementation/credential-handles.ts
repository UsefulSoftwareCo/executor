/**
 * Credential handles. A provider that declares hosts never gives app code its secret values. The
 * runner seals each secret string into a handle bound to the app, the provider's hosts and an
 * expiry. The app's outbound network opens the handles it finds in a request, and substitutes
 * their values only when the request's target is one of those hosts. Values the service echoes
 * back are replaced with their handles before the app reads the response.
 *
 * Sealing uses a key held only by the runner and the outbound network, never by app code. A
 * handle therefore carries its own value: the outbound needs no lookup, so it works from any
 * isolate, after the invocation's request context is gone, and for accounts not saved yet.
 */
import { Clock, Effect, Option, Result, Schema } from "effect";
import { Base64, Hex } from "effect/encoding";
import {
  NetworkRefused,
  networkRefusalHeader,
  networkRefusalResponse,
  networkRefusalStatus,
  type ResolvedAccount,
  type ResolvedAccounts,
} from "apps/contracts";
import { isPrivateHostname } from "@executor-js/utils/url-policy";
import {
  NetworkUnreachable,
  networkUnreachableHeader,
  networkUnreachableResponse,
  networkUnreachableStatus,
} from "./app-network.ts";

/** How long a handle stays usable. Every invocation, and every workflow step, seals afresh. */
const handleLifetime = 60 * 60 * 1000;
/** The largest request or response body searched for handles or echoed values. */
export const credentialBodyLimit = 1024 * 1024;

const handlePrefix = "exsec_";
/** Lowercase hex between a prefix and a terminator that hex never contains. */
const handlePattern = /exsec_([0-9a-f]+)_/g;
const additionalData = new TextEncoder().encode("executor.credential-handle.v1");

/** What a handle carries. Only the key's holders can read or forge it. */
const Sealed = Schema.Struct({
  app: Schema.String,
  account: Schema.String,
  provider: Schema.String,
  hosts: Schema.Array(Schema.String),
  expires: Schema.Number,
  value: Schema.String,
});
type Sealed = typeof Sealed.Type;
const sealedJson = Schema.fromJsonString(Sealed);

/** The runner's and outbound network's shared key, derived from a host secret. */
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
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = new TextEncoder().encode(Schema.encodeSync(sealedJson)(sealed));
    const ciphertext = new Uint8Array(
      await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData }, key, plaintext),
    );
    const bytes = new Uint8Array(iv.length + ciphertext.length);
    bytes.set(iv);
    bytes.set(ciphertext, iv.length);
    return `${handlePrefix}${Hex.encode(bytes)}_`;
  });

/** A handle this key did not seal, or that was altered, opens to nothing. */
const open = (key: CryptoKey, hex: string) =>
  Effect.gen(function* () {
    const bytes = Result.getOrUndefined(Hex.decode(hex));
    if (bytes === undefined || bytes.length <= 12) return Option.none<Sealed>();
    const plaintext = yield* Effect.tryPromise(() =>
      crypto.subtle.decrypt(
        { name: "AES-GCM", iv: bytes.slice(0, 12), additionalData },
        key,
        bytes.slice(12),
      ),
    ).pipe(Effect.option);
    if (Option.isNone(plaintext)) return Option.none<Sealed>();
    return Schema.decodeUnknownOption(sealedJson)(new TextDecoder().decode(plaintext.value));
  });

/** Every string in a field value, sealed; numbers, booleans and structure stay readable. */
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
  account: ResolvedAccount,
  context: { readonly app: string; readonly key: CryptoKey; readonly expires: number },
) =>
  Effect.gen(function* () {
    const hosts = account.provider.hosts;
    // A provider without hosts has not opted in: its app code reads real values.
    if (hosts === undefined) return account;
    const method = Object.hasOwn(account.provider.auth, account.method)
      ? account.provider.auth[account.method]
      : undefined;
    const exposed = new Set([...(method?.plain ?? []), ...(method?.raw ?? [])]);
    const sealString = (value: string) =>
      seal(context.key, {
        app: context.app,
        account: account.id,
        provider: account.provider.name,
        hosts,
        expires: context.expires,
        value,
      });
    const fields = yield* Effect.forEach(Object.entries(account.fields), ([name, value]) =>
      (exposed.has(name) ? Effect.succeed(value) : sealValue(value, sealString)).pipe(
        Effect.map((sealed) => [name, sealed] as const),
      ),
    );
    // SAFETY: sealing replaces strings with strings and keeps every other JSON value.
    return { ...account, fields: Object.fromEntries(fields) as ResolvedAccount["fields"] };
  });

type Selected = ResolvedAccounts[string];
const isMany = (value: Selected): value is Extract<Selected, ReadonlyArray<unknown>> =>
  Array.isArray(value);

/**
 * Replace the secret fields of accounts whose providers declare hosts with handles. The key is
 * derived only when some account needs sealing.
 */
export const sealAccounts = (
  accounts: ResolvedAccounts,
  context: { readonly app: string; readonly key: Effect.Effect<CryptoKey> },
) =>
  Effect.gen(function* () {
    const sealed = Object.values(accounts)
      .flatMap((selected) => (isMany(selected) ? selected : [selected]))
      .some((account) => account.provider.hosts !== undefined);
    if (!sealed) return accounts;
    const bound = {
      app: context.app,
      key: yield* context.key,
      expires: (yield* Clock.currentTimeMillis) + handleLifetime,
    };
    const sealSlot = (selected: Selected): Effect.Effect<Selected> =>
      isMany(selected)
        ? Effect.forEach(selected, (account) => sealAccount(account, bound))
        : sealAccount(selected, bound);
    const slots = yield* Effect.forEach(Object.entries(accounts), ([slot, selected]) =>
      sealSlot(selected).pipe(Effect.map((sealed) => [slot, sealed] as const)),
    );
    return Object.fromEntries(slots);
  });

/**
 * Whether a declared credential host matches a request's target. A host without a port matches
 * only the scheme's default port; `*.example.com` matches exactly one more label.
 */
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

/**
 * Read a body up to the limit. A longer body is returned as a stream that replays what was read,
 * so it is still sent or returned unchanged.
 */
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
  /** A value inside a JSON string. */
  json: (value: string) => JSON.stringify(value).slice(1, -1),
  /** A value inside an `application/x-www-form-urlencoded` pair. */
  form: (value: string) => new URLSearchParams({ v: value }).toString().slice(2),
  text: (value: string) => value,
  /** A value inside a URL component. */
  url: (value: string) => encodeURIComponent(value),
};

const encoded = (values: ReadonlyMap<string, string>, encode: (value: string) => string) =>
  new Map([...values].map(([handle, value]) => [handle, encode(value)]));

/** Replace echoed secret values with their handles. Longer values first, so none is split. */
const redact = (text: string, handles: ReadonlyMap<string, string>) =>
  [...handles]
    .sort(([, a], [, b]) => b.length - a.length)
    .reduce((current, [handle, value]) => current.split(value).join(handle), text);

const credentialHeaders = new Set(["authorization", "proxy-authorization"]);

/** The decoded user and password of a Basic credential header. */
const basicDecoded = (header: string) => {
  const match = /^basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(header);
  return match === null ? undefined : Result.getOrUndefined(Base64.decodeString(match[1] ?? ""));
};

/** Basic credentials are base64 in the header, so handles inside them are decoded first. */
const basicCredentials = (header: string, values: ReadonlyMap<string, string>) => {
  const decoded = basicDecoded(header);
  if (decoded === undefined || handlesIn(decoded).length === 0) return header;
  return `Basic ${Base64.encode(replaceAll(decoded, values))}`;
};

/** Which destinations Executor refuses before an app's request reaches the host's network. */
export interface AppEgress {
  /**
   * Refuse private, loopback and internal destinations, named by the URL. The host's network
   * must refuse their addresses too: a public name can resolve to a private address.
   */
  readonly refusePrivateAddresses: boolean;
  /** The instance's own origin, which the host reaches without the network. Never refused. */
  readonly selfOrigin: string | undefined;
}

const egressRefusal = (url: URL, egress: AppEgress) =>
  !egress.refusePrivateAddresses ||
  url.origin === egress.selfOrigin ||
  !isPrivateHostname(url.hostname)
    ? undefined
    : new NetworkRefused({ host: url.host, refusal: { reason: "private_address" } });

export interface CredentialOutbound {
  /** The app whose Worker sent the request. Bound by the runner, never by app code. */
  readonly app: string;
  readonly key: CryptoKey;
  readonly egress: AppEgress;
  /** Send the rewritten request on the host's network. It rejects when that network fails. */
  readonly send: (request: Request) => Promise<Response>;
}

/**
 * Send one app request, substituting the handles it carries when its target is allowed, and
 * returning a response with echoed values replaced by their handles. A refused request is never
 * sent; app code receives Executor's refusal response instead, see `networkRefusalResponse`.
 * When the host's network fails to send it, app code receives the marked response its isolate
 * turns into a rejected `fetch`, see `networkUnreachableResponse`, never a status the service could
 * send. Any other failure is Executor's own and rejects.
 */
export const credentialFetch = (request: Request, outbound: CredentialOutbound) =>
  forward(request, outbound).catch((error: unknown) => {
    if (Schema.is(NetworkUnreachable)(error)) return networkUnreachableResponse(error);
    throw error;
  });

/**
 * The host's network failed to send. The app's own cancellation keeps its error, so the app's
 * `fetch` rejects with the abort it asked for.
 */
const sendFailed = (signal: AbortSignal) => (error: unknown) => {
  throw signal.aborted ? error : new NetworkUnreachable();
};

const forward = async (request: Request, outbound: CredentialOutbound): Promise<Response> => {
  const url = new URL(request.url);
  const send = (sent: Request) => outbound.send(sent).catch(sendFailed(request.signal));
  const blocked = egressRefusal(url, outbound.egress);
  if (blocked !== undefined) return networkRefusalResponse(blocked);
  const kind = request.body === null ? undefined : rewritable(request.headers.get("content-type"));
  const body =
    kind === undefined || request.body === null ? undefined : await readBody(request.body);
  const found = new Set([
    ...handlesIn(url.href),
    ...[...request.headers].flatMap(([name, value]) => [
      ...handlesIn(value),
      ...(credentialHeaders.has(name) ? handlesIn(basicDecoded(value) ?? "") : []),
    ]),
    ...(body?.complete === true ? handlesIn(body.text) : []),
  ]);
  const unchanged = () =>
    send(
      body === undefined
        ? request
        : new Request(request, {
            body: body.complete ? body.text : body.stream,
            ...(body.complete ? {} : { duplex: "half" }),
          }),
    ).then(unmarked);
  if (found.size === 0) return unchanged();

  const values = new Map<string, string>();
  for (const handle of found) {
    const sealed = await Effect.runPromise(
      open(outbound.key, handle.slice(handlePrefix.length, -1)),
    );
    if (Option.isNone(sealed) || sealed.value.app !== outbound.app)
      return networkRefusalResponse(
        new NetworkRefused({ host: url.host, refusal: { reason: "credential_app" } }),
      );
    const { provider, hosts, expires, value } = sealed.value;
    if (expires <= Date.now())
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
    values.set(handle, value);
  }

  const headers = new Headers();
  for (const [name, value] of request.headers) {
    const credentials = credentialHeaders.has(name) ? basicCredentials(value, values) : value;
    headers.set(name, replaceAll(credentials, values));
  }
  const text =
    body?.complete === true
      ? replaceAll(body.text, encoded(values, encodings[kind ?? "text"]))
      : undefined;
  if (text !== undefined) headers.delete("content-length");
  const response = await send(
    new Request(replaceAll(url.href, encoded(values, encodings.url)), {
      method: request.method,
      headers,
      body: text ?? (body?.complete === false ? body.stream : request.body),
      // A secret never follows a redirect here; the app's fetch sends each hop back to be checked.
      redirect: "manual",
      signal: request.signal,
      ...(text === undefined && request.body !== null ? { duplex: "half" } : {}),
    }),
  );
  return redactResponse(response, values);
};

/**
 * Only Executor's network marks a refusal or its own failure to send. A service's response
 * carrying a mark loses it, so app code and the framework's helpers never present a service's
 * text as Executor's refusal, and a service cannot make the app's `fetch` reject.
 */
const marks = [
  [networkRefusalStatus, networkRefusalHeader],
  [networkUnreachableStatus, networkUnreachableHeader],
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

/** Replace values the service echoed with their handles, in headers and bounded text bodies. */
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
