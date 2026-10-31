/** Fail closed when bounded public display text contains a credential or a standard encoding. */
import { Predicate } from "effect";
import { Base64, Base64Url, Hex } from "effect/encoding";

const maxDisplayCharacters = 32_768;
const maxDisplayStrings = 128;
const maxCredentialNodes = 16_384;
const maxCredentialStrings = 1_024;
const maxDepth = 32;
/** A match this long is a leak. Shorter ones may be chance, so only the colliding item is hidden. */
const leakLength = 8;

/** Field names the account's method declares with `plain()`; those are public, not secrets. */
const plainFields = (account: unknown): ReadonlySet<string> => {
  if (!Predicate.hasProperty(account, "provider") || !Predicate.hasProperty(account, "method"))
    return new Set();
  const { provider, method } = account;
  if (typeof method !== "string" || !Predicate.hasProperty(provider, "auth")) return new Set();
  const auth = provider.auth;
  if (!Predicate.isObject(auth) || !Object.hasOwn(auth, method)) return new Set();
  const declared = auth[method];
  const plain = Predicate.hasProperty(declared, "plain") ? declared.plain : undefined;
  return new Set(Array.isArray(plain) ? plain.filter(Predicate.isString) : []);
};

/** Bound work independently of credential size. Oversized secrets cannot fit in these strings. */
const displaySecrets = (accounts: unknown, maximum: number, ref?: string) => {
  const found = new Set<string>();
  let visited = 0,
    characters = 0,
    overflow = false;
  const visit = (value: unknown, depth: number): void => {
    if (overflow) return;
    if (++visited > maxCredentialNodes || depth > maxDepth) {
      overflow = true;
      return;
    }
    if (typeof value === "string") {
      if (value.length > 0 && value.length <= maximum) {
        characters += value.length;
        if (characters > 262_144) {
          overflow = true;
          return;
        }
        found.add(value);
      }
      if (found.size > maxCredentialStrings) overflow = true;
    } else if (Array.isArray(value)) {
      for (const item of value) {
        visit(item, depth + 1);
        if (overflow) break;
      }
    } else if (Predicate.isObject(value)) {
      for (const key in value) {
        if (!Object.hasOwn(value, key)) continue;
        visit(value[key], depth + 1);
        if (overflow) break;
      }
    }
  };
  if (Predicate.isObject(accounts)) {
    for (const scope of [accounts["app"], accounts["user"]]) {
      if (!Predicate.isObject(scope)) continue;
      for (const key in scope) {
        if (!Object.hasOwn(scope, key)) continue;
        if (++visited > maxCredentialNodes) {
          overflow = true;
          break;
        }
        const slot = scope[key];
        for (const account of Array.isArray(slot) ? slot : [slot]) {
          if (++visited > maxCredentialNodes) {
            overflow = true;
            break;
          }
          const fields = Predicate.hasProperty(account, "fields") ? account.fields : undefined;
          if (Predicate.isObject(fields)) {
            const plain = plainFields(account);
            for (const name in fields) {
              if (!Object.hasOwn(fields, name) || plain.has(name)) continue;
              visit(fields[name], 1);
              if (overflow) break;
            }
          } else visit(fields, 0);
          if (overflow) break;
        }
        if (overflow) break;
      }
    }
  }
  if (ref !== undefined) visit(ref, 0);
  return overflow ? undefined : found;
};

const lenientUtf8 = new TextDecoder();
/** Invalid bytes become U+FFFD, so one bad escape can't hide the valid ones beside it. */
const percentDecoded = (text: string) =>
  text.replace(/(?:%[0-9a-f]{2})+/gi, (part) =>
    lenientUtf8.decode(Uint8Array.from(part.slice(1).split("%"), (byte) => parseInt(byte, 16))),
  );

type Exposure = "leak" | "collision" | undefined;

/** Checks UTF-8 base64/base64url, percent escapes and case-insensitive hex, plus raw values. */
const exposures = (
  strings: readonly string[],
  accounts: unknown,
  ref?: string,
): readonly Exposure[] | undefined => {
  if (strings.length > maxDisplayStrings) return undefined;
  let total = 0,
    maximum = 0;
  for (const text of strings) {
    total += text.length;
    maximum = Math.max(maximum, text.length);
    if (total > maxDisplayCharacters) return undefined;
  }
  const secrets = displaySecrets(accounts, maximum, ref);
  if (secrets === undefined) return undefined;
  const result: Exposure[] = strings.map(() => undefined);
  const decoded = strings.map(percentDecoded);
  const escaped = strings.map((text) =>
    text.replace(/%[0-9a-f]{2}/gi, (part) => part.toUpperCase()),
  );
  const lower = strings.map((text) => text.toLowerCase());
  const mark = (forms: readonly string[], texts: readonly (readonly string[])[]) => {
    for (const form of forms)
      for (const variant of texts)
        variant.forEach((text, index) => {
          if (result[index] === "leak" || !text.includes(form)) return;
          result[index] = form.length >= leakLength ? "leak" : "collision";
        });
  };
  for (const secret of secrets) {
    const bytes = new TextEncoder().encode(secret);
    const base64 = Base64.encode(bytes);
    const url = Base64Url.encode(bytes);
    let component: string, uri: string;
    try {
      component = encodeURIComponent(secret);
      uri = encodeURI(secret);
    } catch {
      return undefined;
    }
    const percent = Array.from(
      bytes,
      (byte) => "%" + byte.toString(16).padStart(2, "0").toUpperCase(),
    ).join("");
    mark([secret], [strings, decoded]);
    mark([component, uri, percent], [escaped]);
    mark([base64, base64.replace(/=+$/, ""), url, url.replace(/=+$/, "")], [strings]);
    mark([Hex.encode(bytes)], [lower]);
  }
  return result;
};

/** Public account identity and status, as a provider or app-owned check returns it. */
export interface AccountDisplay {
  readonly accountInfo?: { readonly [field: string]: string | undefined };
  readonly status?: {
    readonly badges: readonly { readonly label: string; readonly tone: string }[];
    readonly meters: readonly {
      readonly label: string;
      readonly detail?: string;
      readonly resetsAt?: string;
    }[];
    readonly stats: readonly { readonly label: string; readonly value: string }[];
  };
}

/**
 * The display with every item that collides with a short credential removed, or undefined when
 * any string carries a credential or the input exceeds the bounds. Removing a colliding item keeps
 * the rest of the result, since "a" in "Available" or "61" for hex "a" is usually chance.
 */
export const privateAccountDisplay = <A extends AccountDisplay>(
  value: A,
  accounts: unknown,
  ref?: string,
): A | undefined => {
  const info = Object.entries(value.accountInfo ?? {}).filter(
    (entry): entry is [string, string] => entry[1] !== undefined,
  );
  const badges = value.status?.badges ?? [];
  const meters = value.status?.meters ?? [];
  const stats = value.status?.stats ?? [];
  const items: (readonly string[])[] = [
    ...info.map(([, text]) => [text]),
    ...badges.map((badge) => [badge.label, badge.tone]),
    ...meters.map((meter) => [meter.label, meter.detail ?? "", meter.resetsAt ?? ""]),
    ...stats.map((stat) => [stat.label, stat.value]),
  ];
  const found = exposures(items.flat(), accounts, ref);
  if (found === undefined || found.includes("leak")) return undefined;
  let at = 0;
  const shown = items.map((texts) => !found.slice(at, (at += texts.length)).includes("collision"));
  // Items were listed info, badges, meters, stats; take them back in the same order.
  let index = 0;
  const keep = <T>(list: readonly T[]) => list.filter(() => shown[index++]);
  const accountInfo = Object.fromEntries(keep(info));
  const status = value.status && {
    ...value.status,
    badges: keep(badges),
    meters: keep(meters),
    stats: keep(stats),
  };
  return {
    ...value,
    ...(value.accountInfo === undefined ? {} : { accountInfo }),
    ...(status === undefined ? {} : { status }),
  };
};

/** Check bounded instruction and error strings before exposing a driver result. */
export const privateAccountStrings = (value: unknown, accounts: unknown, ref?: string): boolean => {
  const strings: string[] = [];
  let nodes = 0;
  const visit = (item: unknown, depth: number): boolean => {
    if (++nodes > maxCredentialNodes || depth > maxDepth) return false;
    if (typeof item === "string") strings.push(item);
    else if (Array.isArray(item)) {
      for (const child of item) if (!visit(child, depth + 1)) return false;
    } else if (Predicate.isObject(item)) {
      for (const [key, child] of Object.entries(item)) {
        strings.push(key);
        if (!visit(child, depth + 1)) return false;
      }
    }
    return strings.length <= maxDisplayStrings;
  };
  if (!visit(value, 0)) return false;
  const found = exposures(strings, accounts, ref);
  return found !== undefined && found.every((entry) => entry === undefined);
};
