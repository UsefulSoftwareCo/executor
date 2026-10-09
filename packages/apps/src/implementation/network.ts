/** Typed refusals and option checks for the fetch app code receives from the framework. */
import { Effect, Schema } from "effect";
import type { HttpClientResponse } from "effect/http";
import { invocationFetch } from "@executor-js/telemetry";
import {
  FetchOptionUnsupported,
  type NetworkRefused,
  NetworkRefusedHeader,
  networkRefusalHeader,
  networkRefusalStatus,
  RestrictedFetchOption,
  supportedFetchOptions,
} from "../contracts/network.ts";

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/**
 * The marked header of a response Executor's app network answered in place of the service.
 * Only that network sets the mark, so a marked header is trusted; one that does not decode is a
 * defect, never a service's answer.
 */
const refusalHeader = (status: number, header: string | null | undefined) =>
  status === networkRefusalStatus && header !== null && header !== undefined ? header : undefined;

/** Fail with the refusal a protocol helper's response carries, or continue to its own handling. */
export const failOnNetworkRefusal = (
  response: HttpClientResponse.HttpClientResponse,
): Effect.Effect<void, NetworkRefused> => {
  const header = refusalHeader(response.status, response.headers[networkRefusalHeader]);
  return header === undefined
    ? Effect.void
    : Schema.decodeUnknownEffect(NetworkRefusedHeader)(header).pipe(
        Effect.orDie,
        Effect.flatMap(Effect.fail),
      );
};

/** The first restricted RequestInit option whose value the app runtime does not implement. */
const unsupportedOption = (init: RequestInit | undefined): FetchOptionUnsupported | undefined => {
  for (const option of RestrictedFetchOption.literals) {
    const value = init?.[option];
    const supported = supportedFetchOptions[option];
    if (value !== undefined && !supported.includes(value))
      return new FetchOptionUnsupported({ option, value: String(value), supported });
  }
  return undefined;
};

/**
 * The fetch app code receives as `ctx.fetch`. It rejects a RequestInit value the app runtime
 * would reject, naming the option, on every host. A request Executor's app network refused
 * rejects with `NetworkRefused`: the service never answered, so there is no response to return.
 */
export const appFetch =
  (fetch: Fetch): Fetch =>
  async (input, init) => {
    const unsupported = unsupportedOption(init);
    if (unsupported !== undefined) throw unsupported;
    // oxlint-disable-next-line executor/authored-code-through-adapter -- the invocation's fetch
    const response = await fetch(input, init);
    const header = refusalHeader(response.status, response.headers.get(networkRefusalHeader));
    if (header === undefined) return response;
    // oxlint-disable-next-line executor/authored-code-through-adapter -- Streams
    await response.body?.cancel();
    throw Schema.decodeUnknownSync(NetworkRefusedHeader)(header);
  };

/** The invocation's correlated, cancellable fetch, as app code receives it. */
export const appInvocationFetch = (signal: AbortSignal) =>
  invocationFetch(signal).pipe(Effect.map(appFetch));
