import { HugeiconsIcon } from "@hugeicons/react";
import { PackageIcon, Search01Icon } from "@hugeicons/core-free-icons";
import { Atom } from "effect/reactivity";
import { useOptionalDashboard } from "./context.tsx";
import { useState, type ReactNode } from "react";
import { useAtomValue } from "@effect/atom-react";
import {
  appIconSources,
  catalogIconSources,
  faviconUrl,
  noCatalogIcons,
  type AppIconSources,
  type CatalogIcons,
} from "../../contracts/icons.ts";
import { providerDisplayUrl } from "../../contracts/dashboard.ts";
import type { App, ProviderDefinition } from "@executor-js/sdk";
import type { CatalogIcon } from "@executor-js/catalog/contracts";
import { Input } from "@executor-js/ui/components/input";
import { cn } from "@executor-js/ui/lib/utils";
import { Skeleton } from "../components/skeleton.tsx";
import { useProductBrand } from "../hooks/product-brand.ts";
const noIcons = Atom.make(noCatalogIcons);

/** The dashboard's catalog icons, or none outside a dashboard. */
const useCatalogIcons = (): CatalogIcons => {
  const dashboard = useOptionalDashboard();
  return useAtomValue(dashboard ? dashboard.catalogIcons : noIcons);
};

/**
 * An app's own icons: those it declares on `defineApp`, else those of the catalog entry it was
 * installed from, matched by package. `pending` while that catalog entry may still arrive.
 */
export function useAppIconSources(app: App | undefined): {
  readonly sources: AppIconSources | null;
  readonly pending: boolean;
} {
  const catalog = useCatalogIcons();
  if (app === undefined) return { sources: null, pending: false };
  const declared = appIconSources(app.requirements.icons);
  if (declared !== null) return { sources: declared, pending: false };
  const origin = app.copiedFrom?.name;
  if (origin === undefined) return { sources: null, pending: false };
  return {
    sources: catalogIconSources(catalog.byPackage.get(origin)),
    pending: !catalog.settled,
  };
}

/**
 * An app's own icons when given or known to the catalog by name, otherwise the old product's
 * domain-derived logo, with a neutral fallback on image failure. While an own icon may still
 * arrive, the tile shows the loading skeleton instead of a domain logo that would then be replaced.
 */
export function ProviderIcon({
  name,
  url,
  icons,
  large = false,
  declared = null,
  pending = false,
}: {
  readonly name: string;
  readonly url?: string | null | undefined;
  readonly icons?: readonly CatalogIcon[] | undefined;
  readonly large?: boolean;
  /** An app's own icon, shown before the domain logo. */
  readonly declared?: AppIconSources | null;
  /** The app's own icon is still loading. */
  readonly pending?: boolean;
}) {
  const catalogIcons = useCatalogIcons();
  const { logo } = useProductBrand();
  const [failed, setFailed] = useState<readonly string[]>([]);
  const normalized = name.toLowerCase().trim();
  // Fetched large enough to stay sharp in the biggest tile on a 2x screen.
  const fetchSize = 64;
  const catalog = icons ?? catalogIcons.byName.get(normalized) ?? undefined;
  const domain = url ?? (/^[a-z\d-]+(?:\.[a-z\d-]+)+$/i.test(normalized) ? normalized : null);
  // The built-in app keeps the name Executor and shows the deployment's logo.
  const source = normalized === "executor" ? logo : faviconUrl(domain, fetchSize);
  const sources = declared ?? catalogIconSources(catalog);
  const waiting = sources === null && (pending || (icons === undefined && !catalogIcons.settled));
  const own = sources !== null && !failed.includes(sources.light) ? sources : null;
  const icon =
    own === null && !waiting && source !== null && !failed.includes(source) ? source : null;
  const fail = (key: string) => () =>
    setFailed((current) => (current.includes(key) ? current : [...current, key]));
  return (
    <span
      className={cn(
        // Logos are bare marks or shaped badges, so every one sits padded on the page background.
        // The mark scales with the tile, which keeps the padding even wherever a page resizes it.
        "provider-icon inline-flex size-8.5 shrink-0 items-center justify-center overflow-hidden rounded-[8px] border border-border bg-background [&_img]:size-[70%] [&_img]:object-contain [&_>_svg]:size-1/2 max-[740px]:[.catalog-row_>_&]:row-[1_/_3]",
        large && "provider-icon-large size-11 rounded-[10px]",
      )}
      aria-hidden
    >
      {own ? (
        // The browser picks the variant for the color scheme, so the server renders the same
        // markup. A srcset ends a URL at whitespace, which a data URI may hold escaped.
        <picture className="contents">
          {own.dark !== own.light && (
            <source
              media="(prefers-color-scheme: dark)"
              srcSet={own.dark.replace(/\s/gu, encodeURIComponent)}
            />
          )}
          <img
            src={own.light}
            alt=""
            width={fetchSize}
            height={fetchSize}
            referrerPolicy="no-referrer"
            data-icon="app"
            onError={fail(own.light)}
          />
        </picture>
      ) : icon ? (
        <img
          src={icon}
          alt=""
          width={fetchSize}
          height={fetchSize}
          referrerPolicy="no-referrer"
          onError={fail(icon)}
        />
      ) : waiting ? (
        <Skeleton className="size-full rounded-[inherit]" data-icon="loading" />
      ) : (
        <HugeiconsIcon icon={PackageIcon} aria-hidden size={large ? 23 : 17} strokeWidth={1.5} />
      )}
    </span>
  );
}

/**
 * The app's own icon (see `useAppIconSources`), or its first provider's logo when it has none.
 */
export function AppIcon({
  app,
  name,
  large = false,
}: {
  readonly app: App | undefined;
  /** Shown for the fallback when the app is unavailable. */
  readonly name?: string;
  readonly large?: boolean;
}) {
  const provider = app && Object.values(app.requirements.accounts)[0]?.definition;
  const { sources, pending } = useAppIconSources(app);
  return (
    <ProviderIcon
      name={provider?.name ?? app?.name ?? name ?? "App"}
      url={providerDisplayUrl(provider)}
      large={large}
      declared={sources}
      pending={pending}
    />
  );
}

/**
 * A provider row inside an app. An app with one provider is that provider's product, so the row
 * shows the app's own icon; an app combining several providers shows each one's logo.
 */
export function AppProviderIcon({
  app,
  provider,
  large = false,
}: {
  readonly app: App;
  readonly provider: ProviderDefinition;
  readonly large?: boolean;
}) {
  const { sources, pending } = useAppIconSources(app);
  const single =
    new Set(Object.values(app.requirements.accounts).map((slot) => slot.definition.name)).size ===
    1;
  return (
    <ProviderIcon
      name={provider.name}
      url={providerDisplayUrl(provider)}
      large={large}
      {...(single ? { declared: sources, pending } : {})}
    />
  );
}

/** A search field with a consistent accessible label and width. */
export function SearchInput({
  value,
  onChange,
  placeholder,
  autoFocus = false,
}: {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly placeholder: string;
  readonly autoFocus?: boolean;
}) {
  return (
    <div className="search-input min-w-0 relative w-[min(100%,_340px)] [&_>_svg]:absolute [&_>_svg]:left-2.75 [&_>_svg]:top-2.5 [&_>_svg]:text-muted-foreground [&_>_svg]:pointer-events-none [&_input]:pl-8.5 [&_input]:shadow-none [&_input]:h-8.75 [&_input]:text-[13px] [.apps-toolbar_&]:w-full max-[740px]:[&_input]:text-[16px] max-[740px]:w-full max-[740px]:[&_>_svg]:top-3.75 max-[740px]:[.tool-toolbar_&]:col-[1_/_-1]">
      <HugeiconsIcon icon={Search01Icon} strokeWidth={2} size={15} aria-hidden />
      <Input
        autoFocus={autoFocus}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
      />
    </div>
  );
}

export { LoadingRows } from "./context.tsx";

export { EmptyState as Empty } from "./empty-state.tsx";

/** Small section title, aligned with an optional trailing control. */
export function SectionHeading({
  children,
  action,
}: {
  readonly children: ReactNode;
  readonly action?: ReactNode;
}) {
  return (
    <div className="section-heading flex items-center justify-between [margin:24px_0_13px] [&_h2]:text-[13px] [&_h2]:font-medium [.section-toolbar_&]:m-0">
      <h2>{children}</h2>
      {action}
    </div>
  );
}
