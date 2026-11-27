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
const noIcons = Atom.make(noCatalogIcons);

const useCatalogIcons = (): CatalogIcons => {
  const dashboard = useOptionalDashboard();
  return useAtomValue(dashboard ? dashboard.catalogIcons : noIcons);
};

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
  readonly declared?: AppIconSources | null;
  readonly pending?: boolean;
}) {
  const catalogIcons = useCatalogIcons();
  const [failed, setFailed] = useState<readonly string[]>([]);
  const normalized = name.toLowerCase().trim();
  const fetchSize = 64;
  const catalog = icons ?? catalogIcons.byName.get(normalized) ?? undefined;
  const domain = url ?? (/^[a-z\d-]+(?:\.[a-z\d-]+)+$/i.test(normalized) ? normalized : null);
  const source = normalized === "executor" ? "/favicon.png" : faviconUrl(domain, fetchSize);
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
        "provider-icon inline-flex size-8.5 shrink-0 items-center justify-center overflow-hidden rounded-[8px] border border-border bg-background [&_img]:size-[70%] [&_img]:object-contain [&_>_svg]:size-1/2 max-[740px]:[.catalog-row_>_&]:row-[1_/_3]",
        large && "provider-icon-large size-11 rounded-[10px]",
      )}
      aria-hidden
    >
      {own ? (
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

export function AppIcon({
  app,
  name,
  large = false,
}: {
  readonly app: App | undefined;
  readonly name?: string;
  readonly large?: boolean;
}) {
  const provider = app && Object.values(app.requirements.accounts)[0]?.definition;
  const { sources, pending } = useAppIconSources(app);
  const dashboard = useOptionalDashboard();
  const retained =
    sources === null && !pending && app !== undefined && app.activeVersion !== null
      ? dashboard?.appIconUrl?.(app)
      : undefined;
  const [loaded, setLoaded] = useState<string | null>(null);
  const shown = retained !== undefined && loaded === retained ? retained : null;
  return (
    <>
      <ProviderIcon
        name={provider?.name ?? app?.name ?? name ?? "App"}
        url={providerDisplayUrl(provider)}
        large={large}
        declared={shown === null ? sources : { light: shown, dark: shown }}
        pending={pending}
      />
      {retained !== undefined && shown === null && (
        <img
          src={retained}
          alt=""
          hidden
          referrerPolicy="no-referrer"
          ref={(image) => {
            if (image?.complete === true && image.naturalWidth > 0) setLoaded(retained);
          }}
          onLoad={() => setLoaded(retained)}
        />
      )}
    </>
  );
}

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
