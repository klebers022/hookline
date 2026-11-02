import { startReceiver } from './receiver.js';

const receiver = await startReceiver(Number(process.env.PORT ?? 4000));
console.log(`Test receiver listening at ${receiver.url}`);
