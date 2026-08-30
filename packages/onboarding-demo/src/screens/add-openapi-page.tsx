// Reproduction of packages/plugins/openapi/src/react/AddOpenApiIntegration.tsx
// in its post-analyze state, plus the AuthMethodListEditor block from
// packages/react/src/components/auth-method-list-editor.tsx.
//
// The locked "Method 1" panel is reproduced exactly: LockIcon, muted fill,
// `cursor-not-allowed select-none`, and a masked `Authorization: Bearer ••••••`
// placement line. It is a read-only echo of the spec's declared auth scheme —
// it takes no input — but it is the only credential-shaped thing on the page,
// and it appears at the moment the user has just copied an API key.

import { useState } from "react";
import { LockIcon, XIcon, ChevronDownIcon } from "lucide-react";
import { Button } from "@executor-js/react/components/button";
import { Input } from "@executor-js/react/components/input";
import { Label } from "@executor-js/react/components/label";
import { CardStack, CardStackContent } from "@executor-js/react/components/card-stack";
import type { DemoPreset } from "../fixtures";

function PlacementLine(props: {
  readonly carrier: "header" | "query";
  readonly name: string;
  readonly prefix: string;
}) {
  const lead = props.carrier === "header" ? `${props.name}: ` : `?${props.name}=`;
  return (
    <span className="wrap-anywhere whitespace-pre-wrap font-mono text-xs text-muted-foreground">
      {lead}
      {props.prefix ? <span className="text-muted-foreground/60">{props.prefix}</span> : null}
      <span className="tracking-widest text-primary">••••••</span>
    </span>
  );
}

function FieldLabel(props: { readonly children: React.ReactNode }) {
  return (
    <Label className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
      {props.children}
    </Label>
  );
}

export function AddOpenApiPage(props: {
  readonly preset: DemoPreset | null;
  readonly onCancel: () => void;
  readonly onComplete: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [overridesOpen, setOverridesOpen] = useState(false);
  const [healthCheckOpen, setHealthCheckOpen] = useState(false);
  const name = props.preset?.name ?? "API";
  const slug = props.preset?.id ?? "api";

  return (
    <div className="relative min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex min-h-full max-w-4xl flex-col gap-6 px-6 py-10 lg:px-10 lg:py-14">
        <div>
          <h1 className="text-xl font-semibold text-foreground">Add OpenAPI integration</h1>
        </div>

        {/* Details — OpenApiIntegrationDetailsFields */}
        <CardStack>
          <CardStackContent className="border-t-0">
            <div className="flex items-start gap-3 px-4 py-4">
              {props.preset?.icon ? (
                <img src={props.preset.icon} alt="" className="size-8 shrink-0 object-contain" />
              ) : (
                <span className="size-8 shrink-0 rounded-md bg-muted" />
              )}
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">{name}</p>
                <p className="text-xs text-muted-foreground">1.0.0 · 214 operations · 31 tags</p>
              </div>
            </div>
            <div className="space-y-4 px-4 pb-4">
              <div className="space-y-2">
                <FieldLabel>Integration ID</FieldLabel>
                <Input defaultValue={slug} className="font-mono text-sm" />
              </div>
              <div className="space-y-2">
                <FieldLabel>Display name</FieldLabel>
                <Input defaultValue={name} />
              </div>
              <div className="space-y-2">
                <FieldLabel>Description</FieldLabel>
                <Input defaultValue={props.preset?.summary ?? ""} />
              </div>
              <div className="space-y-2">
                <FieldLabel>Base URL override (optional)</FieldLabel>
                <Input placeholder="https://api.example.com" className="font-mono text-sm" />
                <p className="text-[11px] text-muted-foreground">
                  Overrides the spec&apos;s servers; leave empty to choose the server (and
                  variables) per tool call.
                </p>
              </div>
              <div className="space-y-2">
                <FieldLabel>OpenAPI spec</FieldLabel>
                <Input defaultValue={props.preset?.url ?? ""} className="font-mono text-sm" />
              </div>
            </div>
          </CardStackContent>
        </CardStack>

        {/* SpecOverridesEditor — collapsed */}
        <section className="space-y-2">
          {/* oxlint-disable-next-line react/forbid-elements */}
          <button
            type="button"
            onClick={() => setOverridesOpen((open) => !open)}
            className="flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            Spec overrides (optional)
            <ChevronDownIcon className={overridesOpen ? "size-3.5 rotate-180" : "size-3.5"} />
          </button>
          {overridesOpen && (
            <div className="rounded-lg border border-border/60 bg-muted/20 p-3 font-mono text-xs text-muted-foreground">
              []
            </div>
          )}
        </section>

        {/* AuthMethodListEditor */}
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Authentication
            </h3>
            <Button type="button" variant="outline" size="sm">
              Add method
            </Button>
          </div>

          <div className="flex flex-col gap-3">
            <div className="space-y-2 rounded-lg border border-border/60 bg-muted/20 p-3">
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                  <LockIcon className="size-3 shrink-0" aria-hidden />
                  <span>Method 1</span>
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Remove method"
                  className="text-muted-foreground hover:text-foreground"
                >
                  <XIcon />
                </Button>
              </div>
              <div className="space-y-2">
                <p className="font-mono text-[11px] uppercase tracking-wide text-muted-foreground">
                  API key
                </p>
                <div
                  aria-disabled
                  className="cursor-not-allowed select-none space-y-1 rounded-md border border-border/60 bg-muted/40 px-3 py-2.5 text-muted-foreground"
                >
                  <div className="flex flex-wrap gap-x-4 gap-y-1">
                    <PlacementLine carrier="header" name="Authorization" prefix="Bearer " />
                  </div>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  Pulled from spec. Remove to override.
                </p>
              </div>
            </div>

            <div className="space-y-2 rounded-lg border border-border/60 bg-muted/20 p-3">
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                  <LockIcon className="size-3 shrink-0" aria-hidden />
                  <span>Method 2</span>
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Remove method"
                  className="text-muted-foreground hover:text-foreground"
                >
                  <XIcon />
                </Button>
              </div>
              <div className="space-y-2">
                <p className="font-mono text-[11px] uppercase tracking-wide text-muted-foreground">
                  OAuth
                </p>
                <div
                  aria-disabled
                  className="cursor-not-allowed select-none space-y-1 rounded-md border border-border/60 bg-muted/40 px-3 py-2.5 text-muted-foreground"
                >
                  <div className="flex gap-2 text-xs">
                    <span className="w-20 shrink-0 text-muted-foreground">Authorize</span>
                    <span className="break-all font-mono text-foreground/80">
                      https://us.posthog.com/oauth/authorize
                    </span>
                  </div>
                  <div className="flex gap-2 text-xs">
                    <span className="w-20 shrink-0 text-muted-foreground">Token</span>
                    <span className="break-all font-mono text-foreground/80">
                      https://us.posthog.com/oauth/token
                    </span>
                  </div>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  Pulled from spec. Remove to override.
                </p>
              </div>
            </div>
          </div>

          <p className="text-[11px] text-muted-foreground">
            Every method here is registered with the integration. Connect an account from the
            integration page after adding.
          </p>
        </section>

        {/* AddOpenApiHealthCheckSection */}
        <section className="space-y-2">
          {/* oxlint-disable-next-line react/forbid-elements */}
          <button
            type="button"
            onClick={() => setHealthCheckOpen((open) => !open)}
            className="flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            Health check (optional)
            <ChevronDownIcon className={healthCheckOpen ? "size-3.5 rotate-180" : "size-3.5"} />
          </button>
          {healthCheckOpen && (
            <div className="space-y-2 rounded-lg border border-border/60 bg-muted/20 p-3">
              <FieldLabel>Operation</FieldLabel>
              <Input placeholder="Pick an operation to probe…" />
            </div>
          )}
        </section>

        {/* FloatActions */}
        <CardStack className="sticky bottom-4 left-0 right-0 mt-auto w-full transform-gpu shadow-lg">
          <div className="flex items-center justify-end gap-3 px-4 py-3">
            <Button variant="ghost" onClick={props.onCancel} disabled={adding}>
              Cancel
            </Button>
            <Button
              loading={adding}
              onClick={() => {
                setAdding(true);
                // The real add is a spec parse + persist round trip; the button
                // spins for as long as it takes, with nothing else to do.
                setTimeout(() => {
                  setAdding(false);
                  props.onComplete();
                }, 1600);
              }}
            >
              Add integration
            </Button>
          </div>
        </CardStack>
      </div>
    </div>
  );
}
