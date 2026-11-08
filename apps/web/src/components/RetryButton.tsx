import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../auth';
import { Button, ErrorMessage } from './ui';

// A manual retry gives a dead delivery one more attempt. The API answers 409
// when it cannot (the delivery is not dead, or its endpoint is disabled).
export function RetryButton({
  deliveryId,
  size = 'md',
}: {
  deliveryId: string;
  size?: 'md' | 'sm';
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const retry = useMutation({
    mutationFn: () => api.post(`/v1/deliveries/${deliveryId}/retry`),
    // Every list or detail that shows this delivery is now out of date.
    onSuccess: () => queryClient.invalidateQueries(),
  });

  return (
    <div className="flex flex-col items-end gap-1.5">
      <Button
        variant={size === 'sm' ? 'secondary' : 'primary'}
        size={size}
        disabled={retry.isPending}
        onClick={() => retry.mutate()}
      >
        {retry.isPending ? 'Retrying…' : 'Retry'}
      </Button>
      {retry.error && <ErrorMessage error={retry.error} />}
    </div>
  );
}
