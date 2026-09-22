/** Resolve background configuration failures for the selected profile. */
import { type Profile, type ProfileInputs, type WebhookSubscription } from "@executor-js/sdk";
import type { Atom } from "effect/unstable/reactivity";
import type { ComponentType, ReactNode } from "react";
import type { FailureProps, Query } from "../../contracts/dashboard.ts";
import { QueryView } from "./context.tsx";
import { Button } from "../components/button.tsx";
import { WebhookConfiguration } from "./webhooks.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "../components/dialog.tsx";

type ConfigurationProps<E> = {
  readonly profile: Profile;
  readonly update: Atom.AtomResultFn<
    Omit<typeof ProfileInputs.update.Type, "app" | "profile">,
    Profile,
    E
  >;
  readonly Failure: ComponentType<FailureProps<E>>;
};

/** Healthy background setup stays invisible; failures expose the required configuration. */
export function ProfileResources<E>({
  profile,
  update,
  hooks,
  Failure,
  setupLink,
  label,
}: ConfigurationProps<E> & {
  readonly hooks: Query<readonly WebhookSubscription[], E>;
  readonly setupLink: (subscription: WebhookSubscription) => ReactNode;
  readonly label: string;
}) {
  const needsSetup = profile.failure === "configuration" || profile.failure === "cleanup";
  return (
    <div className="flex items-center gap-2">
      {needsSetup && (
        <Dialog>
          <DialogTrigger asChild>
            <Button variant="outline" size="sm">
              Resolve webhooks
            </Button>
          </DialogTrigger>
          <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-[560px]">
            <DialogTitle>Webhook setup</DialogTitle>
            <DialogDescription>{label}</DialogDescription>
            <QueryView
              query={hooks}
              Failure={Failure}
              pending={<p className="text-sm text-muted-foreground">Loading webhook status…</p>}
            >
              {(rows) => (
                <div className="space-y-2">
                  {rows
                    .filter((row) => row.status !== "stopped")
                    .map((row) => (
                      <div key={row.id} className="flex items-center justify-between gap-3 text-sm">
                        <span>
                          {row.name} · {row.status.replaceAll("-", " ")}
                        </span>
                        {(row.status === "setup-required" || row.status === "disabled") &&
                          setupLink(row)}
                      </div>
                    ))}
                </div>
              )}
            </QueryView>
            {profile.failure === "configuration" && (
              <WebhookConfiguration profile={profile} update={update} Failure={Failure} />
            )}
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
