/**
 * Resolved-address enforcement for native hosts. `parseDestination` classifies the URL a
 * user supplied; this classifies the addresses that URL actually resolves to, so a public name
 * that points into private space is refused before the socket opens. Every request the client
 * makes passes the check, so a redirect hop is checked the same way as the first request.
 */
import { lookup as systemLookup, type LookupAddress, type LookupAllOptions } from "node:dns";
import type { LookupFunction } from "node:net";
import { isLoopbackAddress, isPublicAddress, type UrlPolicy } from "./url-policy.ts";

/** The one resolver capability this module needs. `node:dns`'s `lookup` supplies it. */
export type AddressLookup = (
  hostname: string,
  options: LookupAllOptions,
  callback: (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void,
) => void;

/** Report the name only. The address of an internal service is not something to hand back. */
export class DestinationRefused extends Error {
  constructor(hostname: string) {
    super(`${hostname} resolves to an address this deployment may not reach`);
    this.name = "DestinationRefused";
  }
}

/**
 * An operator exception names a whole origin, but a connection knows only the hostname. The
 * exact origin is already enforced by `parseDestination` before the request is built, so
 * matching the hostname here lets a named internal endpoint connect without widening the rule.
 */
const exempt = (hostname: string, policy: UrlPolicy) =>
  policy.allowedHttpOrigins.some((origin) => URL.parse(origin)?.hostname === hostname);

/** Loopback is reachable only where the deployment opted in, the same rule the URL check uses. */
const permitted = (address: string, policy: UrlPolicy) =>
  isPublicAddress(address) || (policy.allowLoopbackHttp && isLoopbackAddress(address));

/** Refuse the connection when any resolved address is outside the addresses the host may reach. */
export const safeLookup =
  (policy: UrlPolicy, resolve: AddressLookup = systemLookup): LookupFunction =>
  (hostname, options, callback) => {
    const host = hostname.toLowerCase().replace(/\.$/, "");
    resolve(hostname, { ...options, all: true as const }, (error, addresses) => {
      if (error !== null) return callback(error, []);
      if (!exempt(host, policy) && !addresses.every((entry) => permitted(entry.address, policy)))
        return callback(new DestinationRefused(host), []);
      const [first] = addresses;
      if (first === undefined) return callback(new DestinationRefused(host), []);
      return options.all === true
        ? callback(null, addresses)
        : callback(null, first.address, first.family);
    });
  };
