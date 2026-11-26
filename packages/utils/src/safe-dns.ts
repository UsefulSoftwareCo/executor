import { lookup as systemLookup, type LookupAddress, type LookupAllOptions } from "node:dns";
import type { LookupFunction } from "node:net";
import { isLoopbackAddress, isPublicAddress, type UrlPolicy } from "./url-policy.ts";

export type AddressLookup = (
  hostname: string,
  options: LookupAllOptions,
  callback: (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void,
) => void;

export class DestinationRefused extends Error {
  constructor(hostname: string) {
    super(`${hostname} resolves to an address this deployment may not reach`);
    this.name = "DestinationRefused";
  }
}

const exempt = (hostname: string, policy: UrlPolicy) =>
  policy.allowedHttpOrigins.some((origin) => URL.parse(origin)?.hostname === hostname);

const permitted = (address: string, policy: UrlPolicy) =>
  isPublicAddress(address) || (policy.allowLoopbackHttp && isLoopbackAddress(address));

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
