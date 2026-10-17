import { runBuyer } from '../src/agent.js';

// Vercel serverless wrapper around the graph-buyer agent.
// GET /api/buy?vin=<17-char-VIN>[&sell_through=1]
// Interchange lives at /api/interchange (one part per call, own 60s budget)
// Env vars (set in the Vercel dashboard, never committed):
//   TEARDOWN_PARTS_MCP_URL, TEARDOWN_PARTS_API_KEY,
//   FALKORDB_HOST, FALKORDB_PORT, FALKORDB_USER, FALKORDB_PASS
export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  const vin = req.query.vin || (req.body && req.body.vin);
  const sellThrough = req.query.sell_through === '1';

  if (!vin || vin.length !== 17) {
    return res.status(400).json({ error: 'Provide ?vin=<17-char-VIN>' });
  }

  try {
    const report = await runBuyer(String(vin).toUpperCase(), { sellThrough });
    return res.status(200).json(report);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
