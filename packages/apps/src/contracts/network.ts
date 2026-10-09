/**
 * What app code sees when Executor's app network refuses a request, and the fetch options the
 * app runtime accepts. A refusal is Executor's decision, not the service's: the request never
 * left Executor. App code runs on workerd, Cloudflare's runtime, on every host.
 */
import { Schema } from "effect";

/**
 * Why Executor's app network refused a request.
 * - `private_address`: the destination is a private, loopback or internal address, and this
 *   instance lets apps reach only public addresses.
 * - `credential_host`: the request carries a credential handle, and its provider does not allow
 *   the destination host.
 * - `credential_app`: the request carries a credential handle that is not valid for this app.
 * - `credential_expired`: the request carries an expired credential handle.
 */
export const NetworkRefusal = Schema.Union([
  Schema.Struct({ reason: Schema.Literal("private_address") }),
  Schema.Struct({
    reason: Schema.Literal("credential_host"),
    /** The provider of the credential handle the request carried. */
    provider: Schema.String,
    /** The hosts that provider's credentials may reach; empty when it declares none. */
    allowedHosts: Schema.Array(Schema.String),
  }),
  Schema.Struct({ reason: Schema.Literal("credential_app") }),
  Schema.Struct({
    reason: Schema.Literal("credential_expired"),
    /** The provider of the expired credential handle. */
    provider: Schema.String,
  }),
]);
export type NetworkRefusal = typeof NetworkRefusal.Type;

/** Executor's app network refused a request before it reached the service. */
export class NetworkRefused extends Schema.TaggedError<NetworkRefused>()("NetworkRefused", {
  /** The refused destination, with its port when the URL names one. */
  host: Schema.String,
  refusal: NetworkRefusal,
}) {
  override get message() {
    const refusal = this.refusal;
    switch (refusal.reason) {
      case "private_address":
        return `Executor refused a request to ${this.host}: apps on this instance can reach only public addresses, and ${this.host} is a private, loopback or internal address. The request was not sent.`;
      case "credential_host":
        return refusal.allowedHosts.length === 0
          ? `Executor refused this request: ${refusal.provider} credentials cannot be sent to ${this.host}: the provider declares no hosts.`
          : `Executor refused this request: ${refusal.provider} credentials cannot be sent to ${this.host}. The provider allows: ${refusal.allowedHosts.join(", ")}.`;
      case "credential_app":
        return "Executor refused this request: it carries a credential handle that is not valid for this app. Use the account fields this invocation received.";
      case "credential_expired":
        return `Executor refused this request: it carries an expired ${refusal.provider} credential handle. Use the account fields this invocation received.`;
    }
  }
}

/**
 * A refusal reaches app code as a response with this status and header. The header holds the
 * encoded `NetworkRefused`, so it survives responses without a body, such as to `HEAD`; the
 * body repeats it as JSON with its message. `ctx.fetch` and the framework's protocol helpers
 * raise it as `NetworkRefused`; the platform's global `fetch` returns the response. Only
 * Executor's app network sets the mark: it removes the header from a service's 421 response.
 */
export const networkRefusalStatus = 421;
export const networkRefusalHeader = "x-executor-refused";

/** The header's value: the refusal as JSON, URI-encoded so any provider name fits in a header. */
export const NetworkRefusedHeader = Schema.StringFromUriComponent.pipe(
  Schema.decodeTo(Schema.fromJsonString(NetworkRefused)),
);

const encodeRefusal = Schema.encodeSync(NetworkRefused);
const encodeRefusalHeader = Schema.encodeSync(NetworkRefusedHeader);

/** The response Executor's app network returns in place of a request it refused. */
export const networkRefusalResponse = (refused: NetworkRefused) =>
  new Response(JSON.stringify({ ...encodeRefusal(refused), message: refused.message }), {
    status: networkRefusalStatus,
    statusText: "Refused by Executor",
    headers: {
      "content-type": "application/json; charset=utf-8",
      [networkRefusalHeader]: encodeRefusalHeader(refused),
    },
  });

/** RequestInit options the app runtime restricts. */
export const RestrictedFetchOption = Schema.Literals(["redirect", "cache", "integrity"]);
export type RestrictedFetchOption = typeof RestrictedFetchOption.Type;

/** The values the app runtime accepts for each restricted option. */
export const supportedFetchOptions: Readonly<Record<RestrictedFetchOption, ReadonlyArray<string>>> =
  {
    redirect: ["follow", "manual"],
    cache: ["no-store", "no-cache"],
    integrity: [""],
  };

/** `ctx.fetch` was given a standard RequestInit value the app runtime does not implement. */
export class FetchOptionUnsupported extends Schema.TaggedError<FetchOptionUnsupported>()(
  "FetchOptionUnsupported",
  {
    option: RestrictedFetchOption,
    value: Schema.String,
    supported: Schema.Array(Schema.String),
  },
) {
  override get message() {
    const supported = this.supported.map((value) => JSON.stringify(value)).join(" or ");
    return `fetch option ${this.option}: ${JSON.stringify(this.value)} is not supported by Executor's app runtime. Use ${supported}, or omit ${this.option}.${this.advice}`;
  }

  /** What to do instead, when the standard value has an equivalent the runtime supports. */
  private get advice() {
    switch (this.option) {
      case "redirect":
        return this.value === "error"
          ? ` To reject redirects, send redirect: "manual" and treat a 3xx response as the error.`
          : "";
      case "cache":
        return "";
      case "integrity":
        return " To check a digest, read the body and hash it with crypto.subtle.digest.";
    }
  }
}
