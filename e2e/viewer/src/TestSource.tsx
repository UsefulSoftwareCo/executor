// Read-only Monaco showing the run's test source (the scenario's code with
// imports + sibling tests stripped, written by the runner as test.ts).
// Uses Monaco CORE + the monarch TypeScript colorizer only, with no language
// service or ts.worker. A read-only pane needs highlighting, not IntelliSense
// (the full build is ~12 MB of workers). Lazy-loaded so the matrix stays light.
import React, { useEffect, useRef, useState } from "react";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api";
import "monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";

declare global {
  interface Window {
    MonacoEnvironment?: { getWorker: (workerId: string, label: string) => Worker };
  }
}
self.MonacoEnvironment = { getWorker: () => new EditorWorker() };

interface SourceMetadata {
  readonly sourcePath: string;
  readonly testName: string;
  readonly registration: string;
  readonly extractor: string;
}

const parseSourceMetadata = (value: unknown): SourceMetadata | null => {
  if (typeof value !== "object" || value === null) return null;
  if (
    !("sourcePath" in value) ||
    typeof value.sourcePath !== "string" ||
    !("testName" in value) ||
    typeof value.testName !== "string" ||
    !("registration" in value) ||
    typeof value.registration !== "string" ||
    !("extractor" in value) ||
    typeof value.extractor !== "string"
  ) {
    return null;
  }
  return {
    sourcePath: value.sourcePath,
    testName: value.testName,
    registration: value.registration,
    extractor: value.extractor,
  };
};

export default function TestSource({ url, metadataUrl }: { url: string; metadataUrl?: string }) {
  const container = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  const [metadata, setMetadata] = useState<SourceMetadata | null>(null);

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

  useEffect(() => {
    if (!metadataUrl) {
      setMetadata(null);
      return;
    }
    fetch(metadataUrl)
      .then((response) => (response.ok ? response.json() : null))
      .then((value) => setMetadata(parseSourceMetadata(value)))
      .catch(() => setMetadata(null));
  }, [metadataUrl]);

  if (failed) return null;
  return (
    <>
      {metadata && (
        <p className="source-provenance">
          Focused from <code>{metadata.sourcePath}</code> via {metadata.registration} (
          {metadata.extractor})
        </p>
      )}
      <div className="code" ref={container} />
    </>
  );
}
