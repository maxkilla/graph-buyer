import { FalkorDB } from 'falkordb';

// Connect to local FalkorDB (docker run -p 6379:6379 falkordb/falkordb:latest)
// and select this project's isolated graph.
export async function connectGraph() {
  // Documented client form: socket for host/port, top-level for auth.
  const opts = {
    socket: {
      host: (process.env.FALKORDB_HOST || 'localhost').split(':')[0],
      port: Number(process.env.FALKORDB_PORT || 6379),
    },
  };
  // FalkorDB Cloud needs auth; local docker usually doesn't.
  if (process.env.FALKORDB_USER) opts.username = process.env.FALKORDB_USER;
  if (process.env.FALKORDB_PASS) opts.password = process.env.FALKORDB_PASS;
  const db = await FalkorDB.connect(opts);
  return db.selectGraph('graph_buyer');
}

// falkordb v6 returns { metadata, data: [{col: value, ...}, ...] } — rows
// already shaped as objects keyed by column alias. Older clients returned
// { headers: [...], data: [[...], ...] }; keep supporting that shape too.
export function rows(result) {
  const data = result?.data || [];
  if (data.length && data[0] && typeof data[0] === 'object' && !Array.isArray(data[0])) {
    return data;
  }
  const names = (result.headers || []).map((h) => (typeof h === 'string' ? h : h.name));
  return data.map((r) => Object.fromEntries(names.map((n, i) => [n, r[i]])));
}
