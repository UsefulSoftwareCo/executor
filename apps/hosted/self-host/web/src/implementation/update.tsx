import { useRef, useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import { Effect, Option, Schema } from "effect";
import { HttpClient } from "effect/http";
import { AsyncResult, Atom } from "effect/reactivity";
import { BrowserAtoms } from "@executor-js/hosted-web/contracts/telemetry";
import { useOrganizationRoute } from "@executor-js/hosted-web/organization";
import { browserOnly, dashboardHttpClient } from "@executor-js/ui/contracts/http";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@executor-js/ui/components/dialog";
import { SidebarNews } from "@executor-js/ui/dashboard/sidebar-news";

const image = "ghcr.io/usefulsoftwareco/executor-selfhost";
const version = Schema.String.check(Schema.isPattern(/^2\.\d+\.\d+(?:-beta\.\d+)?$/u));
const UpdateStatus = Schema.Struct({
  update: Schema.NullOr(Schema.Struct({ current: version, available: version })),
});
type Update = NonNullable<typeof UpdateStatus.Type.update>;

const updateAtom = Atom.family((organization: string) =>
  browserOnly(
    BrowserAtoms.atom(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        const response = yield* client.get(
          `/api/self-host/update?organization=${encodeURIComponent(organization)}`,
        );
        if (response.status !== 200) return Option.none<Update>();
        const status = yield* Schema.decodeUnknownEffect(UpdateStatus)(yield* response.json);
        return Option.fromNullOr(status.update);
      }).pipe(
        Effect.orElseSucceed(() => Option.none<Update>()),
        Effect.provide(dashboardHttpClient),
      ),
    ),
  ),
);
const noUpdate = Atom.make(AsyncResult.success(Option.none<Update>()));

export function useSelfHostUpdate() {
  const { slug, role } = useOrganizationRoute();
  const result = useAtomValue(role === "owner" || role === "admin" ? updateAtom(slug) : noUpdate);
  return AsyncResult.isSuccess(result) ? result.value : Option.none<Update>();
}

export function SelfHostUpdateBlock({ update }: { readonly update: Update }) {
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const pull = `docker pull ${image}:${update.available}`;
  return (
    <>
      <SidebarNews
        tag="Update available"
        open={{ label: `How to update to v${update.available}`, onOpen: () => setOpen(true) }}
        buttonRef={opener}
      >
        Version {update.available} is available.
      </SidebarNews>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          className="self-host-update gap-4 sm:max-w-md"
          onCloseAutoFocus={(event) => {
            if (opener.current === null) return;
            event.preventDefault();
            opener.current.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>How to update</DialogTitle>
            <DialogDescription>
              This instance runs v{update.current}; v{update.available} is available. Only owners
              and admins see this.
            </DialogDescription>
          </DialogHeader>
          <ol className="grid list-decimal gap-3 pl-5 text-[13px] leading-snug">
            <li>Stop the container and back up its data volume.</li>
            <li>
              <div className="grid gap-1.5">
                <span>Pull the new image:</span>
                <pre className="rounded-md bg-muted p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-all">
                  {pull}
                </pre>
              </div>
            </li>
            <li>
              Remove only the stopped container, then run it again with the same volume and
              settings.
            </li>
          </ol>
          <div className="grid gap-1.5 text-[12px] text-muted-foreground">
            <a
              href={`https://github.com/UsefulSoftwareCo/executor/releases/tag/${encodeURIComponent(`executor@${update.available}`)}`}
              target="_blank"
              rel="noopener noreferrer"
              className="justify-self-start underline-offset-2 hover:text-foreground hover:underline"
            >
              What changed in v{update.available}
            </a>
            <p>
              The server checks for a new release once a day and sends nothing about this instance.
              Set EXECUTOR_NO_UPDATE_CHECK=1 to turn the check off.
            </p>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
