"use client";

import { createContext, useContext, type ReactNode } from "react";

type CodespaceContextValue = {
  sessionTitle: string;
  repoName: string | null;
  repoOwner: string | null;
  branch: string | null;
  cloneUrl: string | null;
};

const CodespaceContext = createContext<CodespaceContextValue | undefined>(
  undefined,
);

export function useCodespaceContext() {
  const ctx = useContext(CodespaceContext);
  if (!ctx) {
    throw new Error(
      "useCodespaceContext must be used within a CodespaceProvider",
    );
  }
  return ctx;
}

export function CodespaceProvider({
  sessionTitle,
  repoName,
  repoOwner,
  branch,
  cloneUrl,
  children,
}: {
  sessionTitle: string;
  repoName: string | null;
  repoOwner: string | null;
  branch: string | null;
  cloneUrl: string | null;
  children: ReactNode;
}) {
  return (
    <CodespaceContext.Provider
      value={{ sessionTitle, repoName, repoOwner, branch, cloneUrl }}
    >
      {children}
    </CodespaceContext.Provider>
  );
}
