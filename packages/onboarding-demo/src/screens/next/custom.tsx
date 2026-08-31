// Reworked: adding something the registry has never heard of.
//
// This is the case the picker cannot cover and executor exists for — an
// internal API, a private MCP server, a spec behind a VPN. It has to be a
// first-class door, not the fallback you reach after search disappoints.
//
// The rule that keeps it simple: paste one URL, we say what we found, you add
// it. What comes out the other side is an ordinary added integration with an
// ordinary "Needs auth" account — identical to a registry pick from that point
// on, because the only thing the registry was ever providing is the definition.

import { useState } from "react";
import { ArrowUpRightIcon } from "lucide-react";
import { Button } from "@executor-js/react/components/button";
import { Label } from "@executor-js/react/components/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@executor-js/react/components/dialog";
import { getDomain } from "tldts";
import { logoFor, type AddedIntegration } from "../../catalog";
import { INTEGRATIONS_SH_ORIGIN } from "../../fixtures";

type Kind = "mcp" | "openapi" | "graphql";

const KIND_LABEL: Record<Kind, string> = {
  mcp: "MCP server",
  openapi: "OpenAPI spec",
  graphql: "GraphQL endpoint",
};

interface Detected {
  readonly kind: Kind;
  readonly domain: string;
  readonly url: string;
  /** A registry entry related to this URL, if there is one. `exact` separates
   *  two genuinely different situations that a string match cannot tell apart
   *  on its own: the host IS the registry entry, versus the host merely sits
   *  under a domain the registry knows. `mcp.posthog.com` under `posthog.com`
   *  is probably the same service; `internal.acme.com` under `acme.com` is
   *  probably not, so the copy must not claim it is. */
  readonly registryDomain: string | null;
  readonly exact: boolean;
}

const guessKind = (url: URL): Kind => {
  const path = `${url.pathname}${url.search}`.toLowerCase();
  if (path.includes("graphql")) return "graphql";
  if (/\/mcp\b|\/sse\b/.test(path)) return "mcp";
  if (/openapi|swagger|\.ya?ml$|\.json$/.test(path)) return "openapi";
  // A bare origin is most often an MCP server these days; the detect step in
  // the real product probes rather than guesses.
  return path === "/" || path.length === 0 ? "mcp" : "openapi";
};

const detect = async (raw: string): Promise<Detected | { readonly error: string }> => {
  const trimmed = raw.trim();
  const withScheme = /^[a-z][a-z0-9+\-.]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const parsed = ((): URL | null => {
    // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: URL parsing reports failure by throwing
    try {
      return new URL(withScheme);
    } catch {
      return null;
    }
  })();
  if (!parsed) return { error: "That doesn't look like a URL." };

  const host = parsed.hostname.replace(/^www\./, "");
  // The registry keys on the registrable domain, so an endpoint living on a
  // subdomain (`mcp.posthog.com`) only matches once we also try its parent.
  const candidates = [...new Set([host, getDomain(host)])].filter(
    (candidate): candidate is string => candidate !== null && candidate.length > 0,
  );
  const registryDomain = await (async () => {
    for (const candidate of candidates) {
      // A miss and a network failure mean the same thing here — nothing extra
      // to offer — so both just move on to the next candidate.
      // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: fetch reports transport failure by rejecting
      try {
        const response = await fetch(
          `${INTEGRATIONS_SH_ORIGIN}/api/${encodeURIComponent(candidate)}/surface`,
        );
        if (response.ok) return candidate;
      } catch {
        continue;
      }
    }
    return null;
  })();

  return {
    kind: guessKind(parsed),
    domain: host,
    url: parsed.toString(),
    registryDomain,
    exact: registryDomain === host,
  };
};

export function AddCustomDialog(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onAdd: (integration: AddedIntegration) => void;
}) {
  const [raw, setRaw] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Detected | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setError(null);
    const outcome = await detect(raw);
    setBusy(false);
    if ("error" in outcome) {
      setError(outcome.error);
      setResult(null);
      return;
    }
    setResult(outcome);
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add a custom integration</DialogTitle>
          <DialogDescription>
            Point at an MCP server, an OpenAPI spec, or a GraphQL endpoint. It does not need to be
            in the registry.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="space-y-2">
            <Label
              htmlFor="custom-url"
              className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground"
            >
              URL
            </Label>
            <div className="flex gap-2">
              {/* oxlint-disable-next-line react/forbid-elements */}
              <input
                id="custom-url"
                // oxlint-disable-next-line jsx_a11y/no-autofocus -- the only field on the screen
                autoFocus
                value={raw}
                onChange={(event) => {
                  setRaw(event.target.value);
                  setResult(null);
                  setError(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && raw.trim().length > 0) void run();
                }}
                placeholder="https://internal.acme.com/mcp"
                className="h-10 min-w-0 flex-1 rounded-md border border-input bg-transparent px-3 font-mono text-sm outline-none transition-colors focus:border-ring dark:bg-input/30"
              />
              <Button
                type="button"
                variant="outline"
                disabled={raw.trim().length === 0 || busy}
                loading={busy}
                onClick={() => void run()}
              >
                Check
              </Button>
            </div>
            {error ? <p className="text-xs text-destructive">{error}</p> : null}
          </div>

          {result ? (
            <div className="space-y-2 rounded-lg border border-border bg-muted/20 px-3 py-3">
              <div className="flex items-center gap-2.5">
                <img
                  src={logoFor(result.domain)}
                  alt=""
                  className="size-6 shrink-0 rounded object-contain"
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-foreground">{result.domain}</p>
                  <p className="text-xs text-muted-foreground">{KIND_LABEL[result.kind]}</p>
                </div>
              </div>
              {result.registryDomain ? (
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {result.exact
                    ? `The registry already covers ${result.registryDomain}. Adding it from search brings the credential setup instructions with it — this URL will be added as-is, with none of that.`
                    : `The registry has an entry for ${result.registryDomain}, which may or may not be the same service as this host. This URL will be added as-is either way.`}{" "}
                  <a
                    href={`${INTEGRATIONS_SH_ORIGIN}/${result.registryDomain}/`}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-0.5 font-medium text-foreground underline underline-offset-2"
                  >
                    See the entry
                    <ArrowUpRightIcon className="size-3" aria-hidden />
                  </a>
                </p>
              ) : (
                <p className="text-xs leading-relaxed text-muted-foreground">
                  Not in the registry. You&apos;ll set up its credential yourself on the next
                  screen.
                </p>
              )}
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => props.onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={result === null}
            onClick={() => {
              if (!result) return;
              props.onAdd({
                domain: result.domain,
                name: result.domain,
                description: `${KIND_LABEL[result.kind]} at ${result.url}`,
                icon: logoFor(result.domain),
                formats: [result.kind],
                source: "custom",
                url: result.url,
              });
            }}
          >
            Add integration
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
