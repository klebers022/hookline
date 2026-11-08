import { Button } from './ui';

export function LoadMore({
  hasNextPage,
  isFetchingNextPage,
  fetchNextPage,
}: {
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  fetchNextPage: () => unknown;
}) {
  if (!hasNextPage) {
    return null;
  }
  return (
    <div className="mt-4 flex justify-center">
      <Button disabled={isFetchingNextPage} onClick={() => fetchNextPage()}>
        {isFetchingNextPage ? 'Loading…' : 'Load more'}
      </Button>
    </div>
  );
}
