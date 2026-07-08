// Zielpfad im Repo: backend/src/routes/athletes.ts  (NEUE DATEI)
import { Router } from 'express';
import { z } from 'zod';
import prisma from '../prisma';
import { requireAdmin } from '../middleware/auth';

const router = Router();

// ── GET /api/athletes — Liste aller Sportler, öffentlich ─────────────────────
router.get('/', async (_req, res, next) => {
  try {
    const athletes = await prisma.athlete.findMany({
      orderBy: { name: 'asc' },
      include: { _count: { select: { raceLinks: true } } },
    });
    res.json(athletes);
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

    res.json({ ...athlete, times });
  } catch (e) { next(e); }
});

const AthleteSchema = z.object({
  name: z.string().min(1),
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
