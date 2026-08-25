// Zielpfad im Repo: backend/src/routes/athletes.ts  (ERSETZT die bestehende Datei)
// Änderungen ggü. Original:
//  - Athlete.name aufgeteilt in vorname/nachname (siehe schema.prisma) —
//    AthleteSchema, Sortierung und Suche entsprechend angepasst
//  - GET /:id liefert zusätzlich `runs` (model PursuitRun). `times` bleibt im
//    Response, obwohl die Karte im Profil ersetzt wird: RaceAthlete.timeMs wird
//    nirgends geschrieben, das Feld ist also immer leer, und es stehen zu
//    lassen kostet nichts, verhindert aber einen Absturz des alten Frontends
//    im Fenster zwischen Backend- und Frontend-Commit.
//  - GET / liefert zusätzlich `runCount`: Anzahl der gefahrenen Läufe je
//    Sportler (model PursuitRun). `_count.raceLinks` bleibt unverändert im
//    Response — es wird zwar nicht mehr angezeigt, kostet aber nichts und
//    verhindert einen Bruch im Fenster zwischen Backend- und Frontend-Commit.
import { Router } from 'express';
import { z } from 'zod';
import prisma from '../prisma';
import { requireAdmin } from '../middleware/auth';

const router = Router();

// ── GET /api/athletes — Liste aller Sportler, öffentlich ─────────────────────
// `runCount` zählt die gefahrenen Läufe. PursuitRun.athleteIds ist eine
// String-Liste und KEINE Prisma-Relation, deshalb geht dort kein `_count`:
// die Läufe werden schlank geladen (nur die ID-Liste) und hier ausgezählt.
// Mannschaftsläufe zählen bei jedem beteiligten Fahrer — dieselbe Regel wie im
// Profil, wo `athleteIds: { has: … }` filtert. Die Zahl in der Liste entspricht
// damit genau der Anzahl der Zeilen im Profil.
router.get('/', async (_req, res, next) => {
  try {
    const [athletes, runs] = await Promise.all([
      prisma.athlete.findMany({
        orderBy: [{ vorname: 'asc' }, { nachname: 'asc' }],
        include: { _count: { select: { raceLinks: true } } },
      }),
      prisma.pursuitRun.findMany({ select: { athleteIds: true } }),
    ]);

    const runCounts = new Map<string, number>();
    for (const run of runs) {
      for (const id of run.athleteIds) {
        runCounts.set(id, (runCounts.get(id) ?? 0) + 1);
      }
    }

    // Bewusst for-of statt .map(): ohne generierten Prisma-Client wäre der
    // Rückrufparameter ein implizites any (noImplicitAny), und eine
    // Typannotation von Hand würde die Antwort auf die annotierten Felder
    // einengen — beides unnötig, die Schleife tut dasselbe.
    const payload = [];
    for (const a of athletes) payload.push({ ...a, runCount: runCounts.get(a.id) ?? 0 });
    res.json(payload);
  } catch (e) { next(e); }
});

// ── GET /api/athletes/:id — Profil inkl. Zeiten aus verknüpften Rennen ───────
router.get('/:id', async (req, res, next) => {
  try {
    const athlete = await prisma.athlete.findUnique({ where: { id: req.params.id } });
    if (!athlete) { res.status(404).json({ error: 'Nicht gefunden' }); return; }

    const links = await prisma.raceAthlete.findMany({
      where: { athleteId: athlete.id, timeMs: { not: null } },
      include: {
        race: {
          include: {
            category: { include: { event: true } },
            event: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    const times = links.map(l => ({
      raceId: l.raceId,
      raceName: l.race.name,
      eventName: l.race.category?.event?.name ?? l.race.event?.name ?? null,
      ak: l.race.ak ?? l.race.category?.name ?? null,
      distanceM: l.race.distanceM ?? null,
      timeMs: l.timeMs as number,
    }));

    // Mannschaftsläufe erscheinen im Profil jedes beteiligten Fahrers, deshalb
    // `has` auf der ID-Liste statt einer Relation.
    const runs = await prisma.pursuitRun.findMany({
      where: { athleteIds: { has: athlete.id } },
      orderBy: [{ ridenAt: 'desc' }, { createdAt: 'desc' }],
    });

    res.json({ ...athlete, times, runs });
  } catch (e) { next(e); }
});

const AthleteSchema = z.object({
  vorname: z.string().min(1),
  nachname: z.string().min(1),
  ak: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
  kettenblaetter: z.array(z.number().int().positive()).default([]),
  ritzel: z.array(z.number().int().positive()).default([]),
});

router.post('/', requireAdmin, async (req, res, next) => {
  try {
    const parsed = AthleteSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json(parsed.error.flatten()); return; }
    const athlete = await prisma.athlete.create({ data: parsed.data });
    res.status(201).json(athlete);
  } catch (e) { next(e); }
});

router.patch('/:id', requireAdmin, async (req, res, next) => {
  try {
    const parsed = AthleteSchema.partial().safeParse(req.body);
    if (!parsed.success) { res.status(400).json(parsed.error.flatten()); return; }
    const athlete = await prisma.athlete.update({ where: { id: req.params.id }, data: parsed.data });
    res.json(athlete);
  } catch (e: any) {
    if (e.code === 'P2025') res.status(404).json({ error: 'Nicht gefunden' });
    else next(e);
  }
});

router.delete('/:id', requireAdmin, async (req, res, next) => {
  try {
    await prisma.athlete.delete({ where: { id: req.params.id } });
    res.status(204).send();
  } catch (e: any) {
    if (e.code === 'P2025') res.status(404).json({ error: 'Nicht gefunden' });
    else next(e);
  }
});

export default router;
