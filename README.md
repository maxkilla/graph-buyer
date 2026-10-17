# graph-buyer

A FalkorDB graph agent that decides which parts to pull off a donor car, and shows the path behind every answer.
Built for **Graph Hacks 2026** (WeMakeDevs x FalkorDB). Tracks: **01 Agents That Act on Connected Data** and **02 Agent Memory and Coordination**.

**Live demo:** https://graph-buyer.vercel.app  (enter a VIN, press Evaluate)

## The idea

Salvage-yard buying is a connections problem: which parts a donor car carries, what they sell for, what sold before, which other cars share the part, and what past decisions said. graph-buyer keeps all of that in a FalkorDB graph and reasons over it. The graph is the agent's context layer, not the prompt.

## How the agent works

```
VIN in -> decode_vin                  -> DonorCar node
       -> graph: prior decisions      (memory check, scoped to this VIN)
       -> graph: SIMILAR_TO donors    (same year/make/model) and their decisions
       -> check_recalls               -> Recall nodes + RECALL_FLAG edges
       -> graph: fresh PriceSignals?  yes -> price from memory, 0 live searches
                                      no  -> get_pull_sheet (live eBay) -> PriceSignal + Decision nodes
       -> graph: shared Part nodes    -> which other donors can use a pulled part
       -> verdict table + decision trace
       (on demand) find_interchange   -> part numbers + other fitting vehicles, cached in the graph
```

- **Graph first, tools second.** The agent only calls MCP tools for data the graph does not already have. A repeat VIN is answered from the graph in a few seconds with no eBay searches.
- **Memory across sessions.** `PriceSignal` history and per-donor `Decision` nodes persist (3-day price TTL). A new donor of the same model inherits outcomes through `SIMILAR_TO`.
- **Explainable.** Every verdict is returned with the graph path behind it (`Part -> HAS_PRICE_SIGNAL -> PriceSignal{score}`), and the page draws this run's graph and lists the full decision trace.

## Graph schema

```
(DonorCar)-[:HAS_PART]->(Part)-[:HAS_PRICE_SIGNAL]->(PriceSignal {p25,p75,score,checked_at})
(Part)-[:LED_TO_DECISION]->(Decision {vin,part,verdict,at})
(DonorCar)-[:SIMILAR_TO]->(DonorCar)
(DonorCar)-[:RECALL_FLAG]->(Recall)
(Part)-[:SELL_THROUGH]->(SellSignal)
```

Part numbers and the vehicles they fit (`PartNumber -> LISTED_FOR -> FitVehicle`) are cached by the MCP server in its own `teardown` graph.

## What is reused vs new

- **Reused infrastructure:** the teardown-parts MCP server behind https://teardown.parts (tools: `decode_vin`, `check_recalls`, `get_pull_sheet`, `check_sell_through`, `ebay_lookup`, `find_interchange`, `hollander_group`). It already ranks parts 0-100 from live eBay p25/p75 data. The graph's job here is memory, coordination and traceability, not repricing.
- **New during the event:** this repo (the `graph_buyer` schema, the agent decision loop, graph-first tool selection, the decision trace and graph view), plus a FalkorDB-backed cache added to the MCP server (Hollander fitment groups and eBay interchange results).

## Run it

```bash
npm install
cp .env.example .env     # fill in the MCP URL/key and FalkorDB connection
npm start -- <17-char-VIN> [--sell-through]
```

FalkorDB can be FalkorDB Cloud or local (`docker run -p 6379:6379 falkordb/falkordb:latest`). The web page and API (`/api/buy`, `/api/interchange`) deploy to Vercel as-is; set the same variables in the project settings.

## Demo script (60 seconds)

1. Open the live page, run the default VIN: first run on a model prices every part live (can take up to ~60 s).
2. Run it again: badge shows "priced from graph memory - 0 live searches".
3. Run a second VIN of the same model: decisions are inherited from similar donors.
4. Open "decision trace" and the graph view to see why each verdict was made.
5. Press "Check interchange for top PULLs" for part numbers and other vehicles each part fits.
