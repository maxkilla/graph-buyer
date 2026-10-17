import { connectGraph, rows } from './graph.js';
import { tp } from './tools.js';

const PULL_SCORE_THRESHOLD = 30;

// The agent's decision loop. Every step either reads the graph or writes to
// it; MCP tools are only called for data the graph doesn't already have.
export async function runBuyer(vin, { sellThrough = false, interchange = false } = {}) {
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

  // 5. Pricing: reuse fresh graph PriceSignals when this VIN was priced
  //    recently (3-day TTL, same as the pull-sheet cache) — no repeat eBay
  //    searches. Otherwise run the live pull sheet and persist the signals.
  const PRICE_TTL_MS = 3 * 24 * 60 * 60 * 1000;
  const cutoff = new Date(Date.now() - PRICE_TTL_MS).toISOString();
  const donorParts = rows(
    await graph.query(
      `MATCH (d:DonorCar {vin: $vin})-[:HAS_PART]->(p:Part) RETURN p.name AS part`,
      { params: { vin } },
    ),
  ).map((r) => r.part);
  const freshSignals = rows(
    await graph.query(
      `MATCH (d:DonorCar {vin: $vin})-[:HAS_PART]->(p:Part)-[:HAS_PRICE_SIGNAL]->(s:PriceSignal {vin: $vin})
       WHERE s.checked_at > $cutoff
       RETURN p.name AS part, s.score AS score, s.p25 AS p25, s.p75 AS p75, s.checked_at AS checked_at
       ORDER BY s.checked_at DESC`,
      { params: { vin, cutoff } },
    ),
  );
  const signalByPart = {};
  for (const s of freshSignals) signalByPart[s.part] ??= s; // latest wins
  let pricing = donorParts.length > 0 && donorParts.every((p) => signalByPart[p]) ? 'memory' : 'live';

  const decisions = [];
  const topPulls = [];
  if (pricing === 'memory') {
    trace.push(`0 live searches — ${donorParts.length} part(s) priced from graph memory (signals fresh as of ${cutoff.slice(0, 10)})`);
    for (const part of donorParts) {
      const s = signalByPart[part];
      const verdict = s.score >= PULL_SCORE_THRESHOLD ? 'PULL' : 'SKIP';
      decisions.push({ part, verdict, score: s.score, p25: s.p25, p75: s.p75 });
      if (verdict === 'PULL' && topPulls.length < 3) topPulls.push(part);
      trace.push(`Decision(${part}) = ${verdict} via graph memory PriceSignal{score:${s.score}}`);
    }
  } else {
    const sheet = await tp.getPullSheet(vehicle);
    const liveParts = sheet.parts || [];
    if (!liveParts.length && donorParts.length) {
      // Live pull sheet came back empty — fall back to the freshest graph
      // signals instead of showing nothing.
      pricing = 'memory-stale';
      const stale = rows(
        await graph.query(
          `MATCH (d:DonorCar {vin: $vin})-[:HAS_PART]->(p:Part)-[:HAS_PRICE_SIGNAL]->(s:PriceSignal)
           RETURN p.name AS part, s.score AS score, s.p25 AS p25, s.p75 AS p75, s.checked_at AS checked_at
           ORDER BY s.checked_at DESC`,
          { params: { vin } },
        ),
      );
      const staleByPart = {};
      for (const s of stale) staleByPart[s.part] ??= s;
      const covered = donorParts.filter((p) => staleByPart[p]);
      trace.push(`live pull sheet returned 0 parts — fell back to ${covered.length} stale graph signal(s)`);
      for (const part of covered) {
        const s = staleByPart[part];
        const verdict = s.score >= PULL_SCORE_THRESHOLD ? 'PULL' : 'SKIP';
        decisions.push({ part, verdict, score: s.score, p25: s.p25, p75: s.p75 });
        if (verdict === 'PULL' && topPulls.length < 3) topPulls.push(part);
        trace.push(`Decision(${part}) = ${verdict} via stale graph PriceSignal{score:${s.score}}`);
      }
    }
    for (const part of liveParts) {
      const verdict = part.score >= PULL_SCORE_THRESHOLD ? 'PULL' : 'SKIP';
      const cached = priorByPart[part.part_name];
      await graph.query(
        `MATCH (d:DonorCar {vin: $vin})
         MERGE (p:Part {name: $part})
         MERGE (d)-[:HAS_PART]->(p)
         CREATE (s:PriceSignal {vin: $vin, p25: $p25, p75: $p75, listings: $listings, score: $score, checked_at: $at})
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
    if (liveParts.length) trace.push(`${liveParts.length} part(s) priced live — PriceSignals persisted to graph`);
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

  // 7. Interchange is on-demand (heavy eBay searches; the worker caches
  //    results 3 days in its own graph): real part numbers + the other
  //    vehicles each top PULL part fits. Stored as PartNumber/FitVehicle nodes.
  let interchangeOut = [];
  if (interchange) {
    for (const part of topPulls) {
      try {
        const ic = await tp.findInterchange(vehicle, part);
        const fits = [];
        const seen = new Set();
        const numbers = [];
        for (const entry of ic.interchange || []) {
          if (!entry.part_number) continue;
          numbers.push(entry.part_number);
          await graph.query(
            `MERGE (pn:PartNumber {number: $number})
             SET pn.part = $part
             WITH pn
             MATCH (d:DonorCar {vin: $vin})-[:HAS_PART]->(p:Part {name: $part})
             MERGE (p)-[:HAS_NUMBER]->(pn)`,
            { params: { number: entry.part_number, part, vin } },
          );
          for (const f of entry.also_fits || []) {
            if (f.is_requested_vehicle) continue;
            const key = `${f.make}|${f.model}`;
            if (!seen.has(key)) {
              seen.add(key);
              fits.push({ make: f.make, model: f.model, years: f.years, median_price: f.median_price, listings: f.listings, hollander: f.hollander || null });
            }
            await graph.query(
              `MERGE (pn:PartNumber {number: $number})
               MERGE (v:FitVehicle {make: $make, model: $model})
               SET v.years = $years, v.median_price = $median
               MERGE (pn)-[:LISTED_FOR]->(v)`,
              { params: { number: entry.part_number, make: f.make, model: f.model, years: f.years || '', median: f.median_price ?? null } },
            );
          }
        }
        interchangeOut.push({ part, numbers: [...new Set(numbers)], fits, hollander: ic.hollander || null });
        const fitStr = fits.slice(0, 6).map((f) => `${f.years || ''} ${f.make} ${f.model}`.trim()).join(', ');
        trace.push(`Interchange(${part}): ${numbers.length} number(s)${fitStr ? ` — also fits ${fitStr}` : ''}`);
      } catch (e) {
        trace.push(`Interchange(${part}): lookup failed (${e.message})`);
      }
    }
  }

  // 8. Cross-donor reach: shared Part nodes reveal the other donors
  //    carrying the same part — broadens who a pulled part can sell to.
  const pullParts = decisions.filter((d) => d.verdict === 'PULL').map((d) => d.part);
  let sharedParts = [];
  if (pullParts.length) {
    const shared = rows(
      await graph.query(
        `MATCH (d:DonorCar {vin: $vin})-[:HAS_PART]->(p:Part)<-[:HAS_PART]-(o:DonorCar)
         WHERE o.vin <> $vin AND p.name IN $parts
         RETURN p.name AS part, o.year AS year, o.make AS make, o.model AS model`,
        { params: { vin, parts: pullParts } },
      ),
    );
    const byPart = {};
    for (const r of shared) (byPart[r.part] ??= []).push(`${r.year} ${r.make} ${r.model}`.trim());
    sharedParts = pullParts.filter((p) => byPart[p]).map((p) => ({ part: p, donors: [...new Set(byPart[p])] }));
    if (sharedParts.length) trace.push(`Cross-donor reach: ${sharedParts.length} PULL part(s) also appear on ${[...new Set(shared.flatMap((s) => byPart[s.part] ?? []))].length} other donor(s)`);
  }

  return { vin, vehicle, openRecalls: openRecalls.length, similarDonors: similar.length, pricing, decisions, sharedParts, interchange: interchangeOut, trace };
}

// CLI-friendly printout: verdict table, then the decision trace.
export function printReport(report) {
  console.log(`
Donor: ${report.vehicle} (${report.vin})`);
  console.log(`Open recalls: ${report.openRecalls} | Similar donors consulted: ${report.similarDonors} | Pricing: ${report.pricing}
`);
  console.log('PART'.padEnd(42) + 'VERDICT'.padEnd(8) + 'SCORE'.padEnd(7) + 'P25âP75');
  console.log('-'.repeat(80));
  for (const d of report.decisions) {
    console.log(
      d.part.padEnd(42).slice(0, 42) +
        d.verdict.padEnd(8) +
        String(d.score).padEnd(7) +
        `$${d.p25 ?? '?'}â$${d.p75 ?? '?'}`,
    );
  }
  console.log('
Decision trace:');
  for (const t of report.trace) console.log('  ' + t);
  console.log();
}
