/**
 * What an app's `fetch` sees when Executor's app network failed to get an answer from the service.
 * The platform's own `fetch` rejects when its network fails, and so does an app's: a host's network
 * failure must never reach app code as a status the service could have sent.
 *
 * The outbound network cannot always reject the app's `fetch` itself (Cloud's is an HTTP handler
 * that answers every request), so it answers with a marked response, and the module the runner
 * loads first in every app isolate turns the mark into the rejection. Both are host code: every
 * app build, whatever framework version it bundles, gets the same behavior.
 *
 * Only Executor's own failure to send is evidence here. A response is the service's answer, or an
 * answer the service's side could have produced, and reaches the app unchanged.
 */
import { Schema } from "effect";
import { RecordedMessage } from "@executor-js/utils/recorded-message";
import { hostApiChangingCode } from "../contracts/host-api.ts";

/**
 * Executor's app network failed before the service answered an app's request. The request may have
 * reached the service: the connection can fail after the service received it. It names no host or
 * URL: the app knows which request it sent, and the message reaches telemetry when the app does not
 * catch the rejection.
 */
export class NetworkUnreachable extends Schema.TaggedError<NetworkUnreachable>()(
  "NetworkUnreachable",
  {},
) {
  override get message() {
    return "Executor's connection to the service failed before it answered. The request may have reached the service.";
  }
  /** Fixed text: telemetry records the message itself. */
  get [RecordedMessage]() {
    return this.message;
  }
}

/**
 * The mark of a response Executor's app network returned because its send failed. The header holds
 * the rejection's message, URI-encoded. Only that network sets it: it removes the header from a
 * service's response with this status.
 */
export const networkUnreachableStatus = 502;
export const networkUnreachableHeader = "x-executor-unreachable";

/**
 * What an app's `fetch` rejects with when Cloudflare refuses a request beyond the call's
 * subrequest allowance. The platform's own error only names the limit and its configuration,
 * which apps cannot change, and app HTTP clients report it as a transport failure.
 */
const subrequestLimitMessage =
  "Cloudflare refused this request: the call reached its limit on outbound requests (subrequests). " +
  "Calls that run at the same time in an app with a database share one limit. Make fewer requests " +
  "in one call, for example by caching or batching them, or spread the work over several calls.";

/** The marked response the app isolate turns into a rejected `fetch`. */
export const networkUnreachableResponse = (unreachable: NetworkUnreachable) =>
  new Response(null, {
    status: networkUnreachableStatus,
    statusText: "Not answered",
    headers: { [networkUnreachableHeader]: encodeURIComponent(unreachable.message) },
  });

/**
 * The mark of a response Executor's app network returned instead of the host API's document,
 * because the document's revision is not the one the app's cache belongs to; see `HostApiCheck`.
 * The app's `fetch` rejects with `hostApiChangingCode` and this message, so the app keeps nothing
 * and its caller is told to retry. Only that network sets it, as for `networkUnreachableHeader`.
 */
export const hostApiChangingStatus = 503;
export const hostApiChangingHeader = "x-executor-api-changing";
export const hostApiChangingMessage =
  "Executor's API is changing (a deploy is in progress). Retry shortly.";

/** The marked response the app isolate turns into a rejected `fetch` with `hostApiChangingCode`. */
export const hostApiChangingResponse = () =>
  new Response(null, {
    status: hostApiChangingStatus,
    statusText: "API changing",
    headers: { [hostApiChangingHeader]: "1", "retry-after": "1" },
  });

/**
 * The header naming the host's incoming request an app request counts against; see
 * `AppInvocation.outboundGroup`. The runner names a call's group in the headers it starts the call
 * with, the bridge runs that call in `outboundGroup`, and the first module sets the header on each
 * request the call sends, replacing any value app code gave it. Only a host that names groups
 * (Cloud) sets it, and its network removes it before anything else reads the request, so it never
 * reaches a service. A value the host did not name is ignored.
 */
export const outboundGroupHeader = "x-executor-outbound-group";

/**
 * The first module of every app isolate. Before app code loads, it replaces the platform's `fetch`
 * wherever the global scope holds it (workerd defines it on the scope's prototype), so a marked
 * response rejects with a `TypeError`, as the platform's `fetch` does when its network fails. Every
 * other response is returned unchanged. The platform's `fetch` and the built-ins that read the mark
 * are captured here, so app code can neither reach the unwrapped `fetch` nor hide the mark. A
 * refused host API document rejects the same way, with `hostApiChangingCode` as its `code`. A
 * rejection for the subrequest limit is replaced by `SubrequestLimitReached`, which says what the
 * limit means for the call and keeps the platform's error as its cause.
 */
export const appNetworkModule = `
import { AsyncLocalStorage } from "node:async_hooks";
const { apply, defineProperty, getOwnPropertyDescriptor, getPrototypeOf } = Reflect;
/** The group of the call running; see \`outboundGroupHeader\`. */
export const outboundGroup = new AsyncLocalStorage();
const accessor = (type, name) => {
  for (let scope = type.prototype; ; scope = getPrototypeOf(scope)) {
    const own = getOwnPropertyDescriptor(scope, name);
    if (own !== undefined) return own.get;
  }
};
const status = accessor(Response, "status");
const headers = accessor(Response, "headers");
const body = accessor(Response, "body");
const header = Headers.prototype.get;
const setHeader = Headers.prototype.set;
const Outgoing = Request;
const outgoingHeaders = accessor(Request, "headers");
const groupStore = outboundGroup.getStore;
/** The arguments \`fetch(input, init)\` sends with, its request named for the call's group. */
const grouped = (input, init) => {
  const group = apply(groupStore, outboundGroup, []);
  if (typeof group !== "string") return [input, init];
  const request = new Outgoing(input, init);
  apply(setHeader, apply(outgoingHeaders, request, []), [${JSON.stringify(outboundGroupHeader)}, group]);
  return [request];
};
const cancel = ReadableStream.prototype.cancel;
const decode = decodeURIComponent;
const Rejection = TypeError;
const PlatformError = Error;
const test = RegExp.prototype.test;
const limited = /^Too many subrequests\\b/;
class SubrequestLimitReached extends PlatformError {
  constructor(cause) {
    super(${JSON.stringify(subrequestLimitMessage)}, { cause });
    this.name = "SubrequestLimitReached";
  }
}
const platformFetch = globalThis.fetch;
async function fetch(input, init) {
  let response;
  try {
    response = await apply(platformFetch, globalThis, grouped(input, init));
  } catch (error) {
    if (error instanceof PlatformError && apply(test, limited, [error.message])) throw new SubrequestLimitReached(error);
    throw error;
  }
  const code = apply(status, response, []);
  const message = code === ${networkUnreachableStatus} ? apply(header, apply(headers, response, []), [${JSON.stringify(networkUnreachableHeader)}]) : null;
  const changing = code === ${hostApiChangingStatus} && apply(header, apply(headers, response, []), [${JSON.stringify(hostApiChangingHeader)}]) !== null;
  if (message === null && !changing) return response;
  const stream = apply(body, response, []);
  if (stream !== null) await apply(cancel, stream, []);
  if (message !== null) throw new Rejection(decode(message));
  const rejection = new Rejection(${JSON.stringify(hostApiChangingMessage)});
  defineProperty(rejection, "code", { value: ${JSON.stringify(hostApiChangingCode)}, enumerable: true, writable: true, configurable: true });
  throw rejection;
}
for (let scope = globalThis; scope !== null; scope = getPrototypeOf(scope)) {
  const own = getOwnPropertyDescriptor(scope, "fetch");
  if (own !== undefined) defineProperty(scope, "fetch", { ...own, value: fetch });
}`;
