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
    // ?expect=<substring>: reports only true/false whether the configured host contains it (host stays private).
    const expect = String(req.query.expect || '');
    const body = { ok: true, last: rows(r)[0]?.last ?? null };
    if (expect) body.host_matches = String(process.env.FALKORDB_HOST || '').includes(expect);
    return res.status(200).json(body);
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}
