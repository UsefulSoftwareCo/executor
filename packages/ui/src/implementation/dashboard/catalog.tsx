import { Publication } from "@executor-js/app-registry/contracts";
import type { Query } from "../../contracts/dashboard.ts";
import type { ComponentType } from "react";
import type { FailureProps } from "../../contracts/dashboard.ts";
import { RemoteAppForm } from "./custom-app.tsx";
import { AppCreateForm } from "./app-create.tsx";
import { AsyncResult } from "effect/unstable/reactivity";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { useState, type ReactNode } from "react";
import { Option, Schema } from "effect";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowLeft02Icon, ArrowRight02Icon } from "@hugeicons/core-free-icons";
import {
  McpImportAuth,
  graphqlCatalogAuth,
  type CatalogEntry,
  type ImportedApp,
} from "@executor-js/catalog/contracts";
import type { QueryProps, MutationProps, InstallApp } from "../../contracts/dashboard.ts";
import { Empty, LoadingRows, ProviderIcon, SearchInput } from "./common.tsx";
import { SkippedOperationsNotice, useImportReview } from "./skipped-operations.tsx";
import { Button } from "../components/button.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/select.tsx";

/** Explain unsupported imports before a user opens their install form. */
export const catalogUnavailable = (entry: CatalogEntry) => {
  switch (entry.kind) {
    case "graphql":
      return undefined;
    case "cli":
      return "CLI imports are not supported";
    case "mcp":
      return entry.connectUrl ? undefined : "No MCP server URL available";
    case "openapi":
      return entry.connectUrl ? undefined : "No API definition available";
  }
};
const catalogKind = (entry: CatalogEntry) =>
  entry.kind === "graphql"
    ? "GraphQL"
    : entry.kind === "openapi"
      ? "OpenAPI"
      : entry.kind.toUpperCase();
/** One discovery list combines published apps and integration templates, with independent failure states. */
export function CatalogPage<E, P>({
  query,
  Failure,
  publications,
  PublicationFailure,
  back,
  action,
  onSelect,
  onPublication,
}: QueryProps<readonly CatalogEntry[], E> & {
  readonly publications: Query<ReadonlyArray<typeof Publication.Type>, P>;
  readonly PublicationFailure: ComponentType<FailureProps<NoInfer<P>>>;
  readonly back: ReactNode;
  readonly action?: ReactNode;
  readonly onSelect?: ((entry: CatalogEntry) => void) | undefined;
  readonly onPublication?: ((publication: typeof Publication.Type) => void) | undefined;
}) {
  const result = useAtomValue(query);
  const retry = useAtomRefresh(query);
  const publicResult = useAtomValue(publications);
  const retryPublic = useAtomRefresh(publications);
  const [search, setSearch] = useState("");
  const [limit, setLimit] = useState(50);
  const templates = AsyncResult.value(result);
  const published = AsyncResult.value(publicResult);
  type Row =
    | { readonly kind: "template"; readonly entry: CatalogEntry }
    | { readonly kind: "publication"; readonly publication: typeof Publication.Type };
  const rows: Row[] = [
    ...(Option.isSome(published) ? published.value : []).map((publication): Row => ({
      kind: "publication",
      publication,
    })),
    ...(Option.isSome(templates)
      ? templates.value
          .filter((entry) => entry.kind !== "cli")
          .map((entry): Row => ({ kind: "template", entry }))
      : []),
  ];
  const title = (row: Row) => (row.kind === "publication" ? row.publication.name : row.entry.name);
  const unavailable = (row: Row) =>
    row.kind === "publication" ? undefined : catalogUnavailable(row.entry);
  const entries = rows
    .filter((row) =>
      (row.kind === "publication"
        ? `${row.publication.name} ${row.publication.description} published app`
        : `${row.entry.name} ${row.entry.domain} ${row.entry.kind}`
      )
        .toLowerCase()
        .includes(search.toLowerCase()),
    )
    .sort(
      (a, b) =>
        Number(unavailable(a) !== undefined) - Number(unavailable(b) !== undefined) ||
        Number(b.kind === "publication") - Number(a.kind === "publication") ||
        (a.kind === "template" && b.kind === "template"
          ? Number(b.entry.feeds?.includes("curated") ?? false) -
              Number(a.entry.feeds?.includes("curated") ?? false) ||
            (b.entry.popularity ?? 0) - (a.entry.popularity ?? 0)
          : 0) ||
        title(a).localeCompare(title(b)),
    );
  return (
    <div className="page w-full shrink-0 max-w-315 [padding:24px_24px_48px] my-0 mx-auto max-[1000px]:[padding:20px_20px_40px] max-[740px]:[padding:18px_max(16px,_env(safe-area-inset-right))_max(32px,_env(safe-area-inset-bottom))_max(16px,_env(safe-area-inset-left))]">
      {back}
      <div className="page-heading gap-4 flex justify-between items-center min-h-12 mb-4.5 [&_p]:text-muted-foreground [&_p]:text-[13px] [&_p]:mt-1.25 [&_>_div]:min-w-0 [&_>_div]:wrap-anywhere max-[740px]:items-start max-[740px]:mb-4.5 max-[740px]:[&_p]:leading-[1.6] max-[740px]:[&_>_[data-slot='button']]:mt-0.25 max-[740px]:[.setup-page_&]:min-h-0">
        <div>
          <h1 className="text-[22px] font-semibold tracking-[-0.035em] leading-[1.35] [&>span]:text-muted-foreground [&>span]:text-[13px] [&>span]:font-mono [&>span]:font-normal [&>span]:ml-[8px] [&>span]:align-middle">
            Add app
          </h1>
          <p>Find a published app or connect a service.</p>
        </div>
        {action}
      </div>
      <div className="list-toolbar flex flex-wrap items-center gap-[10px_16px] mb-4">
        <SearchInput
          autoFocus
          value={search}
          onChange={(value) => {
            setSearch(value);
            setLimit(50);
          }}
          placeholder="Search apps…"
        />
        <span className="muted text-muted-foreground">{entries.length.toLocaleString()} apps</span>
      </div>
      {AsyncResult.isFailure(result) && <Failure cause={result.cause} retry={retry} />}
      {AsyncResult.isFailure(publicResult) && (
        <PublicationFailure cause={publicResult.cause} retry={retryPublic} />
      )}
      {!entries.length && (AsyncResult.isInitial(result) || AsyncResult.isInitial(publicResult)) ? (
        <LoadingRows />
      ) : !entries.length &&
        (AsyncResult.isFailure(result) ||
          AsyncResult.isFailure(publicResult)) ? null : !entries.length ? (
        <Empty
          title={search ? "No matching apps" : "No apps available"}
          action={
            search ? (
              <Button variant="outline" onClick={() => setSearch("")}>
                Clear search
              </Button>
            ) : (
              action
            )
          }
        >
          {search
            ? "Try another name or connect your own service."
            : "Connect your own service to get started."}
        </Empty>
      ) : (
        <>
          <div className="catalog-list border-t border-t-border">
            {entries.slice(0, limit).map((row) => {
              const reason = unavailable(row);
              const name = title(row);
              const published = row.kind === "publication";
              return (
                <button
                  type="button"
                  className="catalog-row w-full flex items-center gap-4 min-h-18.5 text-left py-[15px] px-[12px] border-b border-b-border cursor-pointer [&:hover:not(:disabled)]:bg-muted disabled:cursor-default max-[740px]:grid max-[740px]:grid-cols-[34px_minmax(0,_1fr)_auto] max-[740px]:gap-[4px_12px] max-[740px]:py-[15px] max-[740px]:px-0 max-[740px]:[&_>_svg]:col-[3] max-[740px]:[&_>_svg]:row-[1_/_3]"
                  key={published ? `package:${row.publication.name}` : row.entry.id}
                  disabled={
                    reason !== undefined ||
                    (published ? onPublication === undefined : onSelect === undefined)
                  }
                  onClick={() => {
                    if (row.kind === "publication") onPublication?.(row.publication);
                    else onSelect?.(row.entry);
                  }}
                >
                  <ProviderIcon
                    name={name}
                    url={row.kind === "template" ? row.entry.domain : undefined}
                  />
                  <div className="catalog-row-title flex-1 flex flex-col gap-1.25 min-w-0 [&_strong]:text-[13px] [&_strong]:font-medium [&_span]:text-[12px] [&_span]:text-muted-foreground wrap-anywhere max-[740px]:col-[2]">
                    <strong>{name}</strong>
                    <span>
                      {row.kind === "publication"
                        ? row.publication.description || "Public app"
                        : row.entry.domain}
                    </span>
                  </div>
                  <span className="catalog-kind text-[12px] text-muted-foreground min-w-18.75 max-[740px]:col-[2] max-[740px]:text-[11px]">
                    {row.kind === "publication" ? "App" : catalogKind(row.entry)}
                  </span>
                  {reason ? (
                    <span className="catalog-unavailable text-muted-foreground text-[12px] max-[740px]:col-[2_/_-1]">
                      {reason}
                    </span>
                  ) : (
                    <HugeiconsIcon icon={ArrowRight02Icon} strokeWidth={2} aria-hidden size={15} />
                  )}
                </button>
              );
            })}
          </div>
          {entries.length > limit && (
            <Button
              variant="outline"
              className="load-more mt-5"
              onClick={() => setLimit(limit + 50)}
            >
              Show more
            </Button>
          )}
        </>
      )}
    </div>
  );
}
/** Common install form; the supplied mutation atom owns routing and invalidation. */
export function CatalogInstall<E>({
  mutation,
  Failure,
  entry,
  onBack,
  onInstalled,
}: MutationProps<InstallApp, ImportedApp, E> & {
  readonly entry: CatalogEntry;
  readonly onBack: () => void;
  readonly onInstalled: (app: ImportedApp) => void | Promise<void>;
}) {
  const imported = useAtomValue(mutation);
  const { review, installed } = useImportReview(onInstalled);
  const [mcpAuth, setMcpAuth] = useState<McpImportAuth>("auto");
  const pending = imported.waiting;
  return (
    <div className="page setup-page w-full shrink-0 [padding:24px_24px_48px] my-0 mx-auto max-[1000px]:[padding:20px_20px_40px] max-w-212.5 max-[740px]:[padding:18px_max(16px,_env(safe-area-inset-right))_max(32px,_env(safe-area-inset-bottom))_max(16px,_env(safe-area-inset-left))]">
      <Button
        variant="ghost"
        size="sm"
        className="back-link h-auto rounded-none p-0 font-normal hover:bg-transparent inline-flex gap-1.5 items-center text-[12px] text-muted-foreground mb-4.25 hover:text-foreground max-[740px]:min-h-11 max-[740px]:inline-flex max-[740px]:items-center max-[740px]:-mt-2 max-[740px]:mb-3"
        onClick={onBack}
        disabled={pending}
      >
        <HugeiconsIcon icon={ArrowLeft02Icon} strokeWidth={2} aria-hidden size={14} />
        All apps
      </Button>
      <div className="page-heading gap-4 flex justify-between items-center min-h-12 mb-4.5 [&_p]:text-muted-foreground [&_p]:text-[13px] [&_p]:mt-1.25 [&_>_div]:min-w-0 [&_>_div]:wrap-anywhere max-[740px]:items-start max-[740px]:mb-4.5 max-[740px]:[&_p]:leading-[1.6] max-[740px]:[&_>_[data-slot='button']]:mt-0.25 max-[740px]:[.setup-page_&]:min-h-0">
        <h1 className="text-[22px] font-semibold tracking-[-0.035em] leading-[1.35] [&>span]:text-muted-foreground [&>span]:text-[13px] [&>span]:font-mono [&>span]:font-normal [&>span]:ml-[8px] [&>span]:align-middle">
          Add app
        </h1>
      </div>
      {review ? (
        <SkippedOperationsNotice
          operations={review.skippedOperations}
          onContinue={() => onInstalled(review)}
        />
      ) : entry.kind === "graphql" ? (
        <RemoteAppForm
          kind="graphql"
          mutation={mutation}
          Failure={Failure}
          initial={{
            name: entry.name,
            url: entry.connectUrl ?? "",
            auth: Option.getOrElse(graphqlCatalogAuth(entry), () => ({
              type: "apiKey" as const,
              header: "Authorization",
              prefix: "Bearer ",
            })),
          }}
          input={(source) => ({
            entry: entry.id,
            name: source.name,
            ...(source.kind === "graphql"
              ? { graphql: { url: source.url, auth: source.auth } }
              : {}),
          })}
          onInstalled={installed}
        />
      ) : (
        <AppCreateForm
          mutation={mutation}
          Failure={Failure}
          initialName={entry.name}
          input={(name) => ({
            entry: entry.id,
            name,
            ...(entry.kind === "mcp" ? { mcpAuth } : {}),
          })}
          onCreated={installed}
          label="Add app"
          onCancel={onBack}
          beforeName={
            <>
              <div className="setup-provider flex items-center gap-3.25 [&_h2]:text-[16px] [&_h2]:[font-weight:550] [&_>_div]:min-w-0 [&_>_div]:wrap-anywhere">
                <ProviderIcon name={entry.name} url={entry.domain} large />
                <div>
                  <h2>{entry.name}</h2>
                  <span className="row-meta flex flex-wrap gap-1.5 items-center mt-0.75 text-[11px] text-muted-foreground">
                    {catalogKind(entry)} · {entry.domain}
                  </span>
                </div>
              </div>
              <p className="catalog-description text-muted-foreground text-[13px] leading-[1.6]">
                {entry.description}
              </p>
            </>
          }
        >
          {(pending) => (
            <>
              {entry.kind === "mcp" && (
                <label className="field-label flex flex-col gap-2.25 text-[13px] font-medium [&_[data-slot='select-trigger']]:w-full">
                  Sign-in method
                  <Select
                    value={mcpAuth}
                    disabled={pending}
                    onValueChange={(value) => {
                      const parsed = Schema.decodeUnknownOption(McpImportAuth)(value);
                      if (Option.isSome(parsed)) setMcpAuth(parsed.value);
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="auto">Use catalog settings</SelectItem>
                      <SelectItem value="oauth">OAuth</SelectItem>
                      <SelectItem value="apiKey">API key</SelectItem>
                      <SelectItem value="none">No authentication</SelectItem>
                    </SelectContent>
                  </Select>
                </label>
              )}
              <span className="field-hint text-muted-foreground text-[12px] font-normal leading-[1.5] [.mcp-install-content_>_&]:mt-5">
                {entry.kind === "mcp"
                  ? "Tools load live with your selected account."
                  : "Creates editable app source from this API definition."}
              </span>
            </>
          )}
        </AppCreateForm>
      )}
    </div>
  );
}
