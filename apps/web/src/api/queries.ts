import { useInfiniteQuery } from '@tanstack/react-query';
import { useApi } from '../auth';
import type { Page } from './types';

// A cursor-paginated list: each page asks for the rows after the last one.
export function usePagedList<T>(
  key: unknown[],
  path: string,
  refetchInterval: number | false = false,
) {
  const api = useApi();
  const query = useInfiniteQuery({
    queryKey: key,
    queryFn: ({ pageParam }) => {
      const separator = path.includes('?') ? '&' : '?';
      return api.get<Page<T>>(
        pageParam ? `${path}${separator}cursor=${pageParam}` : path,
      );
    },
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.next_cursor,
    refetchInterval,
  });
  const rows = query.data?.pages.flatMap((page) => page.data) ?? [];
  return { ...query, rows };
}

// Details of something still in progress refresh until it settles.
export const REFRESH_MS = 3_000;
