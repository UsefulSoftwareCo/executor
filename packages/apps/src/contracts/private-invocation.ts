/** Prototype v1. This facade contains no serializable authority. */
export interface PrivatePermit {
  /** Forward the unchanged input through one fixed host binding, once. */
  readonly forward: (bindingId: string, input: unknown) => Promise<unknown>;
}
/** Invocation-local host authority; unavailable in factories and ordinary calls. */
export interface PrivateInvocation {
  /** Require the issuer-owned exact operation before requesting its fixed forward. */
  readonly require: (operationId: string) => Promise<PrivatePermit>;
}
/** Host-only invocation RPC, never a public Request field. */
export type PrivateInvocationRpc = (command: unknown) => Promise<unknown>;

/** RFC8785 integer-only I-JSON subset shared with the paired issuer. Floats/unsafe integers refuse. */
export function privateCanonicalJson(value: unknown): string {
  const seen = new Set<object>();
  const string = (v: string) => {
    for (let i = 0; i < v.length; i++) {
      const c = v.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff) {
        const n = v.charCodeAt(++i);
        if (!(n >= 0xdc00 && n <= 0xdfff)) throw new Error("Unsupported I-JSON");
      } else if (c >= 0xdc00 && c <= 0xdfff) throw new Error("Unsupported I-JSON");
    }
    return JSON.stringify(v);
  };
  const encode = (v: unknown, depth: number): string => {
    if (depth > 64) throw new Error("Unsupported I-JSON");
    if (v === null) return "null";
    if (typeof v === "boolean") return v ? "true" : "false";
    if (typeof v === "string") return string(v);
    // ECMAScript number serialization is the RFC 8785 algorithm. No nonfinite fallback.
    if (typeof v === "number" && Number.isSafeInteger(v)) return JSON.stringify(v);
    if (typeof v !== "object" || seen.has(v)) throw new Error("Unsupported I-JSON");
    seen.add(v);
    try {
      if (Array.isArray(v)) {
        if (Object.keys(v).length !== v.length) throw new Error("Unsupported I-JSON");
        return (
          "[" +
          Array.from({ length: v.length }, (_, i) => {
            const d = Object.getOwnPropertyDescriptor(v, String(i));
            if (!d || !("value" in d)) throw new Error("Unsupported I-JSON");
            return encode(d.value, depth + 1);
          }).join(",") +
          "]"
        );
      }
      if (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null)
        throw new Error("Unsupported I-JSON");
      if (Object.getOwnPropertySymbols(v).length) throw new Error("Unsupported I-JSON");
      return (
        "{" +
        Object.keys(v)
          .sort()
          .map((k) => {
            const d = Object.getOwnPropertyDescriptor(v, k);
            if (!d || !("value" in d)) throw new Error("Unsupported I-JSON");
            return string(k) + ":" + encode(d.value, depth + 1);
          })
          .join(",") +
        "}"
      );
    } finally {
      seen.delete(v);
    }
  };
  return encode(value, 0);
}
