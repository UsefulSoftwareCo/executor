/**
 * Edge certificates of the product zone.
 *
 * Every Workers Custom Domain orders an Advanced certificate for `<apex>, <host>, *.<host>`, and
 * Cloudflare serves the most recently ordered one for the apex. Browsers reuse a connection for
 * any host its certificate covers, but Cloudflare checks a request's host against the
 * certificate it currently serves for the connection's SNI and answers a mismatch with 403. When
 * a new custom domain's certificate replaced `*.executor.sh` at the apex, browsers holding older
 * apex connections got empty 403s for `v2.executor.sh` that never reached the Worker.
 */
import { listRecords } from "@distilled.cloud/cloudflare/dns";
import { listCertificatePacks } from "@distilled.cloud/cloudflare/ssl";
import { Effect, Stream } from "effect";
import { productZone } from "./stage.ts";

/** A wildcard covers exactly one label. */
const covers = (hosts: ReadonlyArray<string>, hostname: string) =>
  hosts.some((host) => {
    if (host === hostname) return true;
    if (!host.startsWith("*.") || !hostname.endsWith(host.slice(1))) return false;
    const label = hostname.slice(0, -(host.length - 1));
    return label.length > 0 && !label.includes(".");
  });

/**
 * Fail when a certificate that can serve the apex does not cover every proxied host: those in the
 * zone now and the `declared` hosts a deploy is about to add.
 */
export const productZoneCertificateCoverage = (zoneId: string, declared: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const existing = yield* listRecords.items({ zoneId, proxied: true }).pipe(
      Stream.map((record) => record.name),
      Stream.runCollect,
    );
    const proxied = [...existing, ...declared];
    const packs = yield* listCertificatePacks.items({ zoneId, status: "all" }).pipe(
      Stream.filter((pack) => pack.hosts.includes(productZone)),
      Stream.runCollect,
    );
    const failures = packs.flatMap((pack) => {
      const missing = [...new Set(proxied)].filter((hostname) => !covers(pack.hosts, hostname));
      return missing.length === 0
        ? []
        : [`${pack.id} (${pack.hosts.join(", ")}) lacks ${missing.join(", ")}`];
    });
    if (failures.length > 0)
      return yield* Effect.die(
        new Error(
          `Delete these ${productZone} certificate packs; Cloudflare may serve them for the apex and ` +
            `answer reused browser connections with 403: ${failures.join("; ")}`,
        ),
      );
  }).pipe(Effect.orDie);
