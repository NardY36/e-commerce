import { Router, type Request, type Response } from "express";
import express from "express";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { log } from "../logger.js";

export const courierRouter = Router();

const Event = z.object({
  clientPingId: z.string().uuid(),
  courierId: z.string().min(1),
  orderId: z.string().uuid().nullable().optional(),
  kind: z.enum(["LOCATION", "DELIVERY_CONFIRMED"]),
  lat: z.number().gte(-90).lte(90),
  lng: z.number().gte(-180).lte(180),
  recordedAt: z.string().datetime(),
});

const BatchBody = z.object({ events: z.array(Event).max(500) });

/**
 * Batch ingest for the offline courier app. Mirrors the Dart module's upload
 * contract: `{ events: [...] }` in, `{ acceptedIds: [...] }` out.
 *
 * Every event is upserted on its device-generated client_ping_id with
 * ON CONFLICT DO NOTHING, so a batch that the courier's phone re-sends after a
 * dropped ack is deduplicated here — the server stays the single source of truth
 * and never double-counts a delivery. Locations are stored as PostGIS geography
 * points so "who is nearest" stays a single indexed query.
 */
courierRouter.post("/pings", express.json({ limit: "1mb" }), async (req: Request, res: Response) => {
  const parsed = BatchBody.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_batch", details: parsed.error.flatten() });
  }
  const { events } = parsed.data;
  if (events.length === 0) return res.json({ acceptedIds: [] });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const e of events) {
      await client.query(
        `INSERT INTO courier_pings
           (client_ping_id, courier_id, order_id, kind, location, recorded_at)
         VALUES ($1,$2,$3,$4, ST_SetSRID(ST_MakePoint($5,$6),4326)::geography, $7)
         ON CONFLICT (client_ping_id) DO NOTHING`,
        [e.clientPingId, e.courierId, e.orderId ?? null, e.kind, e.lng, e.lat, e.recordedAt],
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    log.error("courier batch ingest failed", { err: String(err) });
    return res.status(500).json({ error: "ingest_failed" });
  } finally {
    client.release();
  }

  // Everything submitted is now durably stored (new or already-present) — the app
  // can safely clear all of these from its outbox.
  const acceptedIds = events.map((e) => e.clientPingId);
  log.info("courier batch ingested", { count: acceptedIds.length });
  res.json({ acceptedIds });
});
