// Read-only Monaco showing the run's test source (the scenario's code with
// imports + sibling tests stripped, written by the runner as test.ts).
// Lazy-loaded so the Monaco chunk never weighs down the matrix page.
import React, { useEffect, useRef, useState } from "react";
import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import TsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";

declare global {
  interface Window {
    MonacoEnvironment?: { getWorker: (workerId: string, label: string) => Worker };
  }
}
self.MonacoEnvironment = {
  getWorker: (_id, label) =>
    label === "typescript" || label === "javascript" ? new TsWorker() : new EditorWorker(),
};
// The excerpt deliberately has no imports — keep the language service quiet.
monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({
  noSemanticValidation: true,
  noSyntaxValidation: true,
});

export default function TestSource({ url }: { url: string }) {
  const container = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let editor: monaco.editor.IStandaloneCodeEditor | undefined;
    let cancelled = false;
    fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.text();
      })
      .then((text) => {
        if (cancelled || !container.current) return;
        const lines = text.split("\n").length;
        container.current.style.height = `${Math.min(Math.max(lines * 19 + 20, 140), 680)}px`;
        editor = monaco.editor.create(container.current, {
          value: text,
          language: "typescript",
          theme: "vs-dark",
          readOnly: true,
          domReadOnly: true,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          fontSize: 12.5,
          lineNumbers: "on",
          renderLineHighlight: "none",
          contextmenu: false,
          folding: false,
          automaticLayout: true,
          scrollbar: { alwaysConsumeMouseWheel: false },
          stickyScroll: { enabled: false },
          overviewRulerLanes: 0,
        });
      })
      .catch(() => setFailed(true));
    return () => {
      cancelled = true;
      editor?.dispose();
    };
  }, [url]);

  if (failed) return null;
  return <div className="code" ref={container} />;
}
