import type { AppSkillDocument } from "@executor-js/sdk";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Code } from "./code.tsx";
import { markdownProse } from "./markdown-prose.ts";

/** Render a skill document and resolve links to its other files. */
export function SkillContent({
  document,
  onFile,
}: {
  readonly document: Pick<AppSkillDocument, "file" | "content" | "files">;
  readonly onFile: (file: string) => void;
}) {
  const markdown = /\.md$/i.test(document.file);
  const content =
    document.file === "SKILL.md"
      ? document.content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "")
      : document.content;
  return (
    <div>
      {!markdown ? (
        <Code code={document.content} path={document.file} />
      ) : (
        <div className={markdownProse}>
          <Markdown
            remarkPlugins={[remarkGfm]}
            skipHtml
            components={{
              img: ({ alt }) => <span>{alt}</span>,
              a: ({ href, children }) => {
                if (href !== undefined && /^https?:\/\//i.test(href))
                  return (
                    <a className="underline" href={href} target="_blank" rel="noopener noreferrer">
                      {children}
                    </a>
                  );
                if (href !== undefined && !/^(?:[a-z][a-z0-9+.-]*:|\/|#)/i.test(href)) {
                  const path = new URL(
                    href,
                    `https://skill.invalid/${document.file}`,
                  ).pathname.slice(1);
                  const resource = document.files.find(
                    (file) => new URL(file, "https://skill.invalid/").pathname.slice(1) === path,
                  );
                  if (resource !== undefined)
                    return (
                      <button
                        type="button"
                        className="text-left underline"
                        onClick={() => onFile(resource)}
                      >
                        {children}
                      </button>
                    );
                }
                return <span>{children}</span>;
              },
            }}
          >
            {content}
          </Markdown>
        </div>
      )}
    </div>
  );
}
