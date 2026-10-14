import { useState, type ComponentType, type ReactNode, type SVGProps } from "react";
import { ArrowUpRight01Icon, McpServerIcon, ZoomInAreaIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { AssistantId } from "../../contracts/dashboard.ts";
import { publicDocsBaseUrl } from "../../contracts/documentation.ts";
import { Code, CopyButton } from "./code.tsx";
import { Button } from "../components/button.tsx";
import { Dialog, DialogContent, DialogTitle } from "../components/dialog.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/tabs.tsx";
import {
  ChatGptLogo,
  ClaudeLogo,
  CodexLogo,
  CursorLogo,
  DevinLogo,
  GrokLogo,
  MuseLogo,
} from "./assistant-logos.tsx";

import claudeScreenshot from "./assistant-screenshots/claude.webp";
import chatgptScreenshot from "./assistant-screenshots/chatgpt.webp";
import devinScreenshot from "./assistant-screenshots/devin.webp";
import grokScreenshot from "./assistant-screenshots/grok.webp";
import museScreenshot from "./assistant-screenshots/muse.webp";
import cursorScreenshot from "./assistant-screenshots/cursor.webp";

/** The agent installs Executor itself; the prompt carries everything it needs to start. */
export const mcpSetupPrompt = (endpoint: string, docs: string, next: string) =>
  `Help me connect to Executor over MCP at ${endpoint}.\n\nRead the docs to understand the product at ${docs}, then ${next}.`;

const shellQuote = (value: string): string => `'${value.replace(/'/g, `'"'"'`)}'`;

const tabClass =
  "h-10! w-full justify-start gap-6 border-b p-0 [&_[data-slot='tabs-trigger']]:h-full [&_[data-slot='tabs-trigger']]:flex-none [&_[data-slot='tabs-trigger']]:rounded-none [&_[data-slot='tabs-trigger']]:px-0 [&_[data-slot='tabs-trigger']]:text-[13px] [&_[data-slot='tabs-trigger']]:after:bottom-0";

const OtherLogo = ({ className }: SVGProps<SVGSVGElement>) => (
  <HugeiconsIcon icon={McpServerIcon} strokeWidth={1.75} className={className} aria-hidden />
);

/** The published plugin serves Cursor and Grok Bot alike. */
const executorPlugin = "https://cursor.com/marketplace/usefulsoftwareco";

interface AssistantGuide {
  readonly name: string;
  readonly logo: ComponentType<SVGProps<SVGSVGElement>>;
  /** How Executor gets into this assistant, shown under its name. */
  readonly method: string;
  readonly link?: { readonly href: string; readonly label: string };
  readonly steps: readonly ReactNode[];
  readonly screenshot?: {
    readonly src: string;
    readonly alt: string;
    readonly caption: string;
    /** The capture's pixel size, so its space is reserved before it loads. */
    readonly width: number;
    readonly height: number;
    /** A short, wide capture sits under the steps instead of beside them. */
    readonly wide?: boolean;
  };
  readonly note?: ReactNode;
}

/** A label the user will see in the assistant's own interface. */
const Ui = ({ children }: { readonly children: ReactNode }) => (
  <span className="font-medium text-foreground">{children}</span>
);

const Path = ({ items }: { readonly items: readonly string[] }) => (
  <span className="font-medium text-foreground">
    {items.map((item, index) => (
      <span key={item}>
        {index > 0 && <span className="px-1 text-muted-foreground/70">›</span>}
        {item}
      </span>
    ))}
  </span>
);

const Command = ({ children }: { readonly children: string }) => (
  <code className="rounded border bg-muted px-1.5 py-0.5 font-mono text-[12px] text-foreground">
    {children}
  </code>
);

/** The exact MCP URL, copyable where a step asks for it. */
function EndpointField({ endpoint }: { readonly endpoint: string }) {
  return (
    <div className="mt-2 flex min-w-0 items-center gap-2 rounded-lg border bg-background py-1 pr-1 pl-3">
      <code className="min-w-0 flex-1 font-mono text-[12px] break-all text-foreground">
        {endpoint}
      </code>
      <CopyButton code={endpoint} label="Copy MCP URL" text="Copy" size="sm" inline />
    </div>
  );
}

function CommandBlock({
  code,
  path,
  label,
}: {
  readonly code: string;
  readonly path: string;
  readonly label: string;
}) {
  return (
    <div className="mcp-install-code relative mt-2 min-w-0 overflow-hidden rounded-lg border [&_pre]:py-3! [&_pre]:pr-11! [&_pre]:pl-3.5! [&_pre]:leading-6!">
      <CopyButton code={code} label={label} text="" />
      <Code code={code} path={path} />
    </div>
  );
}

/** A chat message for assistants that add MCP servers on request. */
function MessageBlock({ message }: { readonly message: string }) {
  return (
    <div className="mt-2 overflow-hidden rounded-lg border bg-background">
      <p className="px-3.5 pt-3 pb-2 text-[13px] leading-5 break-words text-foreground select-text">
        {message}
      </p>
      <div className="flex justify-end border-t px-1.5 py-1">
        <CopyButton code={message} label="Copy assistant setup" text="Copy message" inline />
      </div>
    </div>
  );
}

const signIn = (assistant: string) => (
  <>
    Sign in to Executor, choose your team and approve access. Then ask {assistant} to list
    Executor&rsquo;s tools.
  </>
);

const pluginGuide = (name: string, endpoint: string): AssistantGuide => ({
  name,
  logo: name === "Cursor" ? CursorLogo : GrokLogo,
  method: "Executor plugin",
  link: { href: executorPlugin, label: `Install Executor for ${name}` },
  steps: [
    name === "Cursor" ? (
      <>
        Click <Ui>Add to Cursor</Ui> on the plugin page, or type{" "}
        <Command>/add-plugin executor</Command> in Cursor.
      </>
    ) : (
      <>
        Type <Command>/add-plugin executor</Command> in Grok Bot. It installs the same Executor
        plugin.
      </>
    ),
    <>
      Choose <Ui>Connect</Ui> on the plugin&rsquo;s <Ui>executor</Ui> MCP server, then sign in and
      approve access.
    </>,
    <>
      Run <Command>/executor-setup</Command> to check the connection.
    </>,
  ],
  screenshot: {
    src: cursorScreenshot,
    width: 780,
    height: 668,
    alt: "Executor plugin listing with Add to Cursor and /add-plugin executor",
    caption: "The Executor plugin in the marketplace",
  },
  note: (
    <>
      Using a scoped connection or your own server? Set the plugin&rsquo;s executor MCP server URL
      to:
      <EndpointField endpoint={endpoint} />
    </>
  ),
});

const assistantGuides = (endpoint: string): Record<AssistantId, AssistantGuide> => ({
  claude: {
    name: "Claude",
    logo: ClaudeLogo,
    method: "Custom connector",
    link: { href: "https://claude.ai/customize/connectors", label: "Open Claude connectors" },
    steps: [
      <>
        Open <Path items={["Customize", "Connectors"]} />, then{" "}
        <Path items={["Add connector", "Add custom connector"]} />.
      </>,
      <>
        Name it <Ui>Executor</Ui>, paste your MCP URL and click <Ui>Continue</Ui>.
        <EndpointField endpoint={endpoint} />
      </>,
      <>
        Keep <Ui>Sign in now</Ui> and <Ui>Register automatically</Ui> selected, then click{" "}
        <Ui>Add</Ui>.
      </>,
      signIn("Claude"),
    ],
    screenshot: {
      src: claudeScreenshot,
      width: 538,
      height: 451,
      alt: "Claude's Add custom connector dialog with Executor entered",
      caption: "Claude’s Add custom connector dialog",
    },
    note: (
      <>
        On Team or Enterprise, an Owner first adds Executor under{" "}
        <Path items={["Organization settings", "Connectors"]} /> (Add › Custom › Web). Members then
        click <Ui>Connect</Ui> next to Executor.
      </>
    ),
  },
  chatgpt: {
    name: "ChatGPT",
    logo: ChatGptLogo,
    method: "Custom MCP plugin",
    link: { href: "https://chatgpt.com/plugins", label: "Open ChatGPT plugins" },
    steps: [
      <>
        Open <Ui>Plugins</Ui>, click <Ui>Add</Ui>, then <Ui>Add custom MCP server</Ui>.
      </>,
      <>
        Name it <Ui>Executor</Ui>, paste your MCP URL and choose <Ui>OAuth</Ui>.
        <EndpointField endpoint={endpoint} />
      </>,
      <>
        Review the warning, click <Ui>Create as a plugin</Ui>, then <Ui>Connect</Ui>.
      </>,
      signIn("ChatGPT"),
    ],
    screenshot: {
      src: chatgptScreenshot,
      width: 600,
      height: 760,
      alt: "ChatGPT's Add custom MCP server dialog with Executor, the MCP URL and OAuth",
      caption: "ChatGPT’s Add custom MCP server dialog",
    },
    note: (
      <>
        Your ChatGPT dot uses the plugins you add here, so connect Executor once in ChatGPT. In a
        work workspace, an admin may need to allow custom MCP servers.
      </>
    ),
  },
  cursor: pluginGuide("Cursor", endpoint),
  "claude-code": {
    name: "Claude Code",
    logo: ClaudeLogo,
    method: "Terminal",
    steps: [
      <>
        Add Executor from your terminal.
        <CommandBlock
          code={`claude mcp add --transport http executor ${shellQuote(endpoint)}`}
          path="install.sh"
          label="Copy assistant setup"
        />
      </>,
      <>
        In Claude Code, run <Command>/mcp</Command>, choose <Ui>executor</Ui> and select{" "}
        <Ui>Authenticate</Ui>.
      </>,
      signIn("Claude Code"),
    ],
  },
  codex: {
    name: "Codex",
    logo: CodexLogo,
    method: "Terminal",
    steps: [
      <>
        Add Executor from your terminal.
        <CommandBlock
          code={`codex mcp add executor --url ${shellQuote(endpoint)}`}
          path="install.sh"
          label="Copy assistant setup"
        />
      </>,
      <>
        Open the sign-in page.
        <CommandBlock
          code="codex mcp login executor"
          path="install.sh"
          label="Copy sign-in command"
        />
      </>,
      signIn("Codex"),
    ],
  },
  devin: {
    name: "Devin",
    logo: DevinLogo,
    method: "Custom MCP",
    link: { href: "https://app.devin.ai/customize?tab=mcps", label: "Open Devin MCPs" },
    steps: [
      <>
        Open <Path items={["Customize", "MCPs"]} />, select <Ui>Personal</Ui>, then{" "}
        <Path items={["Add MCP", "New MCP"]} />.
      </>,
      <>
        Name it <Ui>Executor</Ui>. Set Transport type to <Ui>HTTP</Ui> and Authentication to{" "}
        <Ui>OAuth</Ui>.
      </>,
      <>
        Paste your MCP URL into <Ui>Server URL</Ui> and click <Ui>Add</Ui>.
        <EndpointField endpoint={endpoint} />
      </>,
      <>
        Click <Ui>Connect</Ui> next to Executor. {signIn("Devin")}
      </>,
    ],
    screenshot: {
      src: devinScreenshot,
      width: 799,
      height: 810,
      alt: "Devin's New MCP form with Executor, HTTP transport and OAuth authentication",
      caption: "Devin’s New MCP form",
    },
    note: "In an organization, Personal access lets each member sign in with their own account.",
  },
  "grok-bot": pluginGuide("Grok Bot", endpoint),
  grok: {
    name: "Grok",
    logo: GrokLogo,
    method: "Custom connector",
    link: { href: "https://grok.com/", label: "Open Grok" },
    steps: [
      <>
        Open <Path items={["Plugins", "Connectors"]} />, click <Ui>New Connector</Ui> and choose{" "}
        <Ui>Custom</Ui>.
      </>,
      <>
        Name it <Ui>Executor</Ui>, paste your MCP URL into <Ui>Server URL</Ui> and click{" "}
        <Ui>Add Connector</Ui>.
        <EndpointField endpoint={endpoint} />
      </>,
      <>Follow the connector&rsquo;s sign-in link. {signIn("Grok")}</>,
    ],
    screenshot: {
      src: grokScreenshot,
      width: 520,
      height: 304,
      alt: "Grok's Custom Connector form with Executor and the MCP URL",
      caption: "Grok’s Custom Connector form",
    },
  },
  muse: {
    name: "Muse",
    logo: MuseLogo,
    method: "Chat message",
    link: { href: "https://muse.ai/", label: "Open Muse" },
    steps: [
      <>
        Send Muse this message.
        <MessageBlock
          message={`Add Executor as a remote MCP server named executor at ${endpoint} (Streamable HTTP, OAuth). Start sign-in and show me the approval link. If you cannot add it, tell me where to add a custom MCP server in your settings. After I approve, list Executor's tools to confirm the connection.`}
        />
      </>,
      <>
        Open the sign-in link or button Muse shows. Sign in to Executor, choose your team and
        approve access.
      </>,
    ],
    screenshot: {
      src: museScreenshot,
      width: 780,
      height: 90,
      alt: "A setup message typed into Muse's chat box",
      caption: "Where the message goes in Muse",
      wide: true,
    },
  },
  other: {
    name: "Other",
    logo: OtherLogo,
    method: "Any remote MCP client",
    steps: [
      <>
        In your assistant&rsquo;s settings, add a custom connector or remote MCP server named{" "}
        <Ui>Executor</Ui>.
      </>,
      <>
        Choose <Ui>Streamable HTTP</Ui> with <Ui>OAuth</Ui> and paste your MCP URL.
        <EndpointField endpoint={endpoint} />
      </>,
      <>Start its Connect or sign-in action. {signIn("your assistant")}</>,
    ],
    note: "Your assistant needs to support remote MCP servers with OAuth sign-in.",
  },
});

/** The name an assistant goes by in its guide and the setup around it. */
export const assistantName = (assistant: AssistantId): string =>
  assistantGuides("")[assistant].name;

/** Assistant logos as a grid of choices; `selected` marks the current one when the choice persists. */
export function AssistantChoices({
  selected,
  onSelect,
}: {
  readonly selected?: AssistantId;
  readonly onSelect: (assistant: AssistantId) => void;
}) {
  const guides = assistantGuides("");
  return (
    <div
      className="flex flex-wrap gap-1.5 @md:grid @md:grid-cols-5"
      role="group"
      aria-label="Choose your assistant"
    >
      {AssistantId.literals.map((id) => {
        const item = guides[id];
        const ItemLogo = item.logo;
        return (
          <button
            key={id}
            type="button"
            aria-pressed={selected === undefined ? undefined : selected === id}
            onClick={() => onSelect(id)}
            className="flex min-w-0 items-center gap-2 rounded-lg border py-1 pr-3 pl-1 text-[13px] leading-4 @md:flex-col @md:gap-1.5 @md:not-aria-pressed:border-transparent @md:px-1 @md:pt-2.5 @md:pb-2 @md:text-[12px] text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-pressed:border-foreground/20 aria-pressed:bg-muted aria-pressed:text-foreground max-[740px]:min-h-11"
          >
            <span className="flex size-7 shrink-0 items-center justify-center rounded-md border bg-background shadow-xs @md:size-8">
              <ItemLogo className="size-4 @md:size-4.5" />
            </span>
            <span className="truncate @md:w-full @md:text-center">{item.name}</span>
          </button>
        );
      })}
    </div>
  );
}

/** One assistant's setup steps, with the product's exact MCP URL in every copyable example. */
export function AssistantSetupGuide({
  endpoint,
  assistant,
}: {
  readonly endpoint: string;
  readonly assistant: AssistantId;
}) {
  const guide = assistantGuides(endpoint)[assistant];
  const Logo = guide.logo;
  return (
    <article
      aria-label={`${guide.name} setup`}
      className="@container overflow-hidden rounded-xl border bg-card"
    >
      <header className="flex flex-wrap items-center gap-3 border-b px-4 py-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-background">
          <Logo className="size-5" />
        </span>
        <div className="min-w-0 flex-1 basis-40">
          <h3 className="text-sm font-medium">Add Executor to {guide.name}</h3>
          <p className="text-xs text-muted-foreground">{guide.method}</p>
        </div>
        {guide.link && (
          <Button asChild variant="outline" size="sm" className="w-full @md:w-auto">
            <a href={guide.link.href} target="_blank" rel="noreferrer">
              {guide.link.label}
              <HugeiconsIcon icon={ArrowUpRight01Icon} strokeWidth={2} aria-hidden />
            </a>
          </Button>
        )}
      </header>
      <div
        className={
          guide.screenshot && !guide.screenshot.wide
            ? "grid gap-4 p-4 @2xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] @2xl:gap-6"
            : "p-4"
        }
      >
        <ol className="min-w-0 space-y-3.5 text-[13px] leading-5 text-muted-foreground">
          {guide.steps.map((step, index) => (
            <li key={index} className="flex gap-3">
              <span
                aria-hidden
                className="mt-px flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-medium text-foreground tabular-nums"
              >
                {index + 1}
              </span>
              <div className="min-w-0 flex-1">{step}</div>
            </li>
          ))}
        </ol>
        {guide.screenshot && (
          <div className={guide.screenshot.wide ? "mt-4" : undefined}>
            <SetupScreenshot {...guide.screenshot} />
          </div>
        )}
      </div>
      {guide.note && (
        <footer className="border-t bg-muted/40 px-4 py-3 text-xs leading-5 text-muted-foreground">
          {guide.note}
        </footer>
      )}
    </article>
  );
}

/** The assistant choices above the chosen assistant's guide, for pages that keep both in view. */
export function AssistantInstallInstructions({ endpoint }: { readonly endpoint: string }) {
  const [selected, setSelected] = useState<AssistantId>("claude");
  return (
    <section aria-labelledby="assistant-setup-title" className="@container min-w-0">
      <h2 id="assistant-setup-title" className="text-sm font-medium">
        Connect an assistant
      </h2>
      <div className="mt-3">
        <AssistantChoices selected={selected} onSelect={setSelected} />
      </div>
      <div className="mt-4">
        <AssistantSetupGuide endpoint={endpoint} assistant={selected} />
      </div>
    </section>
  );
}

/** A real capture of the assistant's form, opened full size on demand. */
function SetupScreenshot({
  src,
  alt,
  caption,
  width,
  height,
}: {
  readonly src: string;
  readonly alt: string;
  readonly caption: string;
  readonly width: number;
  readonly height: number;
}) {
  // Fit the capture inside the available width and `--shot-height` without enlarging it. The
  // width is known before the image loads, and the aspect ratio gives its height.
  const size = {
    width: `min(100%, ${width}px, calc(var(--shot-height) * ${width} / ${height}))`,
    aspectRatio: `${width} / ${height}`,
  };
  const [open, setOpen] = useState(false);
  return (
    <figure className="min-w-0">
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`Enlarge screenshot: ${caption}`}
        className="group relative block w-full cursor-zoom-in overflow-hidden rounded-lg border bg-[#141414] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        <img
          src={src}
          alt={alt}
          width={width}
          height={height}
          loading="lazy"
          style={size}
          className="mx-auto h-auto [--shot-height:14rem] @2xl:[--shot-height:18rem]"
        />
        <span className="absolute top-2 left-2 flex items-center gap-1 rounded-md bg-black/70 px-1.5 py-1 text-[11px] text-white opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
          <HugeiconsIcon icon={ZoomInAreaIcon} strokeWidth={2} size={12} aria-hidden />
          Enlarge
        </span>
      </button>
      <figcaption className="mt-1.5 text-xs leading-5 text-muted-foreground">{caption}</figcaption>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="w-auto max-w-[calc(100%-1rem)] gap-3 p-3 sm:max-w-3xl">
          <DialogTitle className="pt-2 pr-10 pl-1 text-sm leading-5 font-medium">
            {caption}
          </DialogTitle>
          <img
            src={src}
            alt={alt}
            width={width}
            height={height}
            style={size}
            className="h-auto rounded-md [--shot-height:80dvh]"
          />
        </DialogContent>
      </Dialog>
    </figure>
  );
}

/** Setup as a prompt for the agent, the raw MCP URL, or a one-line installer command. */
export function McpInstallInstructions({
  endpoint,
  docs = publicDocsBaseUrl,
  next = "help me get my first app set up",
  token,
  children,
}: {
  readonly endpoint: string;
  readonly docs?: string;
  /** What the agent should do once connected. */
  readonly next?: string;
  /** Bearer-token setup for scripts and headless agents, where the product offers tokens. */
  readonly token?: ReactNode;
  readonly children?: ReactNode;
}) {
  const prompt = mcpSetupPrompt(endpoint, docs, next);
  const command = `npx add-mcp ${shellQuote(endpoint)} --name executor -g`;
  return (
    <div className="mcp-install-content min-w-0">
      <Tabs defaultValue="assistant">
        <TabsList aria-label="Setup method" variant="line" className={tabClass}>
          <TabsTrigger value="assistant">Assistant</TabsTrigger>
          <TabsTrigger
            data-product-area="connect"
            data-product-action="select_prompt"
            value="prompt"
          >
            Prompt
          </TabsTrigger>
          <TabsTrigger data-product-area="connect" data-product-action="select_url" value="url">
            MCP URL
          </TabsTrigger>
          <TabsTrigger
            data-product-area="connect"
            data-product-action="select_command"
            value="command"
          >
            Command
          </TabsTrigger>
          {token && (
            <TabsTrigger
              data-product-area="connect"
              data-product-action="select_token"
              value="token"
            >
              Personal access token
            </TabsTrigger>
          )}
        </TabsList>
        <TabsContent value="assistant" className="mt-4">
          <AssistantInstallInstructions endpoint={endpoint} />
        </TabsContent>
        <TabsContent value="prompt" className="mt-4">
          <p className="text-[13px] leading-5 text-muted-foreground">
            Send this to your agent. It adds the Executor MCP server, then asks you to sign in.
          </p>
          <p className="mt-3 rounded-lg border border-foreground/15 bg-foreground/[0.06] p-4 text-sm leading-6 break-words whitespace-pre-line select-text">
            {prompt}
          </p>
          <div className="mt-3">
            <CopyButton
              code={prompt}
              label="Copy setup prompt"
              text="Copy prompt"
              variant="default"
              size="default"
              inline
            />
          </div>
        </TabsContent>
        <TabsContent value="url" className="mt-4">
          <p className="text-[13px] leading-5 text-muted-foreground">
            Add a Streamable HTTP MCP server with this URL. Your client signs in with OAuth.
          </p>
          <div className="mt-3 flex min-w-0 items-center gap-2 rounded-lg border bg-background py-1.5 pr-1.5 pl-4">
            <code className="min-w-0 flex-1 truncate font-mono text-[13px]" title={endpoint}>
              {endpoint}
            </code>
            <CopyButton code={endpoint} label="Copy MCP URL" text="Copy" size="sm" inline />
          </div>
        </TabsContent>
        <TabsContent value="command" className="mt-4">
          <p className="text-[13px] leading-5 text-muted-foreground">
            Run in your terminal, then choose the agents to add Executor to.
          </p>
          <div className="mcp-install-code relative mt-3 min-w-0 overflow-hidden rounded-lg border [&_pre]:py-4! [&_pre]:pr-14! [&_pre]:pl-4! [&_pre]:leading-6!">
            <CopyButton code={command} label="Copy command" />
            <Code code={command} path="install.sh" />
          </div>
        </TabsContent>
        {token && (
          <TabsContent value="token" className="mt-4">
            {token}
          </TabsContent>
        )}
      </Tabs>
      {children && (
        <p className="field-hint mt-4 text-xs leading-5 text-muted-foreground">{children}</p>
      )}
    </div>
  );
}
