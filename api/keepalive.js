import { connectGraph, rows } from '../src/graph.js';

// Daily keep-alive (see vercel.json crons): FalkorDB Cloud reclaims idle
// instances, so do a tiny real write + read against the graph.
export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  try {
    const graph = await connectGraph();
    const r = await graph.query(
      "MERGE (k:Keepalive {id: 'heartbeat'}) SET k.last = timestamp() RETURN k.last AS last"
    );
    return res.status(200).json({ ok: true, last: rows(r)[0]?.last ?? null });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}
