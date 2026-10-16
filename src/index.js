import 'dotenv/config';
import { runBuyer, printReport } from './agent.js';

const vin = process.argv[2];
const sellThrough = process.argv.includes('--sell-through');

if (!vin) {
  console.error('Usage: npm start -- <17-char-VIN> [--sell-through]');
  process.exit(1);
}

runBuyer(vin, { sellThrough })
  .then(printReport)
  .catch((err) => {
    console.error('graph-buyer failed:', err.message);
    process.exit(1);
  });
