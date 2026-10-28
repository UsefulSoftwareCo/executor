/** Prototype authenticated TLS issuer client. No retry, redirect, public URL, or token export. */
import { Redacted } from "effect";
import { privateCanonicalJson, type PrivateInvocationRpc } from "apps/contracts";
import type { PrivateBinding, PrivateInvocationVerifier } from "../contracts/private-invocation.ts";

export async function privateDigest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(privateCanonicalJson(value));
  if (bytes.byteLength > 262144) throw new Error("Private invocation refused");
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (n) =>
    n.toString(16).padStart(2, "0"),
  ).join("");
}
export interface PrivateIssuerOptions {
  readonly namespace: string;
  readonly redeemUrl: string;
  readonly forwardUrl: string;
  readonly authentication?: Redacted.Redacted<string>;
  /** Host transport only; Node mTLS adapter supplies the actual authenticated HTTPS client. */
  readonly request?: (url: string, init: RequestInit) => Promise<Response>;
  readonly bindingId: string;
}
const denied = () => new Error("Private invocation refused; possible writes remain unknown");
const object = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
/** Native fetch verifies TLS using the host trust store. Operators provision endpoint and auth. */
export const httpPrivateInvocationIssuer = (
  options: PrivateIssuerOptions,
): PrivateInvocationVerifier => {
  const endpoint = (value: string) => {
    const u = new URL(value);
    if (u.protocol !== "https:" || u.username || u.password || u.hash || u.search) throw denied();
    return u.href;
  };
  if (options.authentication === undefined && options.request === undefined) throw denied();
  const send = options.request ?? fetch;
  const redeemUrl = endpoint(options.redeemUrl),
    forwardUrl = endpoint(options.forwardUrl);
  if (
    !options.namespace ||
    !options.bindingId ||
    new URL(redeemUrl).origin !== new URL(forwardUrl).origin
  )
    throw denied();
  const post = async (url: string, body: unknown, signal: AbortSignal): Promise<unknown> => {
    try {
      const response = await send(url, {
        method: "POST",
        redirect: "error",
        cache: "no-store",
        headers: {
          "content-type": "application/json",
          ...(options.authentication === undefined
            ? {}
            : { authorization: `Bearer ${Redacted.value(options.authentication)}` }),
        },
        body: privateCanonicalJson(body),
        signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
      });
      if (!response.ok || !response.body) throw denied();
      const reader = response.body.getReader();
      let size = 0;
      const chunks: Uint8Array[] = [];
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 262144) throw denied();
          chunks.push(value);
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      const bytes = new Uint8Array(size);
      let at = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, at);
        at += chunk.byteLength;
      }
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      throw denied();
    }
  };
  return Object.freeze({
    namespace: options.namespace,
    redeem: async (
      reference: Redacted.Redacted<string>,
      binding: PrivateBinding,
      signal: AbortSignal,
    ): Promise<PrivateInvocationRpc> => {
      const ref = Redacted.value(reference);
      if (!/^[\x21-\x7e]{1,512}$/.test(ref) || signal.aborted) throw denied();
      // Issuer persists/reserves against its own origin/recipient binding. Never derive identity here.
      const receipt = await post(redeemUrl, { version: 1, reference: ref, binding }, signal);
      if (
        !object(receipt) ||
        receipt.version !== 1 ||
        typeof receipt.lease !== "string" ||
        !/^[\x21-\x7e]{1,512}$/.test(receipt.lease) ||
        typeof receipt.invocationId !== "string" ||
        typeof receipt.operationId !== "string" ||
        !receipt.operationId ||
        typeof receipt.expiresAt !== "number" ||
        !Number.isSafeInteger(receipt.expiresAt) ||
        receipt.expiresAt <= Date.now() ||
        receipt.expiresAt > Date.now() + 60000
      )
        throw denied();
      const { lease, operationId, expiresAt } = receipt;
      let required = false,
        forwarded = false;
      return async (command) => {
        if (
          signal.aborted ||
          Date.now() >= expiresAt ||
          !object(command) ||
          !object(command.privateInvocation)
        )
          throw denied();
        const c = command.privateInvocation;
        if (c.operation === "require") {
          if (required || c.operationId !== operationId) throw denied();
          required = true;
          return null;
        }
        if (
          c.operation !== "forward" ||
          !required ||
          forwarded ||
          c.bindingId !== options.bindingId
        )
          throw denied();
        // Reserve before any await. Snapshot before digest/HTTP so mutable app data cannot race it.
        forwarded = true;
        const input = JSON.parse(privateCanonicalJson(c.input));
        if ((await privateDigest(input)) !== binding.inputDigest) throw denied();
        const response = await post(
          forwardUrl,
          { version: 1, lease, binding, bindingId: c.bindingId, input },
          signal,
        );
        if (!object(response) || response.version !== 1 || !("result" in response)) throw denied();
        privateCanonicalJson(response.result);
        const secrets = [
          ref,
          lease,
          ...(options.authentication === undefined ? [] : [Redacted.value(options.authentication)]),
        ];
        const containsPrivate = (v: unknown): boolean =>
          typeof v === "string"
            ? secrets.some((secret) => !secret || v.includes(secret))
            : Array.isArray(v)
              ? v.some(containsPrivate)
              : object(v)
                ? Object.entries(v).some(
                    ([k, value]) => containsPrivate(k) || containsPrivate(value),
                  )
                : false;
        if (containsPrivate(response.result)) throw denied();
        return response.result;
      };
    },
  });
};
