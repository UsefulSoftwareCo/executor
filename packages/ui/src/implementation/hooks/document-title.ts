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
import { useProductBrand } from "./product-brand.ts";

type DocumentTitleContextValue = { readonly register: (title: string) => () => void };
const DocumentTitleContext = createContext<DocumentTitleContextValue | undefined>(undefined);

/**
 * Own the document title once per app; pages only register their current page label, which the
 * title follows with the product's name.
 */
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
  const { name } = useProductBrand();
  useEffect(() => {
    document.title = `${dynamicTitle ?? fallbackTitle} · ${name}`;
  }, [dynamicTitle, fallbackTitle, name]);
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

/** Register a page label while mounted inside the product title provider. */
export function useDocumentTitle(title: string) {
  const context = useContext(DocumentTitleContext);
  useEffect(() => context?.register(title), [context, title]);
}
