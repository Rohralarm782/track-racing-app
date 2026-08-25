// Zielpfad im Repo: backend/src/routes/pursuit-runs.ts  (NEUE Datei)
// Gefahrene Verfolgungsläufe: aus dem Renntimer gespeichert oder von Hand
// nachgetragen. Siehe schema.prisma, model PursuitRun.
//
// Bewusste Festlegungen:
//  - `laps` wird als JSON gespeichert, nicht als eigene Tabelle. Eine Runde ist
//    ohne ihren Lauf bedeutungslos, es wird nie einzeln danach gesucht, und der
//    Renntimer schreibt sie ohnehin nur am Stück.
//  - totalMs wird beim Anlegen NICHT aus den Runden gerechnet, sondern so
//    übernommen wie geliefert. Beim Timer ist das die Summe, bei einer von Hand
//    eingetragenen Zeit gibt es (noch) gar keine Runden. Weichen Summe und
//    Zielzeit später ab, ist das der Normalfall und kein Fehler.
//  - Gelöscht wird hart (kein Soft-Delete): ein Vertipper soll spurlos weg sein.
//  - trackName/trackSurface sind frei getippter Text ohne eigene Bahn-Tabelle.
//    GET /tracks liefert die bereits verwendeten Bahnen ALLER Läufe als
//    Vorschlagsliste zurück — so pflegt sich der Bestand von selbst.
import { Router } from 'express';
import { z } from 'zod';
import prisma from '../prisma';
import { requireAdmin } from '../middleware/auth';

const router = Router();

const TIME_SOURCES = ['TIMER', 'KORRIGIERT', 'OFFIZIELL', 'MANUELL'] as const;
const SURFACES = ['HOLZ', 'BETON'] as const;

const LapSchema = z.object({
  lapMs: z.number().int().nonnegative(),
  halfMs: z.number().int().nonnegative().nullable().optional(),
});

const GearSchema = z.object({ kb: z.number().int().positive(), rz: z.number().int().positive() });

const RunSchema = z.object({
  raceId: z.string().nullable().optional(),
  athleteIds: z.array(z.string()).default([]),
  label: z.string().min(1),
  eventName: z.string().nullable().optional(),

  trackM: z.number().positive(),
  numRounds: z.number().int().positive(),
  distanceM: z.number().int().positive().nullable().optional(),
  trackName: z.string().max(80).nullable().optional(),
  trackSurface: z.enum(SURFACES).nullable().optional(),

  laps: z.array(LapSchema).default([]),
  totalMs: z.number().int().nonnegative().nullable().optional(),
  officialTotalMs: z.number().int().nonnegative().nullable().optional(),
  timeSource: z.enum(TIME_SOURCES).default('TIMER'),
  complete: z.boolean().default(true),
  notes: z.string().nullable().optional(),

  kb: z.number().int().positive().nullable().optional(),
  rz: z.number().int().positive().nullable().optional(),
  gears: z.record(GearSchema).nullable().optional(),
  circMm: z.number().int().positive().default(2100),

  planAnfahrtSec: z.number().positive().nullable().optional(),
  planLapSec: z.number().positive().nullable().optional(),
  planTotalSec: z.number().positive().nullable().optional(),

  ridenAt: z.string().datetime().optional(),
});

// Beim Bearbeiten sind nur die Felder erlaubt, die im Bearbeiten-Modus der
// Karte auch wirklich änderbar sind. raceId/athleteIds bleiben bewusst außen
// vor — ein Lauf wechselt nicht nachträglich den Fahrer.
const RunPatchSchema = z.object({
  label: z.string().min(1).optional(),
  eventName: z.string().nullable().optional(),
  trackM: z.number().positive().optional(),
  numRounds: z.number().int().positive().optional(),
  distanceM: z.number().int().positive().nullable().optional(),
  trackName: z.string().max(80).nullable().optional(),
  trackSurface: z.enum(SURFACES).nullable().optional(),
  laps: z.array(LapSchema).optional(),
  totalMs: z.number().int().nonnegative().nullable().optional(),
  officialTotalMs: z.number().int().nonnegative().nullable().optional(),
  timeSource: z.enum(TIME_SOURCES).optional(),
  complete: z.boolean().optional(),
  notes: z.string().nullable().optional(),
  kb: z.number().int().positive().nullable().optional(),
  rz: z.number().int().positive().nullable().optional(),
  gears: z.record(GearSchema).nullable().optional(),
  circMm: z.number().int().positive().optional(),
  ridenAt: z.string().datetime().optional(),
});

// ── GET /api/pursuit-runs/tracks — öffentlich ───────────────────────────────
// Bereits eingetragene Bahnen über ALLE Läufe hinweg, für die Vorschlagsliste
// im Formular. Der Untergrund kommt jeweils aus dem zuletzt gefahrenen Lauf
// dieser Bahn — hat jemand einmal falsch getippt und es später korrigiert,
// gewinnt die Korrektur, ohne dass alte Läufe angefasst werden müssen.
router.get('/tracks', async (_req, res, next) => {
  try {
    const rows = await prisma.pursuitRun.findMany({
      where: { NOT: { trackName: null } } as any,
      select: { trackName: true, trackSurface: true, ridenAt: true } as any,
      orderBy: { ridenAt: 'desc' },
    }) as unknown as { trackName: string | null; trackSurface: string | null }[];

    // Nach getrimmtem Kleinbuchstaben-Namen gruppieren, damit "cottbus" und
    // "Cottbus" nicht zweimal in der Liste stehen. Angezeigt wird die
    // Schreibweise des jüngsten Laufs.
    const byKey = new Map<string, { name: string; surface: string | null; count: number }>();
    for (const r of rows) {
      const name = (r.trackName ?? '').trim();
      if (!name) continue;
      const key = name.toLowerCase();
      const hit = byKey.get(key);
      if (!hit) {
        byKey.set(key, { name, surface: r.trackSurface ?? null, count: 1 });
      } else {
        hit.count += 1;
        if (hit.surface === null && r.trackSurface) hit.surface = r.trackSurface;
      }
    }

    const tracks = [...byKey.values()].sort(
      (a, b) => b.count - a.count || a.name.localeCompare(b.name, 'de'),
    );
    res.json(tracks);
  } catch (e) { next(e); }
});

// ── GET /api/pursuit-runs?athleteId=…&raceId=… — öffentlich ──────────────────
router.get('/', async (req, res, next) => {
  try {
    const athleteId = typeof req.query.athleteId === 'string' ? req.query.athleteId : null;
    const raceId    = typeof req.query.raceId    === 'string' ? req.query.raceId    : null;

    const where: Record<string, unknown> = {};
    if (athleteId) where.athleteIds = { has: athleteId };
    if (raceId)    where.raceId = raceId;

    // `as any` wie an den anderen Teil-Update-/Filter-Stellen im Repo (siehe
    // races.ts, events.ts): der dynamisch gebaute Filter lässt sich nicht
    // sinnvoll gegen den generierten Prisma-Typ ausdrücken.
    const runs = await prisma.pursuitRun.findMany({
      where: where as any,
      orderBy: [{ ridenAt: 'desc' }, { createdAt: 'desc' }],
    });
    res.json(runs);
  } catch (e) { next(e); }
});

router.post('/', requireAdmin, async (req, res, next) => {
  try {
    const parsed = RunSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json(parsed.error.flatten()); return; }
    const d = parsed.data;

    const run = await prisma.pursuitRun.create({
      data: {
        raceId: d.raceId ?? null,
        athleteIds: d.athleteIds,
        label: d.label,
        eventName: d.eventName ?? null,
        trackM: d.trackM,
        numRounds: d.numRounds,
        distanceM: d.distanceM ?? Math.round(d.trackM * d.numRounds),
        trackName: d.trackName?.trim() || null,
        trackSurface: d.trackSurface ?? null,
        laps: d.laps,
        totalMs: d.totalMs ?? null,
        officialTotalMs: d.officialTotalMs ?? null,
        timeSource: d.timeSource,
        complete: d.complete,
        notes: d.notes ?? null,
        kb: d.kb ?? null,
        rz: d.rz ?? null,
        gears: d.gears ?? undefined,
        circMm: d.circMm,
        planAnfahrtSec: d.planAnfahrtSec ?? null,
        planLapSec: d.planLapSec ?? null,
        planTotalSec: d.planTotalSec ?? null,
        ...(d.ridenAt ? { ridenAt: new Date(d.ridenAt) } : {}),
      },
    });
    res.status(201).json(run);
  } catch (e) { next(e); }
});

router.patch('/:id', requireAdmin, async (req, res, next) => {
  try {
    const parsed = RunPatchSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json(parsed.error.flatten()); return; }
    const d = parsed.data;

    const data: Record<string, unknown> = { editedAt: new Date() };
    for (const key of ['label', 'trackM', 'numRounds', 'timeSource', 'complete', 'circMm'] as const) {
      if (d[key] !== undefined) data[key] = d[key];
    }
    for (const key of ['eventName', 'distanceM', 'totalMs', 'officialTotalMs', 'notes', 'kb', 'rz', 'trackSurface'] as const) {
      if (d[key] !== undefined) data[key] = d[key];
    }
    if (d.trackName !== undefined) data.trackName = d.trackName?.trim() || null;
    if (d.laps    !== undefined) data.laps  = d.laps;
    // gears: null bedeutet hier "nicht anfassen", nicht "leeren" — ein
    // Mannschaftslauf verliert seine Gänge nicht durch eine Teiländerung.
    if (d.gears   !== undefined) data.gears = d.gears === null ? undefined : d.gears;
    if (d.ridenAt !== undefined) data.ridenAt = new Date(d.ridenAt);

    const run = await prisma.pursuitRun.update({ where: { id: req.params.id }, data: data as any });
    res.json(run);
  } catch (e: any) {
    if (e.code === 'P2025') res.status(404).json({ error: 'Nicht gefunden' });
    else next(e);
  }
});

router.delete('/:id', requireAdmin, async (req, res, next) => {
  try {
    await prisma.pursuitRun.delete({ where: { id: req.params.id } });
    res.status(204).send();
  } catch (e: any) {
    if (e.code === 'P2025') res.status(404).json({ error: 'Nicht gefunden' });
    else next(e);
  }
});

export default router;
