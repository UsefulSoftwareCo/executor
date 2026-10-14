import { useEffect, useState, type ReactNode } from "react";
import { RegistryProvider, useAtomValue } from "@effect/atom-react";
import { Cause, Option } from "effect";
import { AsyncResult } from "effect/reactivity";
import {
  registryPublicationPath,
  type Publication,
  type PublicationSnapshot,
  type RegistryError,
} from "@executor-js/sdk/core";
import {
  publicApps,
  publicApp,
  publicAppFiles,
  publicAppsLocation,
} from "../contracts/public-apps.ts";
import { HighlightedCode } from "./highlighted-code.tsx";

const communityDomain = ".executor.community";
/** A package name read as its app label and publisher; the community domain becomes a badge. */
function packageParts(name: string) {
  const scope = name.slice(1, name.indexOf("/"));
  const community = scope.endsWith(communityDomain);
  return {
    label: name.slice(name.indexOf("/") + 1),
    publisher: community ? scope.slice(0, -communityDomain.length) : scope,
    community,
  };
}

function CommunityBadge() {
  return (
    <span className="inline-flex shrink-0 items-center rounded-full border border-rule px-2 py-0.5 font-mono text-[11px] leading-4 text-ink-3">
      executor.community
    </span>
  );
}

function WarningIcon() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 20 20"
      className="mt-0.5 size-4 shrink-0 fill-none stroke-[#f59e0b] stroke-[1.75]"
    >
      <path d="M10 3.5 2.5 16.5h15L10 3.5Z" strokeLinejoin="round" />
      <path d="M10 8.5v3.5M10 14.2v.3" strokeLinecap="round" />
    </svg>
  );
}

/** Published apps are user code. Every surface that lists or shows one says so. */
function UntrustedNotice({ children }: { readonly children: ReactNode }) {
  return (
    <div
      role="note"
      className="flex gap-3 rounded-lg border border-rule border-l-2 border-l-[#f59e0b] bg-surface-2 px-4 py-3 text-sm leading-6"
    >
      <WarningIcon />
      <div className="min-w-0 text-ink-2">{children}</div>
    </div>
  );
}

const publishedDate = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
});

function usePageTitle(title: string) {
  useEffect(() => {
    document.title = `${title} — Executor`;
    const canonical = document.querySelector<HTMLLinkElement>('link[rel="canonical"]');
    if (canonical !== null) {
      const url = new URL(canonical.href);
      url.pathname = window.location.pathname;
      canonical.href = url.href;
    }
  }, [title]);
}

function RegistryQuery<A>({
  result,
  children,
  pending,
}: {
  readonly result: AsyncResult.AsyncResult<A, RegistryError>;
  readonly children: (value: A) => ReactNode;
  readonly pending: ReactNode;
}) {
  const data = AsyncResult.value(result);
  return (
    <>
      {AsyncResult.isFailure(result) && <ReadFailure cause={result.cause} />}
      {Option.isSome(data) ? children(data.value) : !AsyncResult.isFailure(result) && pending}
    </>
  );
}
function ReadFailure({ cause }: { readonly cause: Cause.Cause<RegistryError> }) {
  const error = Option.getOrUndefined(Cause.findErrorOption(cause));
  return (
    <div role="alert" className="mb-6 border border-rule p-5 text-sm leading-6">
      <p>
        {error?.reason === "changed"
          ? "A new version has been published. Reload to see it."
          : error?.reason === "not-found"
            ? "This app is no longer published. Existing copies are unchanged."
            : "The published app could not be loaded. Try again."}
      </p>
      <button
        type="button"
        className="mt-3 underline underline-offset-4"
        onClick={() => window.location.reload()}
      >
        Reload
      </button>
    </div>
  );
}

/** Live public data is an island inside the same static site frame used by marketing and Docs. */
export default function AppsDirectory() {
  const location = publicAppsLocation(window.location.pathname);
  return (
    <RegistryProvider>
      {location.kind === "directory" ? (
        <Directory />
      ) : location.kind === "app" ? (
        <AppPage name={location.name} />
      ) : (
        <>
          <h1 className="text-2xl font-semibold">App not found</h1>
          <a href="/apps" className="mt-4 inline-block underline underline-offset-4">
            Browse apps
          </a>
        </>
      )}
    </RegistryProvider>
  );
}
function DirectoryFrame({
  search = "",
  onSearch,
  children,
}: {
  readonly search?: string;
  readonly onSearch?: (value: string) => void;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="shrink-0">
        <h1 className="text-[clamp(1.75rem,3vw,2.25rem)] font-semibold tracking-tight">Apps</h1>
        <p className="mt-4 max-w-2xl text-base leading-7 text-ink-2">
          Apps shared by people building with Executor. Browse the source and make your own copy.
        </p>
        <div className="mt-6 max-w-3xl">
          <UntrustedNotice>
            <strong className="font-medium text-ink">
              Community apps aren’t reviewed by Executor.
            </strong>{" "}
            Anyone can publish one. Read its source before you copy it: a copy runs with the
            accounts you connect to it.
          </UntrustedNotice>
        </div>
        <div className="mb-4 mt-6">
          <label className="block max-w-sm">
            <span className="sr-only">Search apps</span>
            <input
              type="search"
              value={search}
              onChange={(event) => onSearch?.(event.target.value)}
              disabled={onSearch === undefined}
              placeholder="Search apps…"
              className="w-full rounded-md border border-rule-strong bg-surface px-3 py-2.5 text-sm text-ink outline-offset-2 focus-visible:outline-ink"
            />
          </label>
        </div>
      </header>
      <section
        aria-label="Apps"
        tabIndex={0}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-0.5 -m-0.5 focus-visible:outline-ink"
      >
        {children}
      </section>
    </div>
  );
}

function Placeholder({ className }: { readonly className: string }) {
  return (
    <span aria-hidden className={`block rounded bg-rule motion-safe:animate-pulse ${className}`} />
  );
}

function DirectoryCardsLoading() {
  return (
    <div role="status" aria-label="Loading apps">
      <span className="sr-only">Loading apps…</span>
      <div aria-hidden className="divide-y divide-rule rounded-lg border border-rule">
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="space-y-2.5 px-5 py-4">
            <Placeholder className="h-4 w-48 max-w-full" />
            <Placeholder className="h-3 w-3/5" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** The static document and first client render use the same directory frame. */
export function AppsDirectoryLoading() {
  return (
    <DirectoryFrame>
      <DirectoryCardsLoading />
    </DirectoryFrame>
  );
}

function Directory() {
  usePageTitle("Apps");
  const result = useAtomValue(publicApps);
  const [search, setSearch] = useState("");
  return (
    <DirectoryFrame search={search} onSearch={setSearch}>
      <RegistryQuery result={result} pending={<DirectoryCardsLoading />}>
        {(publications) => {
          const matching = publications
            .filter((item) =>
              `${item.name} ${item.description}`.toLowerCase().includes(search.toLowerCase()),
            )
            .toSorted((left, right) => right.publishedAt.localeCompare(left.publishedAt));
          return matching.length === 0 ? (
            <p className="flex min-h-32 items-center justify-center rounded-lg border border-rule p-8 text-center text-sm text-ink-2">
              {publications.length === 0
                ? "No apps have been published yet."
                : "No matching apps. Try another search."}
            </p>
          ) : (
            <ul className="divide-y divide-rule overflow-hidden rounded-lg border border-rule">
              {matching.map((publication) => {
                const { label, publisher } = packageParts(publication.name);
                return (
                  <li key={publication.name}>
                    <a
                      href={registryPublicationPath(publication.name)}
                      title={publication.name}
                      className="group grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-6 gap-y-1 px-5 py-4 transition-colors hover:bg-surface-2 focus-visible:outline-ink"
                    >
                      <h2 className="min-w-0 truncate text-[15px] leading-6">
                        <span className="font-semibold text-ink">{label}</span>
                        <span className="text-ink-3"> by {publisher}</span>
                      </h2>
                      <span className="text-xs tabular-nums text-ink-3 transition-colors group-hover:text-ink-2">
                        {publishedDate.format(new Date(publication.publishedAt))}
                        <span aria-hidden className="ml-2">
                          →
                        </span>
                      </span>
                      {publication.description && (
                        <p className="col-span-2 truncate text-sm leading-6 text-ink-2">
                          {publication.description}
                        </p>
                      )}
                    </a>
                  </li>
                );
              })}
            </ul>
          );
        }}
      </RegistryQuery>
    </DirectoryFrame>
  );
}
function AppPage({ name }: { readonly name: string }) {
  usePageTitle(name);
  const result = useAtomValue(publicApp(name));
  return (
    <>
      <BackToApps />
      <RegistryQuery result={result} pending={<PublicationLoading name={name} />}>
        {(publications) => {
          const publication = publications.find((item) => item.name === name);
          return publication === undefined ? (
            <>
              <h1 className="text-2xl font-semibold">This app is not published</h1>
              <p className="mt-3 text-sm leading-6 text-ink-2">
                The listing may have been removed. Existing copies are unchanged.
              </p>
            </>
          ) : (
            <AppPublication publication={publication} />
          );
        }}
      </RegistryQuery>
    </>
  );
}
function BackToApps() {
  return (
    <a
      href="/apps"
      className="mb-7 inline-flex min-h-9 items-center text-sm text-ink-2 hover:text-ink"
    >
      ← All apps
    </a>
  );
}

/** Published app URLs receive their own first-paint layout before JavaScript loads. */
export function PublishedAppLoading() {
  return (
    <>
      <BackToApps />
      <PublicationLoading />
    </>
  );
}

function PublicationLoading({ name }: { readonly name?: string }) {
  return (
    <div role="status" aria-label="Loading app">
      <div className="flex flex-wrap items-start justify-between gap-5">
        <div className="min-w-0 flex-1">
          {name ? (
            <PublicationHeading name={name} />
          ) : (
            <Placeholder className="h-10 w-2/3 max-w-96" />
          )}
          <div className="mt-4 max-w-2xl space-y-3">
            <Placeholder className="h-4 w-full" />
            <Placeholder className="h-4 w-2/3" />
          </div>
        </div>
        <Placeholder className="h-9 w-24" />
      </div>
      <Placeholder className="mt-5 h-6 w-64 max-w-full" />
      <section className="mt-9" aria-label="Published source">
        <div className="mb-3 flex items-center justify-between gap-4">
          <h2 className="text-sm font-medium">Published source</h2>
          <Placeholder className="h-3 w-14" />
        </div>
        <PublishedFilesLoading />
      </section>
      <span className="sr-only">Loading app…</span>
    </div>
  );
}

function PublishedFilesLoading() {
  return (
    <div
      role="status"
      aria-label="Loading published files"
      className="grid min-h-96 grid-cols-[11rem_minmax(0,1fr)] overflow-hidden rounded-lg border border-rule max-[719.98px]:grid-cols-1"
    >
      <div
        aria-hidden
        className="space-y-5 border-r border-rule bg-surface-2 p-4 max-[719.98px]:hidden"
      >
        <Placeholder className="h-3 w-3/4" />
        <Placeholder className="h-3 w-1/2" />
        <Placeholder className="h-3 w-2/3" />
      </div>
      <div aria-hidden className="min-w-0">
        <div className="border-b border-rule px-4 py-3">
          <Placeholder className="h-4 w-24" />
        </div>
        <div className="min-h-80 space-y-3 p-5">
          <Placeholder className="h-3 w-3/5" />
          <Placeholder className="h-3 w-4/5" />
          <Placeholder className="h-3 w-2/5" />
          <Placeholder className="h-3 w-3/4" />
          <Placeholder className="h-3 w-1/2" />
        </div>
      </div>
      <span className="sr-only">Loading published files…</span>
    </div>
  );
}

function PublicationHeading({ name }: { readonly name: string }) {
  const { label, publisher, community } = packageParts(name);
  return (
    <>
      <h1 className="break-words text-[clamp(1.4rem,2.5vw,2rem)] font-semibold tracking-tight">
        {label}
      </h1>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-ink-2">
        <span>by {publisher}</span>
        {community && <CommunityBadge />}
      </div>
      <code className="mt-2 block break-all text-xs text-ink-3">{name}</code>
    </>
  );
}

function AppPublication({ publication }: { readonly publication: typeof Publication.Type }) {
  const source = useAtomValue(publicAppFiles(publication.name, publication.commit));
  const [copyLabel, setCopyLabel] = useState("Copy link");
  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-5">
        <div className="min-w-0 flex-1">
          <PublicationHeading name={publication.name} />
          {publication.description && (
            <p className="mt-4 max-w-2xl text-base leading-7 text-ink-2">
              {publication.description}
            </p>
          )}
        </div>
        <button
          type="button"
          className="rounded-md border border-rule-strong px-3 py-2 text-sm hover:bg-surface-2"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(
                new URL(registryPublicationPath(publication.name), window.location.origin).href,
              );
              setCopyLabel("Copied");
            } catch {
              setCopyLabel("Could not copy");
            }
          }}
        >
          {copyLabel}
        </button>
      </div>
      <p className="mt-5 text-xs leading-6 text-ink-3">
        Published {publishedDate.format(new Date(publication.publishedAt))} · Find this package in
        Add app to make a copy.
      </p>
      <div className="mt-6 max-w-3xl">
        <UntrustedNotice>
          <strong className="font-medium text-ink">Community app, not reviewed by Executor.</strong>{" "}
          Anyone can publish one. Read the source below before you copy it. A copy runs with the
          accounts you connect to it, and can read and change what they can.
        </UntrustedNotice>
      </div>
      <section className="mt-9" aria-label="Published source">
        <div className="mb-3 flex items-center justify-between gap-4">
          <h2 className="text-sm font-medium">Published source</h2>
          <code title={publication.commit} className="text-xs text-ink-3">
            {publication.commit.slice(0, 7)}
          </code>
        </div>
        <RegistryQuery result={source} pending={<PublishedFilesLoading />}>
          {(snapshot) => (
            <PublishedFiles key={snapshot.publication.commit} files={snapshot.files} />
          )}
        </RegistryQuery>
      </section>
    </>
  );
}
function PublishedFiles({ files }: { readonly files: typeof PublicationSnapshot.Type.files }) {
  const [selected, setSelected] = useState("index.ts");
  const file = files.find((item) => item.path === selected) ?? files[0];
  return (
    <div className="grid min-h-96 grid-cols-[11rem_minmax(0,1fr)] overflow-hidden rounded-lg border border-rule max-[719.98px]:grid-cols-1">
      <nav
        aria-label="Source files"
        className="max-h-[34rem] overflow-auto border-r border-rule bg-surface-2 p-2 max-[719.98px]:hidden"
      >
        {files.map((item) => (
          <button
            key={item.path}
            type="button"
            title={item.path}
            aria-pressed={item.path === file?.path}
            onClick={() => setSelected(item.path)}
            className={`block w-full truncate rounded px-2 py-2 text-left font-mono text-xs hover:bg-rule ${item.path === file?.path ? "bg-rule font-medium text-ink" : "text-ink-2"}`}
          >
            {item.path}
          </button>
        ))}
      </nav>
      <div className="min-w-0">
        <div className="border-b border-rule px-4 py-3 text-xs">
          <span className="font-mono max-[719.98px]:hidden">{file?.path}</span>
          <select
            aria-label="Source file"
            value={file?.path}
            onChange={(event) => setSelected(event.target.value)}
            className="w-full bg-surface font-mono min-[720px]:hidden"
          >
            {files.map((item) => (
              <option key={item.path} value={item.path}>
                {item.path}
              </option>
            ))}
          </select>
        </div>
        <pre className="m-0 max-h-[34rem] min-h-80 overflow-auto p-5 font-mono text-xs leading-6 text-ink">
          {file &&
            ("content" in file ? (
              <HighlightedCode code={file.content} path={file.path} />
            ) : (
              `Binary file, ${file.size.toLocaleString("en-US")} bytes.`
            ))}
        </pre>
      </div>
    </div>
  );
}
