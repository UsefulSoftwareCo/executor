/** Read complete provider inventories without requesting a page beyond the reported end. */
import { listRecords } from "@distilled.cloud/cloudflare/dns";
import { listCertificatePacks } from "@distilled.cloud/cloudflare/ssl";
import { Stream } from "effect";

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

/** Read all certificate states so callers can distinguish pending, active, and failed issuance. */
export const appDomainCertificates = (zoneId: string) =>
  listCertificatePacks.pages({ zoneId, status: "all", perPage: 1000 }).pipe(
    Stream.takeUntil(lastPage),
    Stream.flatMap((page) => Stream.fromIterable(page.result)),
    Stream.runCollect,
  );
