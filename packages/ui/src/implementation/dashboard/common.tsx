import { HugeiconsIcon } from "@hugeicons/react";
import { PackageIcon, Search01Icon } from "@hugeicons/core-free-icons";
import { Atom } from "effect/unstable/reactivity";
import { useOptionalDashboard } from "./context.tsx";
import { useState, type ReactNode } from "react";
import { useAtomValue } from "@effect/atom-react";
import { faviconUrl } from "../../contracts/icons.ts";
import { Input } from "@executor-js/ui/components/input";
import { cn } from "@executor-js/ui/lib/utils";
const noDomains = Atom.make(new Map<string, string | null>());
/** Share the old product's domain-derived logos and retain a neutral fallback on image failure. */
export function ProviderIcon({
  name,
  url,
  large = false,
}: {
  readonly name: string;
  readonly url?: string | null | undefined;
  readonly large?: boolean;
}) {
  const dashboard = useOptionalDashboard();
  const domains = useAtomValue(dashboard ? dashboard.iconDomains : noDomains);
  const [failed, setFailed] = useState<readonly string[]>([]);
  const normalized = name.toLowerCase().trim();
  const size = large ? 24 : 17;
  const domain =
    url ??
    domains.get(normalized) ??
    (/^[a-z\d-]+(?:\.[a-z\d-]+)+$/i.test(normalized) ? normalized : null);
  const source = normalized === "executor" ? "/favicon.png" : faviconUrl(domain, size);
  const icon = source !== null && !failed.includes(source) ? source : null;
  return (
    <span
      className={cn(
        "provider-icon w-8.5 h-8.5 border border-border rounded-[7px] inline-flex items-center justify-center bg-background shrink-0 [&_img]:w-4.25 [&_img]:h-4.25 [&_img]:object-contain [&_>_svg]:w-4.25 [&_>_svg]:h-4.25 [&_>_svg]:object-contain max-[740px]:[.catalog-row_>_&]:row-[1_/_3]",
        large &&
          "provider-icon-large w-11 h-11 rounded-[9px] [&_img]:w-6 [&_img]:h-6 [&_>_svg]:w-6 [&_>_svg]:h-6",
      )}
      aria-hidden
    >
      {icon ? (
        <img
          src={icon}
          alt=""
          width={size}
          height={size}
          referrerPolicy="no-referrer"
          onError={() =>
            setFailed((current) => (current.includes(icon) ? current : [...current, icon]))
          }
        />
      ) : (
        <HugeiconsIcon icon={PackageIcon} aria-hidden size={large ? 23 : 17} strokeWidth={1.5} />
      )}
    </span>
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
