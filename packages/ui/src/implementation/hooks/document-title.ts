import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

type DocumentTitleContextValue = { readonly register: (title: string) => () => void };
const DocumentTitleContext = createContext<DocumentTitleContextValue | undefined>(undefined);

/** Own the document title once per app; pages only register their current title. */
export function DocumentTitleProvider({
  fallbackTitle,
  children,
}: {
  readonly fallbackTitle: string;
  readonly children: ReactNode;
}) {
  const [dynamicTitle, setDynamicTitle] = useState<string>();
  const nextRegistration = useRef(0);
  const activeRegistration = useRef<number | undefined>(undefined);
  useEffect(() => {
    document.title = dynamicTitle ?? fallbackTitle;
  }, [dynamicTitle, fallbackTitle]);
  const register = useCallback((title: string) => {
    const id = ++nextRegistration.current;
    activeRegistration.current = id;
    setDynamicTitle(title);
    return () => {
      if (activeRegistration.current === id) {
        activeRegistration.current = undefined;
        setDynamicTitle(undefined);
      }
    };
  }, []);
  const context = useMemo(() => ({ register }), [register]);
  // oxlint-disable-next-line react/refs -- register reads refs inside its callback, not during render
  return createElement(DocumentTitleContext, { value: context }, children);
}

/** Register a page title while mounted inside the product title provider. */
export function useDocumentTitle(title: string) {
  const context = useContext(DocumentTitleContext);
  useEffect(() => context?.register(title), [context, title]);
}

/** Format a page label without exposing route IDs. */
export const productTitle = (page: string) => `${page} · Executor`;
