import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "../components/dropdown-menu.tsx";
import { useState, type ComponentType } from "react";
import type { App, AppSkillBundle, AppSkillDocument } from "@executor-js/sdk";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { SkillBindings } from "../../contracts/app-browser.ts";
import type { FailureProps } from "../../contracts/dashboard.ts";
import { QueryView } from "./context.tsx";
import { SkillBrowserLoading } from "./app-browser-loading.tsx";
import { Code } from "./code.tsx";
import { Button } from "../components/button.tsx";

type Skill = AppSkillBundle["skills"][number];

/** All skill documents and references load together; selection never starts another request. */
export function AppSkills<E>({
  app,
  bindings,
  Failure,
}: {
  readonly app: App;
  readonly bindings: SkillBindings<E>;
  readonly Failure: ComponentType<FailureProps<E>>;
}) {
  return (
    <section aria-label="App skills">
      {app.activeDeployment === null ? (
        <p className="p-7 text-sm text-muted-foreground">Deploy this app to browse its skills.</p>
      ) : (
        <QueryView query={bindings.bundle} Failure={Failure} pending={<SkillBrowserLoading />}>
          {(catalog) => <SkillCatalog key={catalog.deployment} catalog={catalog} />}
        </QueryView>
      )}
    </section>
  );
}
function SkillCatalog({ catalog }: { readonly catalog: AppSkillBundle }) {
  const [selected, setSelected] = useState<string>();
  const current = catalog.skills.find((skill) => skill.name === selected) ?? catalog.skills[0];
  if (current === undefined)
    return <p className="p-7 text-sm text-muted-foreground">This app has no skills.</p>;
  return (
    <div className="grid min-h-80 min-[900px]:grid-cols-[240px_minmax(0,1fr)]">
      <nav
        aria-label="Skills"
        className="flex gap-1 overflow-x-auto border-b p-3 min-[900px]:block min-[900px]:border-b-0 min-[900px]:border-r"
      >
        {catalog.skills.map((skill) => (
          <button
            type="button"
            key={skill.name}
            onClick={() => setSelected(skill.name)}
            aria-current={current.name === skill.name ? "true" : undefined}
            className="shrink-0 rounded-md px-3 py-2.5 text-left hover:bg-muted aria-[current=true]:bg-muted min-[900px]:w-full"
          >
            <span className="block break-words text-sm font-medium">{skill.name}</span>
            <span className="mt-1 hidden text-xs leading-5 text-muted-foreground min-[900px]:block">
              {skill.description}
            </span>
          </button>
        ))}
      </nav>
      <SkillFiles key={current.name} skill={current} catalog={catalog} />
    </div>
  );
}
function SkillFiles({
  skill,
  catalog,
}: {
  readonly skill: Skill;
  readonly catalog: AppSkillBundle;
}) {
  const [file, setFile] = useState("SKILL.md");
  const resource = skill.files.find((item) => item.path === file);
  if (resource === undefined)
    return (
      <p role="alert" className="p-5 text-sm">
        This skill file is unavailable.
      </p>
    );
  const document: AppSkillDocument = {
    ...skill,
    app: catalog.app,
    deployment: catalog.deployment,
    file: resource.path,
    content: resource.content,
    files: skill.files.map((item) => item.path),
  };
  return (
    <div className="min-w-0 px-5 py-5 min-[900px]:px-10">
      <div className="max-w-3xl">
        <div className="mb-6 flex min-h-9 items-center justify-between gap-3 border-b pb-3 text-xs">
          <div className="flex min-w-0 items-center gap-2 text-muted-foreground">
            <button
              type="button"
              className="shrink-0 hover:text-foreground"
              aria-label="Back to instructions"
              onClick={() => setFile("SKILL.md")}
            >
              {skill.name}
            </button>
            <span aria-hidden>/</span>
            <span aria-label="Current skill file" className="truncate text-foreground">
              {file === "SKILL.md" ? "Instructions" : file.split("/").at(-1)}
            </span>
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm">
                Files <span className="text-muted-foreground">{skill.files.length}</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuRadioGroup value={file} onValueChange={setFile}>
                {skill.files.map((item) => (
                  <DropdownMenuRadioItem key={item.path} value={item.path}>
                    {item.path === "SKILL.md" ? "Instructions" : item.path}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <SkillContent document={document} onFile={setFile} />
      </div>
    </div>
  );
}
function SkillContent({
  document,
  onFile,
}: {
  readonly document: AppSkillDocument;
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
        <div className="text-sm leading-7 wrap-anywhere [&_h1]:mb-5 [&_h1]:mt-2 [&_h1]:text-xl [&_h1]:font-semibold [&_h2]:my-4 [&_h2]:text-lg [&_h2]:font-semibold [&_h3]:my-3 [&_h3]:font-medium [&_p]:my-3 [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:list-decimal [&_ol]:pl-6 [&_pre]:overflow-auto [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-4 [&_code]:font-mono [&_code]:text-xs [&_table]:block [&_table]:overflow-auto [&_td]:border [&_td]:p-2 [&_th]:border [&_th]:p-2">
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
