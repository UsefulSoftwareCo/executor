import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";

const components: Components = {
  a: ({ href, children }) => {
    const safeHref = href !== undefined && /^(https?:)\/\//i.test(href) ? href : undefined;
    return safeHref === undefined ? (
      <span>{children}</span>
    ) : (
      <a href={safeHref} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    );
  },
  pre: ({ children }) => (
    <div className="tool-markdown-code overflow-x-auto my-[8px] mx-0 [&_pre]:bg-muted [&_pre]:border [&_pre]:border-border [&_pre]:rounded-[6px] [&_pre]:py-[10px] [&_pre]:px-[12px] [&_pre]:text-[11px] [&_pre]:leading-[1.6]">
      {children}
    </div>
  ),
};

/** Render tool-authored Markdown without enabling raw HTML or unsafe links. */
export function ToolMarkdown({ children }: { readonly children: string }) {
  return (
    <Markdown remarkPlugins={[remarkGfm]} skipHtml components={components}>
      {children}
    </Markdown>
  );
}
