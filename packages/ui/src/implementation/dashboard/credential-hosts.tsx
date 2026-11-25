import { Fragment, useId, useState, type ReactNode } from "react";
import { parse } from "tldts";

type HostPart =
  | {
      readonly type: "domain";
      readonly domain: string;
      readonly hosts: readonly string[];
    }
  | { readonly type: "host"; readonly host: string };

const registrableDomain = (host: string) => {
  if (host.startsWith("*.") || host.includes(":")) return undefined;
  const parsed = parse(host, { allowPrivateDomains: true });
  return parsed.domain !== null && (parsed.isIcann === true || parsed.isPrivate === true)
    ? parsed.domain
    : undefined;
};

const hostParts = (hosts: readonly string[]): readonly HostPart[] => {
  const byDomain = new Map<string, string[]>();
  for (const host of hosts) {
    const domain = registrableDomain(host);
    if (domain !== undefined) byDomain.set(domain, [...(byDomain.get(domain) ?? []), host]);
  }
  const groups = [...byDomain].filter(([, shared]) => shared.length > 1);
  const folded = new Set(groups.flatMap(([, shared]) => shared));
  return [
    ...groups.map(([domain, shared]): HostPart => ({ type: "domain", domain, hosts: shared })),
    ...hosts.filter((host) => !folded.has(host)).map((host): HostPart => ({ type: "host", host })),
  ];
};

export const HostChip = ({ host }: { readonly host: string }) => (
  <span className="rounded border border-border bg-muted/50 px-1 py-px font-mono text-[11px] text-foreground wrap-anywhere">
    {host}
  </span>
);

const wildcardMeaning = (host: string) => {
  const separator = host.lastIndexOf(":");
  const [name, port] =
    separator === -1 ? [host, ""] : [host.slice(0, separator), host.slice(separator + 1)];
  return `(any host directly under ${name.slice(2)}${port === "" ? "" : `, port ${port}`})`;
};

const NamedHost = ({ host }: { readonly host: string }) =>
  host.startsWith("*.") ? (
    <>
      <HostChip host={host} /> {wildcardMeaning(host)}
    </>
  ) : (
    <HostChip host={host} />
  );

const joined = (items: readonly ReactNode[]) =>
  items.map((item, index) => (
    <span key={index}>
      {index > 0 && (index === items.length - 1 ? " and " : ", ")}
      {item}
    </span>
  ));

export function CredentialHosts({
  hosts,
  lead,
  after,
}: {
  readonly hosts: readonly string[];
  readonly lead: string;
  readonly after?: string | undefined;
}) {
  const [expanded, setExpanded] = useState(false);
  const listId = useId();
  const parts = hostParts(hosts);
  const short = hosts.length > 2 && parts.some((part) => part.type === "domain");
  if (!short)
    return (
      <span className="min-w-0">
        {lead} {joined(hosts.map((host) => <NamedHost key={host} host={host} />))}.
        {after !== undefined && ` ${after}`}
      </span>
    );
  return (
    <div className="min-w-0" data-credential-hosts-summary>
      <span>
        {lead}{" "}
        {joined(
          parts.map((part) =>
            part.type === "domain" ? (
              <Fragment key={part.domain}>
                {part.hosts.length} hosts on <HostChip host={part.domain} />
              </Fragment>
            ) : (
              <NamedHost key={part.host} host={part.host} />
            ),
          ),
        )}
        .{after !== undefined && ` ${after}`}{" "}
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={listId}
          className="rounded-sm font-medium text-foreground/80 underline underline-offset-2 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? "Show less" : "Show all"}
        </button>
      </span>
      <ul
        id={listId}
        hidden={!expanded}
        aria-label="Hosts"
        className={`${expanded ? "grid" : "hidden"} mt-1.5 gap-x-4 gap-y-0.5 rounded-md border border-border bg-muted/40 px-2.5 py-1.5 sm:grid-cols-2`}
      >
        {hosts.map((host) => (
          <li key={host} className="min-w-0 font-mono text-[11px] text-foreground wrap-anywhere">
            {host}
            {host.startsWith("*.") && (
              <span className="font-sans text-muted-foreground"> {wildcardMeaning(host)}</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
