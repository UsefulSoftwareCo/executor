// Reworked: authenticating one account.
//
// The whole screen is built from the registry's own credential record, which
// integrations.sh already returns and the console currently discards:
//   credentials[].label       → what this key is called at the provider
//   credentials[].generateUrl → the page that mints it, as a real link
//   credentials[].setup       → how to mint it, in the provider's own terms
//
// So the three questions the current modal leaves unanswered — what kind of key,
// where do I get one, where does it go — are answered on the screen that asks
// for it. The paste field is the first focusable thing and is never gated: a
// key already on the clipboard can go in immediately.

import { useEffect, useState } from "react";
import { ArrowUpRightIcon, EyeIcon, EyeOffIcon } from "lucide-react";
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
import { fetchSurfaceCredentials, type SurfaceCredential } from "../../fixtures";

/** The registry's setup text is markdown. Only links and bold appear in
 *  practice, so render those two and leave the rest as text rather than
 *  pulling in a markdown pipeline for a prototype. */
function SetupText(props: { readonly text: string }) {
  const nodes = props.text
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
    });
  return <p className="text-xs leading-relaxed text-muted-foreground">{nodes}</p>;
}

export function AuthenticateDialog(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly integrationName: string;
  readonly domain: string;
  readonly accountLabel: string;
  readonly onAuthenticated: () => void;
}) {
  const [credentials, setCredentials] = useState<readonly SurfaceCredential[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [secret, setSecret] = useState("");
  const [revealed, setRevealed] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let live = true;
    void fetchSurfaceCredentials(props.domain).then((loaded) => {
      if (!live) return;
      setCredentials(loaded);
      setSelectedId(loaded[0]?.id ?? null);
    });
    return () => {
      live = false;
    };
  }, [props.domain]);

  const selected = credentials?.find((candidate) => candidate.id === selectedId) ?? null;
  const isOAuth = selected?.type === "oauth2";
  const canSubmit = isOAuth || secret.trim().length > 0;

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Connect {props.integrationName}</DialogTitle>
          <DialogDescription>
            Signing in as <span className="font-mono text-foreground">{props.accountLabel}</span>.
          </DialogDescription>
        </DialogHeader>

        {credentials === null ? (
          <p className="py-6 text-sm text-muted-foreground">
            Checking how {props.domain} signs in…
          </p>
        ) : credentials.length === 0 ? (
          <p className="py-6 text-sm text-muted-foreground">
            The registry has no credential record for {props.domain} yet.
          </p>
        ) : (
          <div className="flex flex-col gap-4">
            {/* Only shown when the provider genuinely offers a choice. One way
                in renders no picker at all. */}
            {credentials.length > 1 && (
              <div className="flex gap-1.5">
                {credentials.map((credential) => (
                  // oxlint-disable-next-line react/forbid-elements
                  <button
                    key={credential.id}
                    type="button"
                    onClick={() => setSelectedId(credential.id)}
                    className={
                      credential.id === selectedId
                        ? "rounded-full border border-foreground/20 bg-foreground px-3 py-1 text-xs font-medium text-background"
                        : "rounded-full border border-border px-3 py-1 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
                    }
                  >
                    {credential.label}
                  </button>
                ))}
              </div>
            )}

            {isOAuth ? (
              <p className="text-xs leading-relaxed text-muted-foreground">
                {props.integrationName} signs in through your browser. Nothing to paste.
              </p>
            ) : (
              <>
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-3">
                    <Label
                      htmlFor="credential"
                      className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground"
                    >
                      {selected?.label ?? "API key"}
                    </Label>
                    {selected?.generateUrl ? (
                      <a
                        href={selected.generateUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="flex items-center gap-1 text-xs font-medium text-foreground underline underline-offset-2"
                      >
                        Get a key
                        <ArrowUpRightIcon className="size-3" aria-hidden />
                      </a>
                    ) : null}
                  </div>
                  <div className="flex items-center gap-1">
                    {/* oxlint-disable-next-line react/forbid-elements */}
                    <input
                      id="credential"
                      type={revealed ? "text" : "password"}
                      autoComplete="off"
                      // The one thing this screen is for.
                      // oxlint-disable-next-line jsx_a11y/no-autofocus
                      autoFocus
                      value={secret}
                      onChange={(event) => setSecret(event.target.value)}
                      placeholder="Paste your key"
                      className="h-10 min-w-0 flex-1 rounded-md border border-input bg-transparent px-3 font-mono text-sm outline-none transition-colors focus:border-ring dark:bg-input/30"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Show key"
                      aria-pressed={revealed}
                      className="shrink-0 text-muted-foreground"
                      onClick={() => setRevealed((value) => !value)}
                    >
                      {revealed ? <EyeOffIcon /> : <EyeIcon />}
                    </Button>
                  </div>
                </div>

                {selected?.setup ? (
                  <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-3">
                    <SetupText text={selected.setup} />
                  </div>
                ) : null}
              </>
            )}
          </div>
        )}

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => props.onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={!canSubmit || submitting}
            loading={submitting}
            onClick={() => {
              setSubmitting(true);
              setTimeout(() => {
                setSubmitting(false);
                props.onAuthenticated();
              }, 700);
            }}
          >
            {isOAuth ? `Continue to ${props.integrationName}` : "Connect"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
