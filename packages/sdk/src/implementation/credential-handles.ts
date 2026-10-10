/**
 * Credential handles. A provider that declares hosts never gives app code its secret values. The
 * runner seals each secret string into a handle bound to the app, the provider's hosts and an
 * expiry. The app's outbound network opens the handles it finds in a request, and substitutes
 * their values only when the request's target is one of those hosts. Values the service echoes
 * back are replaced with their handles before the app reads the response.
 *
 * A method that declares placements (`request`) narrows this further: each handle also carries its
 * field and the method's placements, and the outbound substitutes it only where a header or query
 * parameter matches one of those templates exactly, and only over HTTPS. A placed handle anywhere
 * else, such as a body an allowed host would store and return, is refused. Without placements a
 * handle is substituted anywhere in the request, as before placements existed.
 *
 * Placed handles have their own format (`exsec2_`, sealed with other associated data), which an
 * outbound from before placements neither finds nor opens: it sends such a handle as inert text,
 * never the value. Handles without placements keep the original format (`exsec_`), so every
 * outbound still substitutes them.
 *
 * A managed account's credential was issued to the instance operator's own OAuth client. Every one
 * of its strings is sealed as a placed handle, whatever the method exposes, carrying the operator's
 * one header placement and pinned hosts. The outbound sends it only in that header, replacing
 * whatever app code wrote there and any `authorization` or `proxy-authorization` header, and
 * refuses the request when the handle is anywhere else; see `placeManaged`.
 *
 * Sealing uses a key held only by the runner and the outbound network, never by app code. A
 * handle therefore carries its own value: the outbound needs no lookup, so it works from any
 * isolate, after the invocation's request context is gone, and for accounts not saved yet. App
 * code cannot alter what a handle carries: an altered handle does not decrypt and is refused.
 *
 * Echo redaction covers response headers and complete JSON, form and text bodies within the body
 * limit, where a value appears as it was substituted. Any other response, such as a streamed,
 * binary or oversized body, or a value the service transformed, reaches app code as sent, so the
 * declared hosts remain the trust boundary: a service on one of them is trusted not to hand back
 * the credential it was sent. Two rules keep Executor itself from handing it back: a request that
 * carries a handle is never sent with `TRACE`, which asks the service to echo the request, and the
 * outbound's own error messages never contain a substituted value.
 */
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
  renderPlacement,
  type ResolvedAccount,
  type ResolvedAccounts,
} from "apps/contracts";
import { isLoopbackHostname, isPrivateHostname } from "@executor-js/utils/url-policy";
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

/** Lowercase hex between a prefix and a terminator that hex never contains. */
const handleSource = "exsec2?_[0-9a-f]+_";
const handlePattern = new RegExp(handleSource, "gu");

/** What a handle carries. Only the key's holders can read or forge it. */
const Sealed = Schema.Struct({
  app: Schema.String,
  account: Schema.String,
  provider: Schema.String,
  hosts: Schema.Array(Schema.String),
  expires: Schema.Number,
  value: Schema.String,
  /** Where the value may be substituted. Only placed handles carry it; see `formats`. */
  request: Schema.optionalKey(Placements),
  /** The account field the value is, when it can fill a placement. Nested values have none. */
  field: Schema.optionalKey(Schema.String),
  /**
   * The account's fields app code holds as real values. A placement copies them as written.
   * Every other field in a placement must be a handle of this account and that field.
   */
  exposed: Schema.optionalKey(Schema.Array(Schema.String)),
  /** A managed account's value; see `placeManaged`. Only placed handles carry it. */
  managed: Schema.optionalKey(Schema.Literal(true)),
});
type Sealed = typeof Sealed.Type;

/**
 * The two handle formats. `anywhere` handles carry no placements and are substituted anywhere in
 * a request to their hosts. `placed` handles carry their placements and go only there, over
 * HTTPS. Each format has its own prefix and associated data, so a handle of one cannot be passed
 * off as the other, and an outbound from before placements, which knows only `exsec_`, never
 * opens a placed handle.
 */
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

/** A handle this key did not seal, or that was altered, opens to nothing. */
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
  { managed, ...account }: HostAccount,
  context: { readonly app: string; readonly key: CryptoKey; readonly expires: number },
): Effect.Effect<ResolvedAccount> =>
  Effect.gen(function* () {
    const hosts = account.provider.hosts;
    // A provider without hosts has not opted in: its app code reads real values. A managed
    // account always reaches app code sealed.
    if (hosts === undefined && managed === undefined) return account;
    const method = Object.hasOwn(account.provider.auth, account.method)
      ? account.provider.auth[account.method]
      : undefined;
    // `plain()` and `raw()` do not apply to a managed account.
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
          : // Strings nested in a field fill no placement: placed, they are refused anywhere.
            sealValue(value, sealString(undefined))
      ).pipe(Effect.map((sealed) => [name, sealed] as const)),
    );
    // SAFETY: sealing replaces strings with strings and keeps every other JSON value.
    return { ...account, fields: Object.fromEntries(fields) as ResolvedAccount["fields"] };
  });

type Selected = HostAccounts[string];
const isMany = (value: Selected): value is Extract<Selected, ReadonlyArray<unknown>> =>
  Array.isArray(value);
const accountsOf = (accounts: HostAccounts) =>
  Object.values(accounts).flatMap((selected) => (isMany(selected) ? selected : [selected]));

/**
 * The accounts as they are, for a bundle that reads every field as a real value. Undefined when
 * one is managed: a managed credential reaches app code only sealed.
 */
export const unsealedAccounts = (accounts: HostAccounts): ResolvedAccounts | undefined =>
  accountsOf(accounts).some((account) => account.managed !== undefined) ? undefined : accounts;

/**
 * Replace the secret fields of accounts whose providers declare hosts, and every string of a
 * managed account, with handles. The key is derived only when some account needs sealing.
 */
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
    const sealSlot = (selected: Selected): Effect.Effect<ResolvedAccounts[string]> =>
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

/** A credential host pattern's parts; see `credentialHostMatches`. */
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

/** The narrower of two host patterns when every host one allows the other allows too. */
const narrowerHost = (a: string, b: string) => {
  const [first, second] = [hostParts(a), hostParts(b)];
  // A pattern without a port matches only the default one, so ports must be the same.
  if (first.port !== second.port) return undefined;
  if (first.wildcard === second.wildcard)
    // Two wildcards each match exactly one more label, so only equal ones overlap.
    return first.name === second.name ? a.toLowerCase() : undefined;
  const [exact, wildcard, pattern] = first.wildcard ? [second, first, b] : [first, second, a];
  const suffix = wildcard.name.slice(1);
  const label = exact.name.slice(0, -suffix.length);
  return exact.name.endsWith(suffix) && label.length > 0 && !label.includes(".")
    ? pattern.toLowerCase()
    : undefined;
};

/**
 * The hosts both lists allow, as patterns: an exact host one list names and the other's wildcard
 * matches stays exact, and `*.example.com` within `*.example.com` stays a wildcard. Wildcards
 * match one label and patterns without a port only the default port, as in `credentialHostMatches`,
 * so `*.example.com` and `*.api.example.com` share no host, and neither do `example.com` and
 * `example.com:8443`.
 */
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

type Opened = ReadonlyMap<string, Sealed>;

/** Where a placed handle was found outside its placements; see `credential_placement`. */
interface Misplaced {
  readonly provider: string;
  readonly location: string;
}

const anyHandle = new RegExp(handleSource, "u");
const base64Run = /[A-Za-z0-9+/]{16,}={0,2}/gu;
const regExpText = /[.*+?^${}()|[\]\\]/gu;

/**
 * The text a run of base64 characters encodes, read from each of its first four characters. A
 * template's literal text can end in base64 characters, such as `key=` before an encoded part, so
 * the encoded part need not start where the run does.
 */
const base64Readings = (run: string) =>
  [0, 1, 2, 3].flatMap((offset) => {
    const body = run.slice(offset).replace(/=+$/u, "");
    const whole = body.length % 4 === 1 ? body.slice(0, -1) : body;
    return Result.match(Base64.decodeString(whole + "=".repeat((4 - (whole.length % 4)) % 4)), {
      onFailure: () => [],
      onSuccess: (decoded) => [decoded],
    });
  });

/**
 * The handles in a header or query parameter value, including those inside base64 text such as
 * Basic credentials or a template's `base64` part.
 */
const handlesWithin = (text: string) => [
  ...handlesIn(text),
  ...[...text.matchAll(base64Run)].flatMap(([run]) => base64Readings(run).flatMap(handlesIn)),
];

/** A query component as a form decoder reads it; malformed escapes stay as written. */
const formDecoded = (text: string) => new URLSearchParams(`v=${text}`).get("v") ?? "";

/**
 * `received` with real values in place of its handles when it is exactly `placement`, rendered by
 * the account that sealed `owner`. A secret field's slot holds exactly one handle of that account
 * and field whose placements include this one; an exposed field's slot holds what the app wrote,
 * without a handle. Base64 is decoded, matched and encoded again. Anything else is undefined.
 */
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

/**
 * Substitute placed handles where a header or query parameter matches one of their placements, or
 * name where one was found instead. The candidates for a value are the placements its own handles
 * carry for that location; unplaced handles are left for the substitution that predates placements.
 */
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

/**
 * Send each managed handle the request carries in its placement's header, the one the operator
 * configured, or name where one was found instead. That header's whole value becomes the
 * operator's, whatever app code wrote there, and the request's other credential headers are
 * removed, so a managed credential is the only one it carries. A managed handle anywhere else, or a
 * second managed credential for the same header, refuses the request.
 */
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

/**
 * Whether placed credentials may travel to `url`: over HTTPS, or over plain HTTP to a loopback
 * address when the operator lets apps reach private addresses, which only local development and
 * test instances do. Loopback traffic never leaves the machine.
 */
const secureTransport = (url: URL, egress: AppEgress) =>
  url.protocol === "https:" ||
  (url.protocol === "http:" && !egress.refusePrivateAddresses && isLoopbackHostname(url.hostname));

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

/**
 * `error` with every value substituted into the request replaced by its handle, as each value was
 * written into the URL, a header or a body. The outbound's own failures, such as a URL or header
 * the network rejects, can quote what was sent; app code and logs read them only this way.
 */
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
  const kind = request.body === null ? undefined : rewritable(request.headers.get("content-type"));
  const body =
    kind === undefined || request.body === null ? undefined : await readBody(request.body);
  const found = new Set([
    ...handlesIn(url.href),
    ...[...url.searchParams.values()].flatMap(handlesWithin),
    ...[...request.headers].flatMap(([, value]) => handlesWithin(value)),
    ...(body?.complete === true ? handlesIn(body.text) : []),
  ]);
  if (found.size === 0)
    return send(
      body === undefined
        ? request
        : new Request(request, {
            body: body.complete ? body.text : body.stream,
            ...(body.complete ? {} : { duplex: "half" }),
          }),
    ).then(unmarked);
  // TRACE asks the service to send the request back, credentials included.
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

  // The outbound's own failures from here on may quote what it substituted.
  try {
    // Managed handles go only in the operator's header, placed handles only where a placement
    // matches, and every other handle anywhere.
    const searched = body?.complete === true ? body.text : undefined;
    const placed = Result.flatMap(
      placeManaged(url, request.headers, searched, opened),
      (headers) =>
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
        // A secret never follows a redirect here; the app's fetch sends each hop back to be checked.
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
