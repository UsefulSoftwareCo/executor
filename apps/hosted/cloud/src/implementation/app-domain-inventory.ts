/** Read complete provider inventories without requesting a page beyond the reported end. */
import { listRecords } from "@distilled.cloud/cloudflare/dns";
import { listCertificatePacks } from "@distilled.cloud/cloudflare/ssl";
import { Clock, Effect, Stream } from "effect";

const lastPage = (response: {
  readonly resultInfo?: {
    readonly page?: number | null;
    readonly totalPages?: number | null;
  } | null;
}) => {
  const page = response.resultInfo?.page;
  const total = response.resultInfo?.totalPages;
  return typeof page === "number" && typeof total === "number" && page >= total;
};

/** A fresh, complete DNS scan scoped to this stage, including every returned page. */
export const appDomainDnsRecords = (zoneId: string, suffix: string) =>
  listRecords.pages({ zoneId, type: "AAAA", name: { endswith: `.${suffix}` }, perPage: 5000 }).pipe(
    Stream.takeUntil(lastPage),
    Stream.flatMap((page) => Stream.fromIterable(page.result)),
    Stream.runCollect,
  );

/**
 * Cloudflare lists certificate packs at about 15 to 30 milliseconds per pack. Read one page after
 * another, a zone of a few thousand teams outlasted the time a pass allows for the whole inventory.
 * Half-size pages answer in about 15 seconds and keep the pages held at once to a few megabytes.
 */
const certificatePageSize = 500;

/** Pages requested at once: 6,000 packs in the time of one page. */
const certificatePageConcurrency = 12;

/** What the zone's certificate packs say about one host. */
export interface HostCertificates {
  /** An active pack holds an active, unexpired certificate for the host. */
  readonly ready: boolean;
  /** A pack for the host timed out waiting for validation. */
  readonly failed: boolean;
}

/**
 * Every certificate pack of every status, reduced to each host's certificates. A small request
 * reports the pack count, then the pages are requested several at a time instead of one after
 * another. Each page is reduced as it arrives, so the isolate never holds every pack. The list
 * changes while it is read: a pack can be counted twice, which changes nothing, and a page added
 * meanwhile is read before returning. A pack deleted ahead of a page boundary between two page
 * requests moves the next pack onto the earlier page, so that host can be missed and read as
 * pending until the next pass. Requesting the pages together keeps that window short.
 */
export const appDomainCertificates = (zoneId: string) =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const hosts = new Map<string, HostCertificates>();
    const readPage = (page: number) =>
      listCertificatePacks({ zoneId, status: "all", perPage: certificatePageSize, page }).pipe(
        Effect.map((response) => {
          for (const pack of response.result)
            for (const host of pack.hosts) {
              const known = hosts.get(host);
              hosts.set(host, {
                ready:
                  (known?.ready ?? false) ||
                  (pack.status === "active" &&
                    pack.certificates.some(
                      (certificate) =>
                        certificate.status === "active" &&
                        certificate.hosts.includes(host) &&
                        certificate.expiresOn !== undefined &&
                        certificate.expiresOn !== null &&
                        Date.parse(certificate.expiresOn) > now,
                    )),
                failed: (known?.failed ?? false) || pack.status === "validation_timed_out",
              });
            }
          return response.resultInfo?.totalPages ?? 0;
        }),
      );
    const probe = yield* listCertificatePacks({ zoneId, status: "all", perPage: 5, page: 1 });
    const count = probe.resultInfo?.totalCount;
    if (typeof count !== "number")
      return yield* Effect.die(new Error("Certificate pack list reported no total"));
    let done = 0;
    let pages = Math.ceil(count / certificatePageSize);
    while (done < pages) {
      const reported = yield* Effect.forEach(
        Array.from({ length: pages - done }, (_, index) => done + index + 1),
        readPage,
        { concurrency: certificatePageConcurrency },
      );
      done = pages;
      pages = Math.max(pages, ...reported);
    }
    return hosts as ReadonlyMap<string, HostCertificates>;
  });
