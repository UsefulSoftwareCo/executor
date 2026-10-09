import { Fragment, useMemo } from "react";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { highlightedAtom } from "@executor-js/ui/contracts/highlight";
import { codeLanguage } from "@executor-js/ui/contracts/code-language";

/** Show source as plain text until the shared highlighter loads, then as colored tokens. */
export function HighlightedCode({ code, path }: { readonly code: string; readonly path: string }) {
  const language = codeLanguage(path);
  const atom = useMemo(() => highlightedAtom({ code, language }), [code, language]);
  const result = useAtomValue(atom);
  if (!AsyncResult.isSuccess(result)) return <code>{code}</code>;
  return (
    <code>
      {result.value.map((line, i) => (
        <Fragment key={i}>
          {i > 0 && "\n"}
          {line.map((token, j) => (
            <span key={j} style={token.htmlStyle}>
              {token.content}
            </span>
          ))}
        </Fragment>
      ))}
    </code>
  );
}
