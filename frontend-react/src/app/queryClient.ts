import { QueryClient } from "@tanstack/react-query";

/**
 * Shared client-side read cache. The backend remains the source of truth;
 * TanStack Query only deduplicates requests and keeps a short-lived snapshot
 * while the user moves between pages or filters.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 10 * 60_000,
      retry: 1,
      refetchOnWindowFocus: false,
      refetchOnReconnect: true,
    },
  },
});
