import { startReceiver } from './receiver.js';

const receiver = await startReceiver(
  Number(process.env.PORT ?? 4000),
  process.env.HOST,
);
console.log(`Test receiver listening at ${receiver.url}`);

// It keeps nothing worth saving, so a stop signal ends it at once. As a
// container's process 1, node would otherwise ignore SIGTERM.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => process.exit(0));
}
