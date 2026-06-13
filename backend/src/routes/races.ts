import { Router } from 'express';
import { z } from 'zod';
import prisma from '../prisma';
import { requireAdmin } from '../middleware/auth';
import { computePunktefahren } from '../lib/scoring';

const router = Router();

// ─── GET /api/races/:id ───────────────────────────────────────────────────────
router.get('/:id', async (req, res, next) => {
  try {
    const race = await prisma.race.findUnique({
      where: { id: req.params.id },
      include: {
        category: {
          include: {
            teams: { orderBy: { number: 'asc' } },
            event: { select: { id: true, name: true } },
          },
        },
        sprints: {
          orderBy: { number: 'asc' },
          include: {
            results: {
              orderBy: { position: 'asc' },
              include: { team: true },
            },
          },
        },
        lapEvents: {
          orderBy: { createdAt: 'asc' },
          include: { team: true },
        },
        omniumScores: { include: { team: true } },
      },
    });
    if (!race) { res.status(404).json({ error: 'Nicht gefunden' }); return; }

    const scoreboard = race.type === 'PUNKTEFAHREN'
      ? computePunktefahren(race.category.teams, race.sprints, race.lapEvents, race.omniumScores)
      : null;

    res.json({ ...race, scoreboard });
  } catch (e) { next(e); }
});

// ─── POST /api/races ──────────────────────────────────────────────────────────
const CreateRaceSchema = z.object({
  categoryId: z.string(),
  type: z.enum(["PUNKTEFAHREN", "TEMPORUNDEN", "VERFOLGUNGSRENNEN"]),
  format: z.enum(["INDIVIDUAL", "TEAM_PAIRS"]).optional(),
  name: z.string().min(1),
  order: z.number().int().default(0),
});

router.post('/', requireAdmin, async (req, res, next) => {
  try {
    const parsed = CreateRaceSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json(parsed.error.flatten()); return; }
    const race = await prisma.race.create({ data: parsed.data });
    res.status(201).json(race);
  } catch (e) { next(e); }
});

// ─── PATCH /api/races/:id ─────────────────────────────────────────────────────
router.patch('/:id', requireAdmin, async (req, res, next) => {
  try {
    const { status, finaleActive, name } = req.body;
    const data: Record<string, unknown> = {};
    if (status !== undefined) data.status = status;
    if (finaleActive !== undefined) data.finaleActive = finaleActive;
    if (name !== undefined) data.name = name;
    const race = await prisma.race.update({ where: { id: req.params.id }, data: data as any });
    res.json(race);
  } catch (e) { next(e); }
});

// ─── DELETE /api/races/:id ────────────────────────────────────────────────────
router.delete('/:id', requireAdmin, async (req, res, next) => {
  try {
    await prisma.race.delete({ where: { id: req.params.id } });
    res.status(204).send();
  } catch (e) { next(e); }
});

// ─── POST /api/races/:id/omnium ───────────────────────────────────────────────
const OmniumBatchSchema = z.object({
  scores: z.array(z.object({ teamId: z.string(), points: z.number().int() })),
});

router.post('/:id/omnium', requireAdmin, async (req, res, next) => {
  try {
    const parsed = OmniumBatchSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json(parsed.error.flatten()); return; }
    const raceId = req.params.id;

    await prisma.$transaction(
      parsed.data.scores.map(s =>
        prisma.omniumScore.upsert({
          where: { raceId_teamId: { raceId, teamId: s.teamId } },
          create: { raceId, teamId: s.teamId, points: s.points },
          update: { points: s.points },
        })
      )
    );
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ─── POST /api/races/:id/sprints ──────────────────────────────────────────────
const CreateSprintSchema = z.object({
  isFinale: z.boolean().default(false),
  results: z.array(z.object({
    teamId: z.string(),
    position: z.number().int().min(1),
  })).min(1),
});

router.post('/:id/sprints', requireAdmin, async (req, res, next) => {
  try {
    const parsed = CreateSprintSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json(parsed.error.flatten()); return; }
    const raceId = req.params.id;

    const lastSprint = await prisma.sprint.findFirst({
      where: { raceId }, orderBy: { number: 'desc' },
    });
    const number = (lastSprint?.number ?? 0) + 1;

    const sprint = await prisma.$transaction(async (tx) => {
      const s = await tx.sprint.create({
        data: { raceId, number, isFinale: parsed.data.isFinale },
      });
      await tx.sprintResult.createMany({
        data: parsed.data.results.map(r => ({
          sprintId: s.id, teamId: r.teamId, position: r.position,
        })),
      });
      return tx.sprint.findUnique({
        where: { id: s.id },
        include: { results: { include: { team: true }, orderBy: { position: 'asc' } } },
      });
    });

    res.status(201).json(sprint);
  } catch (e) { next(e); }
});

// ─── POST /api/races/:id/laps ─────────────────────────────────────────────────
const CreateLapSchema = z.object({
  teamId: z.string(),
  delta: z.number().int().refine(v => v === 1 || v === -1),
  note: z.string().optional(),
});

router.post('/:id/laps', requireAdmin, async (req, res, next) => {
  try {
    const parsed = CreateLapSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json(parsed.error.flatten()); return; }
    const lap = await prisma.lapEvent.create({
      data: { raceId: req.params.id, ...parsed.data },
      include: { team: true },
    });
    res.status(201).json(lap);
  } catch (e) { next(e); }
});

export default router;
