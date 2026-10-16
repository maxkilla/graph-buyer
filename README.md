# graph-buyer

A FalkorDB graph agent that decides which parts to pull off a donor car — and shows the path behind every answer. Graph Hacks 2026 entry (Track 01: Agents That Act on Connected Data, Track 02: Agent Memory and Coordination).

## The idea

Salvage-yard buying is a connections problem: which parts a donor carries, what they sell for, what sold before, what past decisions said. graph-buyer puts that in a FalkorDB graph and reasons over it. The agent's context layer is the graph — not prompts.

## How it works

```
VIN in → decode_vin → DonorCar node
       → checkRecalls → RECALL_FLAG edges
       → graph query: similar donors (SIMILAR_TO) + their past decisions
       → get_pull_sheet → Part nodes + PriceSignal nodes + Decision nodes
       → (optional) check_sell_through on top PULLs (on-demand, extra API calls)
       → verdict table + decision trace printed
```

**Tool selection through MCP:** the graph is checked first; the agent only calls the teardown-parts tools for data the graph doesn't already have. Graph-first, API-second.

**Memory across sessions:** PriceSignal history and past Decision nodes persist. A second donor of the same model reuses cached signals and inherits outcomes from SIMILAR_TO donors — no graph experience required to see why.

**Explainable results:** every verdict is printed with the Cypher path behind it (`Part→HAS_PRICE_SIGNAL→PriceSignal{score}`). Decisions you can trace.

## What's reused vs new

- Reused (existing infrastructure): teardown-parts MCP server v1.1.0 — `decode_vin`, `check_recalls`, `get_pull_sheet`, `check_sell_through`, `ebay_lookup`. The pull sheet already ranks parts 0–100 from live eBay p25/p75 data; the graph's job is memory and traceability, not repricing.
- New (built during the event): the FalkorDB schema, the agent decision loop, MCP tool selection, the decision trace output.

## Setup

```bash
docker run -p 6379:6379 falkordb/falkordb:latest
npm install
cp .env.example .env   # fill in TEARDOWN_PARTS_MCP_URL + TEARDOWN_PARTS_API_KEY
npm start -- <17-char-VIN> [--sell-through]
```

## Submission

- Tracks: 01 (Agents That Act on Connected Data), 02 (Agent Memory and Coordination)
- Demo: run the CLI against a VIN; FalkorDB Browser (`localhost:3000` via the docker UI, or `falkordb/falkordb` browser) shows the graph
- No live deployment required: complete local setup instructions + working demo video
