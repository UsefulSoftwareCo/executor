import { useMemo } from "react";
import { ArrowUpRightIcon } from "lucide-react";
import { getDomain } from "tldts";

import { useCredentialGuidance } from "../lib/integrations-sh-catalog";

// ---------------------------------------------------------------------------
// What this key is, and where to get one.
//
// The registry records, per provider, what the credential is called, the page
// that mints it, and the provider's own setup steps. Asking someone for a key
// without any of that is the reason the connect form produced "Okay so what
// type of key do I need?" — the answer existed, one fetch away, and was thrown
// out on arrival.
//
// Strictly supplementary: the form works unchanged when the registry knows
// nothing, and this renders nothing at all rather than an empty frame.
// ---------------------------------------------------------------------------

/** The registry's setup text is markdown. Links, bold and inline code are all
 *  that occur in practice, so render those three rather than pull a markdown
 *  pipeline into a form. */
function SetupText(props: { readonly text: string }) {
  const nodes = useMemo(
    () =>
      props.text
        .split(/(\[[^\]]+\]\([^)]+\)|\*\*[^*]+\*\*|`[^`]+`)/g)
        .filter((chunk) => chunk.length > 0)
        .map((chunk, index) => {
          const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(chunk);
          if (link) {
            return (
              <a
                key={index}
                href={link[2]}
                target="_blank"
                rel="noreferrer"
                className="font-medium text-foreground underline underline-offset-2"
              >
                {link[1]}
              </a>
            );
          }
          const bold = /^\*\*([^*]+)\*\*$/.exec(chunk);
          if (bold) {
            return (
              <span key={index} className="font-medium text-foreground">
                {bold[1]}
              </span>
            );
          }
          const code = /^`([^`]+)`$/.exec(chunk);
          if (code) {
            return (
              <code key={index} className="font-mono text-[0.9em] text-foreground">
                {code[1]}
              </code>
            );
          }
          return <span key={index}>{chunk}</span>;
        }),
    [props.text],
  );
  return <p className="text-xs leading-relaxed text-muted-foreground">{nodes}</p>;
}

export function CredentialGuidancePanel(props: {
  /** The integration's display URL; the domain is read from it. */
  readonly displayUrl: string | undefined;
  /** "oauth" hides key guidance — there is no key to fetch. */
  readonly methodKind: string | undefined;
}) {
  const domain = useMemo(
    () => (props.displayUrl ? getDomain(props.displayUrl) : null),
    [props.displayUrl],
  );
  const guidance = useCredentialGuidance(domain);

  const relevant = useMemo(() => {
    if (props.methodKind === "oauth") {
      return guidance.find((entry) => entry.type.startsWith("oauth"));
    }
    // Anything that is not an OAuth grant is the key the form is asking for.
    return guidance.find((entry) => !entry.type.startsWith("oauth")) ?? guidance[0];
  }, [guidance, props.methodKind]);

  if (!relevant || (!relevant.generateUrl && !relevant.setup)) return null;

  return (
    <div className="space-y-1.5 rounded-md border border-border/60 bg-muted/20 px-3 py-2.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-xs font-medium text-foreground">{relevant.label}</span>
        {relevant.generateUrl ? (
          <a
            href={relevant.generateUrl}
            target="_blank"
            rel="noreferrer"
            className="flex shrink-0 items-center gap-1 text-xs font-medium text-foreground underline underline-offset-2"
          >
            Get a key
            <ArrowUpRightIcon className="size-3" aria-hidden />
          </a>
        ) : null}
      </div>
      {relevant.setup ? <SetupText text={relevant.setup} /> : null}
    </div>
  );
}
