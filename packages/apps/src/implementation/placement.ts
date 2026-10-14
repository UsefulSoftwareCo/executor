/**
 * Authoring credential placements. A method's `request` callback runs once, when the provider is
 * declared, with an opaque reference for each of the method's fields. It returns placements built
 * from `header` or `query` and a value from `t`, `base64` and references; the result is stored
 * as data. A reference is not a string: an untagged template literal fails when it is evaluated.
 */
import {
  Placement,
  type PlacementPart,
  type PlacementText,
  normalizePlacements,
  placementFields,
  renderPlacement,
} from "../contracts/placement.ts";
import { Result, Schema } from "effect";
import type { AccountRequest, FieldExposure } from "../contracts/provider.ts";

const misuse = (name: string) =>
  `${name} is a credential placement, not a string. Build placement values with t\`...\`, such as t\`Bearer \${token}\`, instead of an untagged template literal or string concatenation.`;

/** Throw when JavaScript turns a placement into a string, so untagged templates fail. */
class NotAString {
  readonly #described: string;
  constructor(described: string) {
    this.#described = described;
  }
  [Symbol.toPrimitive](): never {
    throw new TypeError(misuse(this.#described));
  }
  toString(): never {
    throw new TypeError(misuse(this.#described));
  }
  toJSON(): never {
    throw new TypeError(misuse(this.#described));
  }
}

/** A reference to one of the method's account fields, given to its `request` callback. */
export class FieldRef<Name extends string = string> extends NotAString {
  readonly field: Name;
  constructor(field: Name) {
    super(`The field reference ${JSON.stringify(field)}`);
    this.field = field;
  }
}

/** A value template built with `t` or `base64`. */
export class PlacementValue extends NotAString {
  readonly parts: readonly PlacementPart[];
  constructor(parts: readonly PlacementPart[]) {
    super("A t`...` value");
    this.parts = parts;
  }
}

/** What a template may interpolate: literal text, a field reference or another value. */
export type PlacementInput = string | FieldRef | PlacementValue;

const partsOf = (input: unknown): readonly PlacementPart[] => {
  if (typeof input === "string") return input === "" ? [] : [input];
  if (input instanceof FieldRef) return [{ field: input.field }];
  if (input instanceof PlacementValue) return input.parts;
  throw new TypeError(
    `A credential placement interpolates text, a field reference, t\`...\` or base64(...), not ${typeof input}.`,
  );
};

/** Adjacent literal text joins, so equal templates have equal data. */
const joined = (parts: readonly PlacementPart[]) =>
  parts.reduce<PlacementPart[]>((all, part) => {
    const last = all.at(-1);
    if (typeof part === "string" && typeof last === "string") all[all.length - 1] = last + part;
    else all.push(part);
    return all;
  }, []);

/** A value template: literal text with interpolated field references and values. */
export const t = (
  strings: TemplateStringsArray,
  ...values: readonly PlacementInput[]
): PlacementValue =>
  new PlacementValue(
    joined(
      strings.flatMap((text, index) => [
        ...partsOf(text),
        ...(index < values.length ? partsOf(values[index]) : []),
      ]),
    ),
  );

/** Base64 of a value's UTF-8 bytes, such as the `user:password` of Basic credentials. */
export const base64 = (value: PlacementInput): PlacementValue => {
  const inner = partsOf(value).map((part): PlacementText => {
    if (typeof part === "object" && "base64" in part)
      throw new TypeError("base64(...) cannot contain another base64(...).");
    return part;
  });
  if (inner.length === 0) throw new TypeError("base64(...) needs a value.");
  return new PlacementValue([{ base64: inner }]);
};

const value = (input: unknown) => {
  const parts = partsOf(input);
  if (parts.length === 0) throw new TypeError("A credential placement needs a value.");
  return joined(parts);
};

/** Send a value as the whole value of this header. The name is case-insensitive. */
export const header = (name: string, input: PlacementInput): Placement => ({
  in: "header",
  name: name.toLowerCase(),
  value: value(input),
});

/** Send a value as the whole value of this query parameter. */
export const query = (name: string, input: unknown): Placement => ({
  in: "query",
  name,
  value: value(input),
});

/** `Authorization: Bearer <token>`. */
export const bearer = (token: FieldRef): Placement => header("authorization", t`Bearer ${token}`);

/** `Authorization: Basic base64(<user>:<password>)`. */
export const basic = (user: PlacementInput, password: PlacementInput): Placement =>
  header("authorization", t`Basic ${base64(t`${user}:${password}`)}`);

/** The field references a `request` callback receives, by field name. */
export type FieldRefs<Name extends string> = { readonly [Key in Name]: FieldRef<Key> };

/** How a method declares its placements: called once with its field references. */
export type RequestPlacements<Name extends string> = (
  fields: FieldRefs<Name>,
) => Placement | readonly Placement[];

/**
 * Run a method's `request` callback once and check its placements. Every reference names one of
 * the method's fields, no `raw()` field appears, and each placement references a secret field.
 */
export const declarePlacements = (
  method: string,
  names: readonly string[],
  exposure: Readonly<Record<string, FieldExposure>> | undefined,
  request: RequestPlacements<string>,
): readonly Placement[] => {
  const declared = new Set(names);
  const refs = new Proxy(Object.fromEntries(names.map((name) => [name, new FieldRef(name)])), {
    get: (target, key) => {
      if (typeof key === "string" && !declared.has(key))
        throw new TypeError(
          `The ${method} request references "${key}", which is not one of its fields: ${names.join(", ")}.`,
        );
      return Reflect.get(target, key);
    },
  });
  const returned: unknown = request(refs);
  const placements = Array.isArray(returned) ? returned : [returned];
  if (placements.length === 0) throw new TypeError(`The ${method} request declares no placements.`);
  if (!placements.every(Schema.is(Placement)))
    throw new TypeError(
      `The ${method} request must return header(...) or query(...) placements, or an array of them.`,
    );
  for (const placement of placements) {
    const fields = placementFields(placement);
    for (const field of fields) {
      if (!declared.has(field))
        throw new TypeError(
          `The ${method} request references "${field}", which is not one of its fields: ${names.join(", ")}.`,
        );
      if (exposure?.[field] === "raw")
        throw new TypeError(
          `The ${method} request references the raw() field "${field}". App code reads raw fields as real values, so they are never placed; remove raw() or the reference.`,
        );
    }
    if (![...fields].some((field) => exposure?.[field] === undefined))
      throw new TypeError(
        `The ${method} request's ${placement.in} ${placement.name} references no secret field. A placement places a secret: reference a field that is not plain() or raw().`,
      );
  }
  return normalizePlacements(placements);
};

/** Error text when a method has no placements to render. */
const undeclared = (method: string) =>
  `The ${method} account declares no request. Declare where its credentials go with request, such as request: ({ token }) => bearer(token), to use headers() and url().`;

/**
 * Give a bound account `headers()` and `url()`, rendering the placements the host granted with the
 * fields app code holds. They are not enumerable, so the account's JSON is unchanged.
 */
export const withPlacements = <
  Account extends { readonly method: string; readonly fields: unknown },
>(
  account: Account,
  placements: readonly Placement[] | undefined,
) => {
  const fields = (
    typeof account.fields === "object" && account.fields !== null ? account.fields : {}
  ) as Readonly<Record<string, unknown>>;
  const render = (placement: Placement) =>
    Result.getOrThrowWith(
      renderPlacement(placement, fields),
      (error) => new TypeError(error.message),
    );
  const declared = () => {
    if (placements === undefined || placements.length === 0)
      throw new TypeError(undeclared(account.method));
    return placements;
  };
  // SAFETY: both members of AccountRequest are defined here.
  return Object.defineProperties(account, {
    headers: {
      enumerable: false,
      value: () =>
        Object.fromEntries(
          declared()
            .filter((placement) => placement.in === "header")
            .map((placement) => [placement.name, render(placement)]),
        ),
    },
    url: {
      enumerable: false,
      value: (input: string | URL) => {
        const url = new URL(input);
        for (const placement of declared())
          if (placement.in === "query") url.searchParams.set(placement.name, render(placement));
        return url.href;
      },
    },
  }) as Account & AccountRequest;
};
