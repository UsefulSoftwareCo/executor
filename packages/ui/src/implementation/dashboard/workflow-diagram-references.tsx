import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowRight01Icon,
  Calendar03Icon,
  Globe02Icon,
  ToolsIcon,
  WebhookIcon,
  WorkflowSquare01Icon,
} from "@hugeicons/core-free-icons";
import type { App } from "@executor-js/sdk";
import type { Reference, Starter } from "@executor-js/workflow-graph/contracts/graph";
import type { ComponentProps, ReactNode } from "react";
import { providerDisplayUrl } from "../../contracts/dashboard.ts";
import { ProviderIcon } from "./common.tsx";
import { useDashboard } from "./context.tsx";
import { declaresHost } from "./workflow-diagram-cards.tsx";

/** Rows that name what a workflow or step uses or is started by, linking to where it lives. */

type IconSvgElement = ComponentProps<typeof HugeiconsIcon>["icon"];

export function Row({ name, children }: { readonly name: string; readonly children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{name}</dt>
      <dd className="m-0 min-w-0 break-words">{children}</dd>
    </>
  );
}

const referenceRow =
  "flex w-full min-w-0 items-center gap-2.5 rounded-lg border px-2.5 py-1.5 text-left text-[12.5px] hover:bg-muted/60 [&_.provider-icon]:size-6.5 [&_.provider-icon]:rounded-[6px]";

export function ReferenceRow({
  icon,
  tile,
  title,
  subtitle,
  onClick,
}: {
  readonly icon?: IconSvgElement;
  readonly tile?: ReactNode;
  readonly title: ReactNode;
  readonly subtitle: ReactNode;
  readonly onClick?: () => void;
}) {
  const content = (
    <>
      {tile ?? (
        <span className="flex size-6.5 shrink-0 items-center justify-center rounded-[6px] bg-accent text-foreground/80">
          {icon && <HugeiconsIcon icon={icon} size={14} strokeWidth={1.7} aria-hidden />}
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate">{title}</span>
        <span className="block truncate text-[11px] text-muted-foreground">{subtitle}</span>
      </span>
      {onClick && (
        <HugeiconsIcon
          icon={ArrowRight01Icon}
          size={14}
          className="shrink-0 text-muted-foreground"
          aria-hidden
        />
      )}
    </>
  );
  return onClick ? (
    <button type="button" className={referenceRow} onClick={onClick}>
      {content}
    </button>
  ) : (
    <div className={referenceRow}>{content}</div>
  );
}

export function StarterRow({
  app,
  starter,
  onShowWorkflow,
}: {
  readonly app: App;
  readonly starter: Starter;
  readonly onShowWorkflow: (name: string) => void;
}) {
  const { AppLink } = useDashboard();
  switch (starter.kind) {
    case "workflow":
      return (
        <ReferenceRow
          icon={WorkflowSquare01Icon}
          title={starter.name}
          subtitle={`${starter.step} · via ${starter.tool}`}
          onClick={() => onShowWorkflow(starter.name)}
        />
      );
    case "tool":
      return (
        <AppLink app={app.id} view="tools" tool={starter.path} className={referenceRow}>
          <ReferenceRowContent
            icon={ToolsIcon}
            title={<span className="font-mono text-[12px]">{starter.path}</span>}
            subtitle="Tool"
          />
        </AppLink>
      );
    case "schedule":
      return (
        <AppLink app={app.id} view="schedules" className={referenceRow}>
          <ReferenceRowContent
            icon={Calendar03Icon}
            title={starter.name}
            subtitle={`Schedule · runs ${starter.tool}`}
          />
        </AppLink>
      );
    case "webhook":
      return (
        <AppLink app={app.id} view="webhooks" className={referenceRow}>
          <ReferenceRowContent icon={WebhookIcon} title={starter.name} subtitle="Webhook" />
        </AppLink>
      );
  }
}

function ReferenceRowContent({
  icon,
  title,
  subtitle,
}: {
  readonly icon: IconSvgElement;
  readonly title: ReactNode;
  readonly subtitle: ReactNode;
}) {
  return (
    <>
      <span className="flex size-6.5 shrink-0 items-center justify-center rounded-[6px] bg-accent text-foreground/80">
        <HugeiconsIcon icon={icon} size={14} strokeWidth={1.7} aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate">{title}</span>
        <span className="block truncate text-[11px] text-muted-foreground">{subtitle}</span>
      </span>
      <HugeiconsIcon
        icon={ArrowRight01Icon}
        size={14}
        className="shrink-0 text-muted-foreground"
        aria-hidden
      />
    </>
  );
}

/** One thing a step uses, as a row of the step's details. */
export function UseRow({ app, use }: { readonly app: App; readonly use: Reference }) {
  const { AppLink } = useDashboard();
  switch (use.kind) {
    case "tool":
      return (
        <Row name="Tool">
          <AppLink
            app={app.id}
            view="tools"
            tool={use.path}
            className="font-mono text-[11.5px] underline decoration-input underline-offset-2"
          >
            {use.path}
          </AppLink>
        </Row>
      );
    case "account":
      return (
        <Row name="Account">
          <AppLink
            app={app.id}
            view="accounts"
            className="underline decoration-input underline-offset-2"
          >
            {app.requirements.accounts[use.slot]?.definition.name ?? use.slot}
          </AppLink>
          {use.scope && (
            <span className="text-muted-foreground">
              {" "}
              · {use.scope === "app" ? "app account" : "your account"}
            </span>
          )}
        </Row>
      );
    case "host":
      return <Row name="Talks to">{use.host}</Row>;
    case "workflow":
      return null;
  }
}

/** An account or host in the workflow's summary. */
export function UseReference({ app, use }: { readonly app: App; readonly use: Reference }) {
  const { AppLink } = useDashboard();
  if (use.kind === "host")
    return (
      <ReferenceRow
        {...(declaresHost(app, use.host)
          ? { tile: <ProviderIcon name={use.host} url={use.host} /> }
          : { icon: Globe02Icon })}
        title={use.host}
        subtitle="Host"
      />
    );
  if (use.kind !== "account") return null;
  const provider = app.requirements.accounts[use.slot]?.definition;
  return (
    <AppLink app={app.id} view="accounts" className={referenceRow}>
      {provider ? (
        <ProviderIcon name={provider.name} url={providerDisplayUrl(provider)} />
      ) : (
        <span className="flex size-6.5 shrink-0 items-center justify-center rounded-[6px] bg-accent">
          <HugeiconsIcon icon={Globe02Icon} size={14} strokeWidth={1.7} aria-hidden />
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate">{provider?.name ?? use.slot}</span>
        <span className="block truncate text-[11px] text-muted-foreground">Account</span>
      </span>
      <HugeiconsIcon
        icon={ArrowRight01Icon}
        size={14}
        className="shrink-0 text-muted-foreground"
        aria-hidden
      />
    </AppLink>
  );
}
