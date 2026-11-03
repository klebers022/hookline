import type { Logger } from 'pino';

const SIGNALS = ['SIGINT', 'SIGTERM'] as const;

type ShutdownLogger = Pick<Logger, 'info' | 'warn' | 'error'>;

export interface ShutdownTarget {
  on(event: string, listener: (signal: string) => void): unknown;
  exit(code: number): void;
}

export interface ShutdownOptions {
  timeoutMs?: number;
  target?: ShutdownTarget;
}

// Runs `close` on the first SIGINT or SIGTERM and exits when it finishes.
// Docker and Kubernetes send SIGTERM before killing a container, so this is
// the window to finish in-flight work. A second signal, or the timeout, ends
// the process at once.
export function onShutdown(
  logger: ShutdownLogger,
  close: () => Promise<void>,
  { timeoutMs = 30_000, target = process }: ShutdownOptions = {},
): void {
  let closing = false;

  const handle = (signal: string) => {
    if (closing) {
      logger.warn({ signal }, 'Forced shutdown');
      target.exit(1);
      return;
    }
    closing = true;
    logger.info({ signal }, 'Shutting down');
    const timer = setTimeout(() => {
      logger.error({ timeoutMs }, 'Shutdown timed out');
      target.exit(1);
    }, timeoutMs);
    timer.unref();

    close().then(
      () => {
        clearTimeout(timer);
        logger.info('Shut down');
        target.exit(0);
      },
      (error: unknown) => {
        clearTimeout(timer);
        logger.error({ err: error }, 'Shutdown failed');
        target.exit(1);
      },
    );
  };

  for (const signal of SIGNALS) {
    target.on(signal, handle);
  }
}
