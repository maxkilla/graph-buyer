import { connectGraph } from '../src/graph.js';
import { tp } from '../src/tools.js';

// Standalone interchange lookup: one part per call, so each lookup gets its
// own 60s function budget (the combined /api/buy call can't fit them).
// GET /api/interchange?vin=<17-char-VIN>&vehicle=<year make model>&part=<name>
export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  const vin = String(req.query.vin || '').toUpperCase();
  const vehicle = String(req.query.vehicle || '');
  const part = String(req.query.part || '');
  if (vin.length !== 17 || !vehicle || !part) {
    return res.status(400).json({ error: 'Provide ?vin=<17-char-VIN>&vehicle=<year make model>&part=<name>' });
  }

  try {
    const graph = await connectGraph();
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

    return res.status(200).json({
      part,
      numbers: [...new Set(numbers)],
      fits,
      hollander: ic.hollander || null,
      caution: ic.caution || null,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
