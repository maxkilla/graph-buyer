import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// MCP client for the teardown-parts server (v1.2.0, StreamableHTTP, Bearer auth).
// The server's tools are the agent's only external data source:
// decode_vin, check_recalls, get_pull_sheet, check_sell_through, ebay_lookup,
// find_interchange, hollander_group.
let client = null;

export async function mcp() {
  if (client) return client;
  const url = new URL(process.env.TEARDOWN_PARTS_MCP_URL);
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: {
      headers: { Authorization: `Bearer ${process.env.TEARDOWN_PARTS_API_KEY}` },
    },
  });
  client = new Client({ name: 'graph-buyer', version: '0.1.0' }, { capabilities: {} });
  await client.connect(transport);
  return client;
}

export async function callTool(name, args) {
  const c = await mcp();
  const res = await c.callTool({ name, arguments: args });
  const text = (res.content || []).map((p) => p.text || '').join('');
  return JSON.parse(text);
}

// Tool selection happens in agent.js: the graph is checked first, and tools
// are only called for data the graph doesn't already have.
export const tp = {
  decodeVin: (vin) => callTool('decode_vin', { vin }),
  checkRecalls: (vehicle) => callTool('check_recalls', { vehicle }),
  getPullSheet: (vehicle) => callTool('get_pull_sheet', { vehicle }),
  checkSellThrough: (vehicle, part) => callTool('check_sell_through', { vehicle, part }),
  ebayLookup: (query, opts = {}) => callTool('ebay_lookup', { query, ...opts }),
  findInterchange: (vehicle, part, opts = {}) => callTool('find_interchange', { vehicle, part, ...opts }),
  hollanderGroup: (year, make, model, part, candidates) =>
    callTool('hollander_group', candidates ? { year, make, model, part, candidates } : { year, make, model, part }),
};
