import { useEffect } from "react";

const APP_NAME = "Executor";

export function executorDocumentTitle(page: string): string {
  return `${page} · ${APP_NAME}`;
}

export function useExecutorDocumentTitle(page: string | null | undefined): void {
  useEffect(() => {
    if (!page || typeof document === "undefined") return;
    document.title = executorDocumentTitle(page);
  }, [page]);
}
