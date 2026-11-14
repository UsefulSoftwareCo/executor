import { useState, type ReactElement, type ReactNode } from "react";
import type { CustomAppInput } from "@executor-js/catalog/contracts";
import type { DeployedApp } from "@executor-js/sdk";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import {
  AiMagicIcon,
  ArrowDown01Icon,
  McpServerIcon,
  Store01Icon,
} from "@hugeicons/core-free-icons";
import type { MutationProps } from "../../contracts/dashboard.ts";
import { Button } from "../components/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../components/dialog.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../components/dropdown-menu.tsx";
import { Textarea } from "../components/textarea.tsx";
import { AgentSetupPrompt, newAppPrompt } from "./agent-setup.tsx";
import { CustomAppForm } from "./custom-app.tsx";

/** The product's bindings for the custom app and MCP server dialogs. */
export type AddAppDialogProps<E> = MutationProps<CustomAppInput, DeployedApp, E> & {
  readonly onInstalled: (app: DeployedApp) => void | Promise<void>;
  /** This installation's MCP URL, included so an unconnected agent can connect first. */
  readonly endpoint?: string;
};

type Opened = "custom" | "mcp" | undefined;

/** Apps' Add app menu: create your own app first, or browse the app catalog. */
export function AddAppMenu<E>({
  catalog,
  ...dialogs
}: AddAppDialogProps<E> & {
  /** Wraps the catalog entry in the product's link to its catalog page. */
  readonly catalog: (content: ReactNode) => ReactElement;
}) {
  const [opened, setOpened] = useState<Opened>();
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button>
            Add app
            <HugeiconsIcon icon={ArrowDown01Icon} size={14} aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-76 p-1.5">
          <DropdownMenuLabel className="px-2.5 pt-1.5 pb-1 text-[12px] text-muted-foreground">
            Create your own
          </DropdownMenuLabel>
          <CreateChoices setOpened={setOpened} />
          <DropdownMenuSeparator className="-mx-1.5 my-1.5" />
          <CatalogChoice catalog={catalog} />
        </DropdownMenuContent>
      </DropdownMenu>
      <AddAppDialogs opened={opened} setOpened={setOpened} {...dialogs} />
    </>
  );
}

/** The catalog page's header button and way out when nothing fits: Add app's create choices. */
export function MakeYourOwn<E>({
  appearance = "link",
  ...dialogs
}: AddAppDialogProps<E> & { readonly appearance?: "link" | "button" | undefined }) {
  const [opened, setOpened] = useState<Opened>();
  return (
    <>
      <DropdownMenu>
        {appearance === "button" ? (
          <DropdownMenuTrigger asChild>
            <Button>
              Make your own
              <HugeiconsIcon icon={ArrowDown01Icon} size={14} aria-hidden />
            </Button>
          </DropdownMenuTrigger>
        ) : (
          <DropdownMenuTrigger className="font-medium text-foreground underline underline-offset-4 outline-none hover:text-foreground/80 focus-visible:ring-[3px] focus-visible:ring-ring/50 rounded-sm">
            Make your own
          </DropdownMenuTrigger>
        )}
        <DropdownMenuContent
          align={appearance === "button" ? "end" : "center"}
          className="w-76 p-1.5"
        >
          <CreateChoices setOpened={setOpened} />
        </DropdownMenuContent>
      </DropdownMenu>
      <AddAppDialogs opened={opened} setOpened={setOpened} {...dialogs} />
    </>
  );
}

function CreateChoices({ setOpened }: { readonly setOpened: (opened: Opened) => void }) {
  return (
    <>
      <DropdownMenuItem
        className="items-start gap-3 p-2.5"
        data-product-area="apps"
        data-product-action="add_custom_app"
        onSelect={() => setOpened("custom")}
      >
        <Choice
          icon={AiMagicIcon}
          title="From scratch"
          description="Describe it and your agent builds it"
        />
      </DropdownMenuItem>
      <DropdownMenuItem
        className="items-start gap-3 p-2.5"
        data-product-area="apps"
        data-product-action="add_mcp_server"
        onSelect={() => setOpened("mcp")}
      >
        <Choice
          icon={McpServerIcon}
          title="From an MCP server"
          description="Turn a remote MCP server into an app"
        />
      </DropdownMenuItem>
    </>
  );
}

function CatalogChoice({ catalog }: { readonly catalog: (content: ReactNode) => ReactElement }) {
  return (
    <DropdownMenuItem
      asChild
      className="items-start gap-3 p-2.5"
      data-product-area="apps"
      data-product-action="browse_catalog"
    >
      {catalog(
        <Choice
          icon={Store01Icon}
          title="Browse app catalog"
          description="Gmail, Notion, Linear and more, ready to add"
        />,
      )}
    </DropdownMenuItem>
  );
}

function Choice({
  icon,
  title,
  description,
}: {
  readonly icon: IconSvgElement;
  readonly title: string;
  readonly description: string;
}) {
  return (
    <>
      <HugeiconsIcon
        icon={icon}
        size={18}
        aria-hidden
        className="mt-0.5 shrink-0 text-muted-foreground"
      />
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-[13px] font-medium">{title}</span>
        <span className="text-[12px] leading-4 text-muted-foreground">{description}</span>
      </span>
    </>
  );
}

function AddAppDialogs<E>({
  opened,
  setOpened,
  endpoint,
  ...form
}: AddAppDialogProps<E> & {
  readonly opened: Opened;
  readonly setOpened: (opened: Opened) => void;
}) {
  const close = (open: boolean) => {
    if (!open) setOpened(undefined);
  };
  return (
    <>
      <Dialog open={opened === "custom"} onOpenChange={close}>
        <DialogContent className="max-h-[85dvh] gap-5 overflow-y-auto sm:max-w-[560px]">
          <CustomAppDialog endpoint={endpoint} />
        </DialogContent>
      </Dialog>
      <Dialog open={opened === "mcp"} onOpenChange={close}>
        <DialogContent className="max-h-[85dvh] gap-5 overflow-y-auto sm:max-w-[560px]">
          <DialogHeader>
            <DialogTitle>Create from an MCP server</DialogTitle>
            <DialogDescription>Turn a remote MCP server into an app by its URL.</DialogDescription>
          </DialogHeader>
          <CustomAppForm {...form} />
          <p className="text-[13px] text-muted-foreground">
            OpenAPI spec, API key or another service?{" "}
            <button
              type="button"
              onClick={() => setOpened("custom")}
              className="text-foreground underline underline-offset-4"
            >
              Start from scratch
            </button>
          </p>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** A custom app starts as a description that the user's agent turns into code. */
function CustomAppDialog({ endpoint }: { readonly endpoint: string | undefined }) {
  const [description, setDescription] = useState("");
  return (
    <>
      <DialogHeader>
        <DialogTitle>Create from scratch</DialogTitle>
        <DialogDescription>
          Describe what it should do, or paste an OpenAPI spec’s URL. Your agent writes the app,
          deploys it here and helps you connect the accounts it needs.
        </DialogDescription>
      </DialogHeader>
      <label className="flex flex-col gap-2.25 text-[13px] font-medium">
        What should it do?
        <Textarea
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder="Every Monday, summarize my open Linear issues and post them to #eng in Slack."
          rows={3}
        />
      </label>
      <AgentSetupPrompt
        title="Send this to your agent"
        description="Paste it into Claude Code, Codex, Cursor or any agent connected to Executor."
        prompt={newAppPrompt(description, endpoint)}
      />
    </>
  );
}
