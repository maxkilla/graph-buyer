import { connectGraph, rows } from './graph.js';
import { tp } from './tools.js';

const PULL_SCORE_THRESHOLD = 30;

// The agent's decision loop. Every step either reads the graph or writes to
// it; MCP tools are only called for data the graph doesn't already have.
export async function runBuyer(vin, { sellThrough = false } = {}) {
  const graph = await connectGraph();
  const trace = [];

  // 1. Decode the donor car -> DonorCar node.
  const decoded = await tp.decodeVin(vin);
  const { Make, Model, ModelYear, Trim, EngineModel } = decoded;
  const vehicle = `${ModelYear} ${Make} ${Model}`;
  await graph.query(
    `MERGE (d:DonorCar {vin: $vin})
     SET d.year = $year, d.make = $make, d.model = $model,
         d.trim = $trim, d.engine = $engine`,
    { params: { vin, year: ModelYear, make: Make, model: Model, trim: Trim || '', engine: EngineModel || '' } },
  );
  trace.push(`MERGE (d:DonorCar {vin}) — ${vehicle}`);

  // 2. Memory check: was this donor already priced in a past session?
  const prior = rows(
    await graph.query(`MATCH (d:DonorCar {vin: $vin})-[:HAS_PART]->(p:Part)-[:LED_TO_DECISION]->(dec:Decision) RETURN p.name AS part, dec.verdict AS verdict`, { params: { vin } }),
  );
  const priorByPart = Object.fromEntries(prior.map((p) => [p.part, p.verdict]));
  if (prior.length) trace.push(`memory hit: ${prior.length} prior decision(s) for this VIN`);

  // 3. Link to similar donors (same year/make/model) so their outcomes inform this one.
  await graph.query(
    `MATCH (a:DonorCar {vin: $vin}), (b:DonorCar)
     WHERE b.vin <> $vin AND b.year = a.year AND b.make = a.make AND b.model = a.model
     MERGE (a)-[:SIMILAR_TO]->(b)`,
    { params: { vin } },
  );
  const similar = rows(
    await graph.query(
      `MATCH (d:DonorCar {vin: $vin})-[:SIMILAR_TO]->(s:DonorCar)-[:HAS_PART]->(p:Part)-[:LED_TO_DECISION]->(dec:Decision)
       RETURN s.vin AS donor, p.name AS part, dec.verdict AS verdict`,
      { params: { vin } },
    ),
  );
  trace.push(`${similar.length} decision(s) inherited from similar donors`);

  // 4. Recalls -> RECALL_FLAG edges (agent warns on recall-blocked parts).
  const recalls = await tp.checkRecalls(vehicle);
  const openRecalls = recalls.recalls || [];
  for (const r of openRecalls) {
    await graph.query(
      `MATCH (d:DonorCar {vin: $vin})
       MERGE (rc:Recall {nhtsa: $nhtsa})
       SET rc.component = $component, rc.summary = $summary
       MERGE (d)-[:RECALL_FLAG]->(rc)`,
      { params: { vin, nhtsa: r.NHTSACampaignNumber || 'unknown', component: r.Component || '', summary: r.Summary || '' } },
    );
  }
  trace.push(`${openRecalls.length} open recall(s) flagged`);

  // 5. Pull sheet -> Part nodes + PriceSignal nodes + Decision nodes.
  //    The pull sheet already ranks parts 0-100 (p25/p75, live eBay data);
  //    the graph's job is memory and traceability, not repricing.
  const sheet = await tp.getPullSheet(vehicle);
  const decisions = [];
  const topPulls = [];
  for (const part of sheet.parts || []) {
    const verdict = part.score >= PULL_SCORE_THRESHOLD ? 'PULL' : 'SKIP';
    const cached = priorByPart[part.part_name];
    await graph.query(
      `MATCH (d:DonorCar {vin: $vin})
       MERGE (p:Part {name: $part})
       MERGE (d)-[:HAS_PART]->(p)
       CREATE (s:PriceSignal {p25: $p25, p75: $p75, listings: $listings, score: $score, checked_at: $at})
       CREATE (p)-[:HAS_PRICE_SIGNAL]->(s)
       CREATE (p)-[:LED_TO_DECISION]->(:Decision {part: $part, verdict: $verdict, cached: $cached, at: $at})`,
      {
        params: {
          vin,
          part: part.part_name,
          p25: part.price_low, p75: part.price_high,
          listings: part.listing_count, score: part.score,
          verdict, cached: cached || null, at: new Date().toISOString(),
        },
      },
    );
    decisions.push({ part: part.part_name, verdict, score: part.score, p25: part.price_low, p75: part.price_high });
    if (verdict === 'PULL' && topPulls.length < 3) topPulls.push(part.part_name);
    trace.push(`Decision(${part.part_name}) = ${verdict} via Part→HAS_PRICE_SIGNAL→PriceSignal{score:${part.score}}`);
  }

  // 6. Sell-through stays on-demand (extra API calls): only for top PULLs.
  if (sellThrough) {
    for (const part of topPulls) {
      const st = await tp.checkSellThrough(vehicle, part);
      await graph.query(
        `MATCH (d:DonorCar {vin: $vin})-[:HAS_PART]->(p:Part {name: $part})
         CREATE (p)-[:SELL_THROUGH]->(:SellSignal {note: $note, at: $at})`,
        { params: { vin, part, note: st.note || '', at: new Date().toISOString() } },
      );
      trace.push(`SellSignal(${part}): ${st.note || 'no signal'}`);
    }
  }

  return { vin, vehicle, openRecalls: openRecalls.length, similarDonors: similar.length, decisions, trace };
}

// CLI-friendly printout: verdict table, then the decision trace.
export function printReport(report) {
  console.log(`\nDonor: ${report.vehicle} (${report.vin})`);
  console.log(`Open recalls: ${report.openRecalls} | Similar donors consulted: ${report.similarDonors}\n`);
  console.log('PART'.padEnd(42) + 'VERDICT'.padEnd(8) + 'SCORE'.padEnd(7) + 'P25–P75');
  console.log('-'.repeat(80));
  for (const d of report.decisions) {
    console.log(
      d.part.padEnd(42).slice(0, 42) +
        d.verdict.padEnd(8) +
        String(d.score).padEnd(7) +
        `$${d.p25 ?? '?'}–$${d.p75 ?? '?'}`,
    );
  }
  console.log('\nDecision trace:');
  for (const t of report.trace) console.log('  ' + t);
  console.log();
}
