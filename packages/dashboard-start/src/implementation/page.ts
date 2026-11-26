import { useRouter } from "@tanstack/react-router";

export function usePageUrl(): URL {
  const router = useRouter();
  const { pathname, search, hash } = router.history.location;
  return new URL(pathname + search + hash, router.origin);
}
