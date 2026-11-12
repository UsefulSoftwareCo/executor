import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components, ExtraProps } from "react-markdown";
import { fenceLanguage } from "../../contracts/code-language.ts";
import { Code } from "./code.tsx";

/** Highlight a Markdown code block with the shared code renderer. */
export function MarkdownCodeBlock({ node }: ExtraProps) {
  const code = node?.children.find((child) => child.type === "element" && child.tagName === "code");
  if (code?.type !== "element") return null;
  const info = code.properties.className;
  const language = Array.isArray(info)
    ? info.find((name) => typeof name === "string" && name.startsWith("language-"))
    : undefined;
  const text = code.children
    .map((child) => (child.type === "text" ? child.value : ""))
    .join("")
    .replace(/\n$/, "");
  return (
    <Code
      code={text}
      language={typeof language === "string" ? fenceLanguage(language.slice(9)) : "text"}
      lineNumbers={false}
    />
  );
}

const components: Components = {
  // Only https links open; any other address renders as its text.
  a: ({ href, children }) => {
    const safeHref = href !== undefined && /^https:\/\//i.test(href) ? href : undefined;
    return safeHref === undefined ? (
      <span>{children}</span>
    ) : (
      <a href={safeHref} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    );
  },
  // Authored text never loads images from other origins; the alt text stands in for each.
  img: ({ alt }) => <span>{alt}</span>,
  pre: (props) => (
    <div className="tool-markdown-code overflow-x-auto my-[8px] mx-0 [&_pre]:bg-muted [&_pre]:border [&_pre]:border-border [&_pre]:rounded-[6px] [&_pre]:py-[10px] [&_pre]:px-[12px] [&_pre]:text-[11px] [&_pre]:leading-[1.6]">
      <MarkdownCodeBlock node={props.node} />
    </div>
  ),
};

/** Render app-authored Markdown without raw HTML, images or links other than https. */
export function ToolMarkdown({ children }: { readonly children: string }) {
  return (
    <Markdown remarkPlugins={[remarkGfm]} skipHtml components={components}>
      {children}
    </Markdown>
  );
}

/**
 * Setup help in a connect form: an app's method guide, OAuth client guide or field description.
 * `label` names the region for assistive technology; `id` lets a control refer to it.
 */
export function SetupHelp({
  label,
  id,
  children,
}: {
  readonly label?: string;
  readonly id?: string;
  readonly children: string;
}) {
  return (
    <div
      {...(label === undefined ? {} : { role: "region", "aria-label": label })}
      {...(id === undefined ? {} : { id })}
      className="text-muted-foreground text-xs font-normal leading-relaxed wrap-anywhere [&_p]:[margin:0_0_6px] [&_p:last-child]:mb-0 [&_ul]:[margin:4px_0_6px_16px] [&_ul]:list-disc [&_ol]:[margin:4px_0_6px_16px] [&_ol]:list-decimal [&_li]:mb-0.5 [&_code]:font-mono [&_code]:text-[11px] [&_a]:text-foreground [&_a]:underline [&_a]:underline-offset-[2px] [&_strong]:text-foreground [&_strong]:font-medium [&_h1]:text-foreground [&_h1]:font-semibold [&_h1]:[margin:6px_0_4px] [&_h2]:text-foreground [&_h2]:font-semibold [&_h2]:[margin:6px_0_4px] [&_h3]:text-foreground [&_h3]:font-semibold [&_h3]:[margin:6px_0_4px]"
    >
      <ToolMarkdown>{children}</ToolMarkdown>
    </div>
  );
}
