import { FalkorDB } from 'falkordb';

// Connect to local FalkorDB (docker run -p 6379:6379 falkordb/falkordb:latest)
// and select this project's isolated graph.
export async function connectGraph() {
  const opts = {
    host: process.env.FALKORDB_HOST || 'localhost',
    port: Number(process.env.FALKORDB_PORT || 6379),
  };
  // FalkorDB Cloud needs auth; local docker usually doesn't.
  if (process.env.FALKORDB_USER) opts.username = process.env.FALKORDB_USER;
  if (process.env.FALKORDB_PASS) opts.password = process.env.FALKORDB_PASS;
  const db = await FalkorDB.connect(opts);
  return db.selectGraph('graph_buyer');
}

// FalkorDB returns rows as arrays with headers; this turns them into objects.
export function rows(result) {
  const names = (result.headers || []).map((h) => (typeof h === 'string' ? h : h.name));
  return (result.data || []).map((r) => Object.fromEntries(names.map((n, i) => [n, r[i]])));
}
