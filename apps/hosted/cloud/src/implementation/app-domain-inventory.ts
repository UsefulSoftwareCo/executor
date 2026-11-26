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

export const appDomainDnsRecords = (zoneId: string, suffix: string) =>
  listRecords.pages({ zoneId, type: "AAAA", name: { endswith: `.${suffix}` }, perPage: 5000 }).pipe(
    Stream.takeUntil(lastPage),
    Stream.flatMap((page) => Stream.fromIterable(page.result)),
    Stream.runCollect,
  );

const certificatePageSize = 500;

const certificatePageConcurrency = 12;

export interface HostCertificates {
  readonly ready: boolean;
  readonly failed: boolean;
}

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
