import { Schema } from "effect";
import { RecordedMessage } from "@executor-js/utils/recorded-message";
import { hostApiChangingCode } from "../contracts/host-api.ts";

export class NetworkUnreachable extends Schema.TaggedError<NetworkUnreachable>()(
  "NetworkUnreachable",
  {},
) {
  override get message() {
    return "Executor's connection to the service failed before it answered. The request may have reached the service.";
  }
  get [RecordedMessage]() {
    return this.message;
  }
}

export const networkUnreachableStatus = 502;
export const networkUnreachableHeader = "x-executor-unreachable";

const subrequestLimitMessage =
  "Cloudflare refused this request: the call reached its limit on outbound requests (subrequests). " +
  "Calls that run at the same time in an app with a database share one limit. Make fewer requests " +
  "in one call, for example by caching or batching them, or spread the work over several calls.";

export const networkUnreachableResponse = (unreachable: NetworkUnreachable) =>
  new Response(null, {
    status: networkUnreachableStatus,
    statusText: "Not answered",
    headers: { [networkUnreachableHeader]: encodeURIComponent(unreachable.message) },
  });

export const hostApiChangingStatus = 503;
export const hostApiChangingHeader = "x-executor-api-changing";
export const hostApiChangingMessage =
  "Executor's API is changing (a deploy is in progress). Retry shortly.";

export const hostApiChangingResponse = () =>
  new Response(null, {
    status: hostApiChangingStatus,
    statusText: "API changing",
    headers: { [hostApiChangingHeader]: "1", "retry-after": "1" },
  });

export const outboundGroupHeader = "x-executor-outbound-group";

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
