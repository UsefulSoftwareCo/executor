/** Native Node host mTLS, never an app binding, issuer or test server. */
import { Agent, request } from "node:https";
import { Redacted } from "effect";
import { httpPrivateInvocationIssuer, type PrivateIssuerOptions } from "./private-invocation.ts";

export interface PrivateInvocationTls {
  readonly certificate: Redacted.Redacted<string>;
  readonly privateKey: Redacted.Redacted<string>;
  readonly certificateAuthority: Redacted.Redacted<string>;
}
/** Operator retains credential custody. Call close() with the owned development/server lifetime. */
export const nodePrivateInvocationIssuer = (
  options: Omit<PrivateIssuerOptions, "request">,
  tls: PrivateInvocationTls,
) => {
  const agent = new Agent({
    keepAlive: false,
    maxSockets: 1,
    maxTotalSockets: 1,
    rejectUnauthorized: true,
    cert: Redacted.value(tls.certificate),
    key: Redacted.value(tls.privateKey),
    ca: Redacted.value(tls.certificateAuthority),
  });
  const send = (url: string, init: RequestInit): Promise<Response> =>
    new Promise((resolve, reject) => {
      if (init.method !== "POST" || typeof init.body !== "string" || !init.signal) {
        reject(new Error("Private HTTPS transport refused"));
        return;
      }
      const body = init.body;
      const req = request(
        new URL(url),
        {
          method: "POST",
          agent,
          signal: init.signal,
          headers: Object.fromEntries(new Headers(init.headers).entries()),
        },
        (response) => {
          const chunks: Buffer[] = [];
          let size = 0;
          response.on("data", (chunk: Buffer) => {
            size += chunk.byteLength;
            if (size > 262144) {
              response.destroy(new Error("Private HTTPS response exceeded limit"));
              return;
            }
            chunks.push(chunk);
          });
          response.on("error", reject);
          response.on("end", () => {
            const headers = new Headers();
            for (const [name, value] of Object.entries(response.headers)) {
              if (typeof value === "string") headers.set(name, value);
              else if (Array.isArray(value)) for (const item of value) headers.append(name, item);
            }
            // Native HTTPS never follows redirects. The shared client refuses every non-2xx response.
            try {
              resolve(
                new Response(new Uint8Array(Buffer.concat(chunks)), {
                  status: response.statusCode ?? 502,
                  headers,
                }),
              );
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      req.on("error", reject);
      req.end(body);
    });
  try {
    return Object.freeze({
      verifier: httpPrivateInvocationIssuer({ ...options, request: send }),
      close: () => agent.destroy(),
    });
  } catch (error) {
    agent.destroy();
    throw error;
  }
};
