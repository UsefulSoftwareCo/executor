import { Publication } from "@executor-js/app-registry/contracts";
import type { Query } from "../../contracts/dashboard.ts";
import type { ComponentType } from "react";
import type { FailureProps } from "../../contracts/dashboard.ts";
import { AppCreateForm } from "./app-create.tsx";
import { AsyncResult } from "effect/unstable/reactivity";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { useState, type ReactNode } from "react";
import { Option } from "effect";
import type { DeployedApp } from "@executor-js/sdk";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowLeft02Icon, ArrowRight02Icon } from "@hugeicons/core-free-icons";
import { quickAdd, type CatalogEntry } from "@executor-js/catalog/contracts";
import type { QueryProps, MutationProps, InstallApp } from "../../contracts/dashboard.ts";
import { Empty, LoadingRows, ProviderIcon, SearchInput } from "./common.tsx";
import { AgentSetupPrompt, agentSetupPrompt } from "./agent-setup.tsx";
import { Button } from "../components/button.tsx";

const catalogKind = (entry: CatalogEntry) => {
  switch (entry.kind) {
    case "app":
      return "App";
    case "graphql":
      return "GraphQL";
    case "openapi":
      return "OpenAPI";
    case "mcp":
    case "cli":
      return entry.kind.toUpperCase();
  }
};
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
              const name = title(row);
              const published = row.kind === "publication";
              return (
                <button
                  type="button"
                  className="catalog-row w-full flex items-center gap-4 min-h-18.5 text-left py-[15px] px-[12px] border-b border-b-border cursor-pointer [&:hover:not(:disabled)]:bg-muted disabled:cursor-default max-[740px]:grid max-[740px]:grid-cols-[34px_minmax(0,_1fr)_auto] max-[740px]:gap-[4px_12px] max-[740px]:py-[15px] max-[740px]:px-0 max-[740px]:[&_>_svg]:col-[3] max-[740px]:[&_>_svg]:row-[1_/_3]"
                  key={published ? `package:${row.publication.name}` : row.entry.id}
                  disabled={published ? onPublication === undefined : onSelect === undefined}
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
                  <HugeiconsIcon icon={ArrowRight02Icon} strokeWidth={2} aria-hidden size={15} />
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
/**
 * MCP servers and built-in apps are added directly; the server confirms how an MCP server
 * connects. Every other service is set up by the user's agent from a copied prompt.
 */
export function CatalogInstall<E>({
  mutation,
  Failure,
  entry,
  endpoint,
  onBack,
  onInstalled,
}: MutationProps<InstallApp, DeployedApp, E> & {
  readonly entry: CatalogEntry;
  /** This installation's MCP URL, included so an unconnected agent can connect first. */
  readonly endpoint?: string;
  readonly onBack: () => void;
  readonly onInstalled: (app: DeployedApp) => void | Promise<void>;
}) {
  const imported = useAtomValue(mutation);
  const pending = imported.waiting;
  const provider = (
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
  );
  const prompt = agentSetupPrompt(entry, endpoint);
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
      {quickAdd(entry) ? (
        <div className="flex flex-col gap-10">
          <AppCreateForm
            mutation={mutation}
            Failure={Failure}
            initialName={entry.name}
            input={(name) => ({ entry: entry.id, name })}
            onCreated={onInstalled}
            label="Add app"
            onCancel={onBack}
            beforeName={provider}
          >
            {() =>
              entry.kind === "mcp" ? (
                <span className="field-hint text-muted-foreground text-[12px] font-normal leading-[1.5]">
                  Executor checks whether this server needs no sign-in or supports OAuth.
                </span>
              ) : null
            }
          </AppCreateForm>
          {entry.kind === "mcp" && (
            <AgentSetupPrompt
              title="Needs an API key or other setup?"
              description="Send this prompt to your agent instead. It reads the server’s documentation and asks how you sign in."
              prompt={prompt}
            />
          )}
        </div>
      ) : (
        <div className="flex max-w-145 flex-col gap-6">
          {provider}
          <AgentSetupPrompt
            title="Set up with your agent"
            description="Your agent reads this service’s documentation, asks how you sign in, then writes and deploys the app in Executor."
            prompt={prompt}
          />
        </div>
      )}
    </div>
  );
}
