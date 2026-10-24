import { Fragment, useState, type ComponentType, type ReactNode, type SVGProps } from "react";
import { ArrowUpRight01Icon, McpServerIcon, ZoomInAreaIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { AssistantId } from "../../contracts/dashboard.ts";
import { publicDocsBaseUrl } from "../../contracts/documentation.ts";
import {
  defaultProductBrand,
  isDefaultProductBrand,
  productServerName,
  type ProductBrand,
} from "@executor-js/utils/product-brand";
import { useProductBrand } from "../hooks/product-brand.ts";
import { Code, CopyButton } from "./code.tsx";
import { Button } from "../components/button.tsx";
import { Dialog, DialogContent, DialogTitle } from "../components/dialog.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/tabs.tsx";
import { cn } from "../lib/utils.ts";
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

/** The agent installs the product itself; the prompt carries everything it needs to start. */
export const mcpSetupPrompt = (
  endpoint: string,
  docs: string | null,
  next: string,
  product: string,
) =>
  `Help me connect to ${product} over MCP at ${endpoint}.\n\n${docs === null ? `Then ${next}` : `Read the docs to understand the product at ${docs}, then ${next}`}.`;

const shellQuote = (value: string): string => `'${value.replace(/'/g, `'"'"'`)}'`;

const tabClass =
  "h-10! w-full justify-start gap-6 border-b p-0 [&_[data-slot='tabs-trigger']]:h-full [&_[data-slot='tabs-trigger']]:flex-none [&_[data-slot='tabs-trigger']]:rounded-none [&_[data-slot='tabs-trigger']]:px-0 [&_[data-slot='tabs-trigger']]:text-[13px] [&_[data-slot='tabs-trigger']]:after:bottom-0";

const OtherLogo = ({ className }: SVGProps<SVGSVGElement>) => (
  <HugeiconsIcon icon={McpServerIcon} strokeWidth={1.75} className={className} aria-hidden />
);

interface AssistantGuide {
  readonly name: string;
  readonly logo: ComponentType<SVGProps<SVGSVGElement>>;
  /** How the product gets into this assistant, shown under its name. */
  readonly method: string;
  readonly link?: { readonly href: string; readonly label: string };
  readonly steps: readonly ReactNode[];
  readonly screenshot?:
    | {
        readonly src: string;
        readonly alt: string;
        readonly caption: string;
        /** The capture's pixel size, so its space is reserved before it loads. */
        readonly width: number;
        readonly height: number;
        /** A short, wide capture sits under the steps instead of beside them. */
        readonly wide?: boolean;
      }
    | undefined;
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
export function EndpointField({
  endpoint,
  className,
}: {
  readonly endpoint: string;
  readonly className?: string;
}) {
  return (
    <div
      className={cn(
        "mt-2 flex min-w-0 items-center gap-2 rounded-lg border bg-background py-1 pr-1 pl-3",
        className,
      )}
    >
      {/* A URL too long for its line wraps only after a slash, never inside a host or port. */}
      <code className="min-w-0 flex-1 font-mono text-[12px] break-normal text-foreground">
        {endpoint.split(/(?<=\/)(?!\/)/u).map((part, index) => (
          <Fragment key={index}>
            {index > 0 && <wbr />}
            {part}
          </Fragment>
        ))}
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

const signIn = (assistant: string, product: string) => (
  <>
    Sign in to {product}, choose your team and approve access. Then ask {assistant} to list{" "}
    {product}&rsquo;s tools.
  </>
);

const cursorGuide = (endpoint: string): AssistantGuide => ({
  name: "Cursor",
  logo: CursorLogo,
  method: "Executor plugin",
  link: {
    href: "https://cursor.com/marketplace/usefulsoftwareco",
    label: "Install Executor for Cursor",
  },
  steps: [
    <>
      Click <Ui>Add to Cursor</Ui> on the plugin page, or type{" "}
      <Command>/add-plugin executor</Command> in Cursor.
    </>,
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

/** Executor's plugin is not this product's, so another brand adds the server in Cursor's settings. */
const cursorMcpGuide = (endpoint: string, product: string, server: string): AssistantGuide => ({
  name: "Cursor",
  logo: CursorLogo,
  method: "MCP settings",
  steps: [
    <>
      Open <Path items={["Cursor Settings", "Tools & MCP"]} /> and click <Ui>New MCP Server</Ui>.
    </>,
    <>
      Add this server to the <Command>mcp.json</Command> that opens, then save it.
      <CommandBlock
        code={JSON.stringify({ mcpServers: { [server]: { url: endpoint } } }, null, 2)}
        path="mcp.json"
        label="Copy MCP configuration"
      />
    </>,
    <>
      Click <Ui>Connect</Ui> next to <Ui>{server}</Ui>. {signIn("Cursor", product)}
    </>,
  ],
});

/** The public plugin connects to Executor Cloud; custom endpoints keep their own setup. */
const openAiPluginGuide = (name: "ChatGPT" | "Codex"): AssistantGuide => ({
  name,
  logo: name === "ChatGPT" ? ChatGptLogo : CodexLogo,
  method: "Executor plugin",
  link: {
    href: "https://chatgpt.com/plugins/plugin_asdk_app_6acd465c1d148191832781c3c8ab4d99",
    label: "Open Executor plugin",
  },
  steps: [
    <>
      Open the Executor plugin page{name === "Codex" && " in the ChatGPT desktop app"} and click{" "}
      <Ui>Install plugin</Ui>.
    </>,
    <>
      Connect the included <Ui>Executor</Ui> app when prompted. Sign in to Executor, choose your
      team and approve access. If you already installed the plugin, open it to connect your account.
    </>,
    <>
      Start a new {name === "Codex" ? "Codex session" : "chat"} and send:{" "}
      <Ui>Show me the apps and tools available in my Executor workspace.</Ui> If asked to connect,
      finish sign-in and try again.
    </>,
  ],
  note:
    name === "Codex" ? (
      <div className="space-y-3">
        <div>
          <p className="font-medium text-foreground">Using Codex CLI?</p>
          <p className="mt-1">
            Run <Command>/plugins</Command>, find Executor and install it. Start a new session, then
            connect your Executor account when prompted.
          </p>
        </div>
        <details className="group border-t pt-3">
          <summary className="cursor-pointer font-medium text-foreground">
            Using the IDE extension?
          </summary>
          <p className="mt-2">
            The IDE extension uses MCP directly. Run these commands in your terminal:
          </p>
          <CommandBlock
            code={
              "codex mcp add executor --url 'https://mcp.executor.sh/mcp'\ncodex mcp login executor"
            }
            path="install.sh"
            label="Copy IDE setup commands"
          />
          <p className="mt-2">
            Sign in, choose your team and approve access. Then start a new Codex session.
          </p>
        </details>
      </div>
    ) : (
      <>
        If installation is unavailable in your work workspace, ask your admin to allow Executor.
        Installing the plugin and approving access to your Executor team are separate steps.
      </>
    ),
});

/** The screenshots show Executor's name, so they apply only while the deployment presents it. */
const shot = (executor: boolean, screenshot: NonNullable<AssistantGuide["screenshot"]>) =>
  executor ? screenshot : undefined;

/** Executor's plugins and screenshots apply only while the deployment presents Executor. */
const assistantGuides = (endpoint: string, brand: ProductBrand) =>
  guides(endpoint, brand.name, productServerName(brand), isDefaultProductBrand(brand));

const guides = (
  endpoint: string,
  product: string,
  server: string,
  executor: boolean,
): Record<AssistantId, AssistantGuide> => ({
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
        Name it <Ui>{product}</Ui>, paste your MCP URL and click <Ui>Continue</Ui>.
        <EndpointField endpoint={endpoint} />
      </>,
      <>
        Keep <Ui>Sign in now</Ui> and <Ui>Register automatically</Ui> selected, then click{" "}
        <Ui>Add</Ui>.
      </>,
      signIn("Claude", product),
    ],
    screenshot: shot(executor, {
      src: claudeScreenshot,
      width: 538,
      height: 451,
      alt: "Claude's Add custom connector dialog with Executor entered",
      caption: "Claude’s Add custom connector dialog",
    }),
    note: (
      <>
        On Team or Enterprise, an Owner first adds {product} under{" "}
        <Path items={["Organization settings", "Connectors"]} /> (Add › Custom › Web). Members then
        click <Ui>Connect</Ui> next to {product}.
      </>
    ),
  },
  chatgpt:
    endpoint === "https://mcp.executor.sh/mcp"
      ? openAiPluginGuide("ChatGPT")
      : {
          name: "ChatGPT",
          logo: ChatGptLogo,
          method: "Custom MCP plugin",
          link: { href: "https://chatgpt.com/plugins", label: "Open ChatGPT plugins" },
          steps: [
            <>
              Open <Ui>Plugins</Ui>, click <Ui>Add</Ui>, then <Ui>Add custom MCP server</Ui>.
            </>,
            <>
              Name it <Ui>{product}</Ui>, paste your MCP URL and choose <Ui>OAuth</Ui>.
              <EndpointField endpoint={endpoint} />
            </>,
            <>
              Review the warning, click <Ui>Create as a plugin</Ui>, then <Ui>Connect</Ui>.
            </>,
            signIn("ChatGPT", product),
          ],
          screenshot: shot(executor, {
            src: chatgptScreenshot,
            width: 600,
            height: 760,
            alt: "ChatGPT's Add custom MCP server dialog with Executor, the MCP URL and OAuth",
            caption: "ChatGPT’s Add custom MCP server dialog",
          }),
          note: (
            <>
              Your ChatGPT dot uses the plugins you add here, so connect {product} once in ChatGPT.
              In a work workspace, an admin may need to allow custom MCP servers.
            </>
          ),
        },
  cursor: executor ? cursorGuide(endpoint) : cursorMcpGuide(endpoint, product, server),
  "claude-code": {
    name: "Claude Code",
    logo: ClaudeLogo,
    method: "Terminal",
    steps: [
      <>
        Add {product} from your terminal.
        <CommandBlock
          code={`claude mcp add --transport http ${server} ${shellQuote(endpoint)}`}
          path="install.sh"
          label="Copy assistant setup"
        />
      </>,
      <>
        In Claude Code, run <Command>/mcp</Command>, choose <Ui>{server}</Ui> and select{" "}
        <Ui>Authenticate</Ui>.
      </>,
      signIn("Claude Code", product),
    ],
  },
  codex:
    endpoint === "https://mcp.executor.sh/mcp"
      ? openAiPluginGuide("Codex")
      : {
          name: "Codex",
          logo: CodexLogo,
          method: "Terminal",
          steps: [
            <>
              Add {product} from your terminal.
              <CommandBlock
                code={`codex mcp add ${server} --url ${shellQuote(endpoint)}`}
                path="install.sh"
                label="Copy assistant setup"
              />
            </>,
            <>
              Open the sign-in page.
              <CommandBlock
                code={`codex mcp login ${server}`}
                path="install.sh"
                label="Copy sign-in command"
              />
            </>,
            signIn("Codex", product),
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
        Name it <Ui>{product}</Ui>. Set Transport type to <Ui>HTTP</Ui> and Authentication to{" "}
        <Ui>OAuth</Ui>.
      </>,
      <>
        Paste your MCP URL into <Ui>Server URL</Ui> and click <Ui>Add</Ui>.
        <EndpointField endpoint={endpoint} />
      </>,
      <>
        Click <Ui>Connect</Ui> next to {product}. {signIn("Devin", product)}
      </>,
    ],
    screenshot: shot(executor, {
      src: devinScreenshot,
      width: 799,
      height: 810,
      alt: "Devin's New MCP form with Executor, HTTP transport and OAuth authentication",
      caption: "Devin’s New MCP form",
    }),
    note: "In an organization, Personal access lets each member sign in with their own account.",
  },
  "grok-bot": {
    name: "Grok Bot",
    logo: GrokLogo,
    method: "Chat message",
    steps: [
      <>
        Send Grok Bot this message.
        <MessageBlock
          message={`Add ${product} as a remote MCP server named ${server} at ${endpoint} (Streamable HTTP, OAuth). Start sign-in and show me the approval link. After I approve, list ${product}'s tools to confirm the connection.`}
        />
      </>,
      <>
        Open the sign-in link Grok Bot shows. Sign in to {product}, choose your team and approve
        access.
      </>,
    ],
  },
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
        Name it <Ui>{product}</Ui>, paste your MCP URL into <Ui>Server URL</Ui> and click{" "}
        <Ui>Add Connector</Ui>.
        <EndpointField endpoint={endpoint} />
      </>,
      <>Follow the connector&rsquo;s sign-in link. {signIn("Grok", product)}</>,
    ],
    screenshot: shot(executor, {
      src: grokScreenshot,
      width: 520,
      height: 304,
      alt: "Grok's Custom Connector form with Executor and the MCP URL",
      caption: "Grok’s Custom Connector form",
    }),
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
          message={`Add ${product} as a remote MCP server named ${server} at ${endpoint} (Streamable HTTP, OAuth). Start sign-in and show me the approval link. If you cannot add it, tell me where to add a custom MCP server in your settings. After I approve, list ${product}'s tools to confirm the connection.`}
        />
      </>,
      <>
        Open the sign-in link or button Muse shows. Sign in to {product}, choose your team and
        approve access.
      </>,
    ],
    screenshot: shot(executor, {
      src: museScreenshot,
      width: 780,
      height: 90,
      alt: "A setup message typed into Muse's chat box",
      caption: "Where the message goes in Muse",
      wide: true,
    }),
  },
  other: {
    name: "Other",
    logo: OtherLogo,
    method: "Any remote MCP client",
    steps: [
      <>
        In your assistant&rsquo;s settings, add a custom connector or remote MCP server named{" "}
        <Ui>{product}</Ui>.
      </>,
      <>
        Choose <Ui>Streamable HTTP</Ui> with <Ui>OAuth</Ui> and paste your MCP URL.
        <EndpointField endpoint={endpoint} />
      </>,
      <>Start its Connect or sign-in action. {signIn("your assistant", product)}</>,
    ],
    note: "Your assistant needs to support remote MCP servers with OAuth sign-in.",
  },
});

/** The name an assistant goes by in its guide and the setup around it. */
export const assistantName = (assistant: AssistantId): string =>
  assistantGuides("", defaultProductBrand)[assistant].name;

/** Assistant logos as a grid of choices; `selected` marks the current one when the choice persists. */
export function AssistantChoices({
  selected,
  onSelect,
}: {
  readonly selected?: AssistantId;
  readonly onSelect: (assistant: AssistantId) => void;
}) {
  const guides = assistantGuides("", useProductBrand());
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

/** One assistant's guide, with the product's exact MCP URL in every copyable example. */
export const useAssistantGuide = (endpoint: string, assistant: AssistantId): AssistantGuide =>
  assistantGuides(endpoint, useProductBrand())[assistant];

export type { AssistantGuide };

/** The guide's numbered steps. */
export function AssistantGuideSteps({
  guide,
  className,
}: {
  readonly guide: AssistantGuide;
  readonly className?: string;
}) {
  return (
    <ol
      className={cn("min-w-0 space-y-3.5 text-[13px] leading-5 text-muted-foreground", className)}
    >
      {guide.steps.map((step, index) => (
        <li key={index} className="flex gap-3">
          <span
            aria-hidden
            className="flex size-6 shrink-0 items-center justify-center rounded-full border text-[12px] text-foreground/80 tabular-nums"
          >
            {index + 1}
          </span>
          <div className="min-w-0 flex-1 pt-0.5">{step}</div>
        </li>
      ))}
    </ol>
  );
}

/** The assistant's logo, sized by the caller. */
export function AssistantGuideLogo({
  guide,
  className,
}: {
  readonly guide: AssistantGuide;
  readonly className?: string;
}) {
  const Logo = guide.logo;
  return <Logo className={className} aria-hidden />;
}

/** The guide's link into the assistant's own settings, when it has one; `children` lead its label. */
export function AssistantGuideLink({
  guide,
  className,
  children,
}: {
  readonly guide: AssistantGuide;
  readonly className?: string;
  readonly children?: ReactNode;
}) {
  if (!guide.link) return null;
  return (
    <Button asChild variant="outline" size="sm" className={className}>
      <a href={guide.link.href} target="_blank" rel="noreferrer">
        {children}
        {guide.link.label}
        <HugeiconsIcon icon={ArrowUpRight01Icon} strokeWidth={2} aria-hidden />
      </a>
    </Button>
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
  const guide = useAssistantGuide(endpoint, assistant);
  const brand = useProductBrand();
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
          <h3 className="text-sm font-medium">
            Add {brand.name} to {guide.name}
          </h3>
          <p className="text-xs text-muted-foreground">{guide.method}</p>
        </div>
        <AssistantGuideLink guide={guide} className="w-full @md:w-auto" />
      </header>
      <div
        className={
          guide.screenshot && !guide.screenshot.wide
            ? "grid gap-4 p-4 @2xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] @2xl:gap-6"
            : "p-4"
        }
      >
        <AssistantGuideSteps guide={guide} />
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
  /** `null` when the product has no docs to point the agent at. */
  readonly docs?: string | null;
  /** What the agent should do once connected. */
  readonly next?: string;
  /** Bearer-token setup for scripts and headless agents, where the product offers tokens. */
  readonly token?: ReactNode;
  readonly children?: ReactNode;
}) {
  const brand = useProductBrand();
  const prompt = mcpSetupPrompt(endpoint, docs, next, brand.name);
  const command = `npx add-mcp ${shellQuote(endpoint)} --name ${productServerName(brand)} -g`;
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
            Send this to your agent. It adds the {brand.name} MCP server, then asks you to sign in.
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
            Run in your terminal, then choose the agents to add {brand.name} to.
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
