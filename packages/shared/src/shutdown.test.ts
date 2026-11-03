import { EventEmitter } from 'node:events';
import { pino } from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { onShutdown } from './shutdown.js';

const logger = pino({ level: 'silent' });

function fakeProcess() {
  const emitter = new EventEmitter();
  const exit = vi.fn<(code: number) => void>();
  return {
    target: { on: emitter.on.bind(emitter), exit },
    exit,
    send: (signal: string) => emitter.emit(signal, signal),
  };
}

describe('onShutdown', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(['SIGINT', 'SIGTERM'])(
    'closes and exits cleanly on %s',
    async (signal) => {
      const fake = fakeProcess();
      const close = vi.fn(() => Promise.resolve());
      onShutdown(logger, close, { target: fake.target });

      fake.send(signal);

      expect(close).toHaveBeenCalledOnce();
      await vi.waitFor(() => expect(fake.exit).toHaveBeenCalledWith(0));
    },
  );

  it('exits with an error when closing fails', async () => {
    const fake = fakeProcess();
    onShutdown(logger, () => Promise.reject(new Error('boom')), {
      target: fake.target,
    });

    fake.send('SIGTERM');

    await vi.waitFor(() => expect(fake.exit).toHaveBeenCalledWith(1));
  });

  it('forces the exit on a second signal', () => {
    const fake = fakeProcess();
    const close = vi.fn(() => new Promise<void>(() => {}));
    onShutdown(logger, close, { target: fake.target });

    fake.send('SIGTERM');
    expect(fake.exit).not.toHaveBeenCalled();
    fake.send('SIGINT');

    expect(close).toHaveBeenCalledOnce();
    expect(fake.exit).toHaveBeenCalledWith(1);
  });

  it('forces the exit when closing takes too long', () => {
    vi.useFakeTimers();
    const fake = fakeProcess();
    onShutdown(logger, () => new Promise<void>(() => {}), {
      target: fake.target,
      timeoutMs: 1_000,
    });

    fake.send('SIGTERM');
    vi.advanceTimersByTime(999);
    expect(fake.exit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);

    expect(fake.exit).toHaveBeenCalledWith(1);
  });
});
