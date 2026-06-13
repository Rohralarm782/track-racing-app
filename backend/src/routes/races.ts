import { Router } from 'express';
import { z } from 'zod';
import Anthropic from '@anthropic-ai/sdk';
import prisma from '../prisma';
import { requireAdmin } from '../middleware/auth';
import { computePunktefahren } from '../lib/scoring';

const router = Router();
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

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
          include: { results: { orderBy: { position: 'asc' }, include: { team: true } } },
        },
        lapEvents: { orderBy: { createdAt: 'asc' }, include: { team: true } },
        omniumScores: { include: { team: true } },
        flags: { include: { team: true } },
      },
    });
    if (!race) { res.status(404).json({ error: 'Nicht gefunden' }); return; }

    const scoreboard = race.type === 'PUNKTEFAHREN'
      ? computePunktefahren(race.category.teams, race.sprints, race.lapEvents, race.omniumScores, race.flags)
      : null;

    res.json({ ...race, scoreboard });
  } catch (e) { next(e); }
});

const CreateRaceSchema = z.object({
  categoryId: z.string(),
  type: z.enum(['PUNKTEFAHREN', 'TEMPORUNDEN', 'VERFOLGUNGSRENNEN']),
  format: z.enum(['INDIVIDUAL', 'TEAM_PAIRS']).optional(),
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

router.delete('/:id', requireAdmin, async (req, res, next) => {
  try {
    await prisma.race.delete({ where: { id: req.params.id } });
    res.status(204).send();
  } catch (e) { next(e); }
});

// POST /api/races/:id/omnium
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

// POST /api/races/:id/omnium-pdf — Omnium-Vorpunkte per PDF importieren
router.post('/:id/omnium-pdf', requireAdmin, async (req, res, next) => {
  try {
    const { pdfBase64 } = req.body;
    if (!pdfBase64) { res.status(400).json({ error: 'pdfBase64 fehlt' }); return; }

    const race = await prisma.race.findUnique({
      where: { id: req.params.id },
      include: { category: { include: { teams: true } } },
    });
    if (!race) { res.status(404).json({ error: 'Nicht gefunden' }); return; }

    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4000,
      messages: [{
        role: 'user',
        content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } } as any,
          {
            type: 'text',
            text: `Dies ist eine Omnium-Zwischenwertung oder Ergebnisliste.
Extrahiere Startnummern und Gesamtpunkte. Gib NUR JSON zurück:
{"scores":[{"number":173,"points":106}]}
- number: Startnummer/BIB als Ganzzahl
- points: Gesamtpunktzahl (letzte Zahlenspalte / "Gesamt")
- Nur JSON, sonst nichts`,
          },
        ],
      }],
    });

    const text = (message.content.find((c: any) => c.type === 'text') as any)?.text ?? '';
    const clean = text.replace(/```json\n?|```/g, '').trim();
    const { scores } = JSON.parse(clean);

    const teamMap = new Map(race.category.teams.map(t => [t.number, t.id]));
    const raceId = req.params.id;
    const matched = scores.filter((s: any) => teamMap.has(s.number));

    await prisma.$transaction(
      matched.map((s: any) =>
        prisma.omniumScore.upsert({
          where: { raceId_teamId: { raceId, teamId: teamMap.get(s.number)! } },
          create: { raceId, teamId: teamMap.get(s.number)!, points: s.points },
          update: { points: s.points },
        })
      )
    );

    res.json({ imported: matched.length, total: scores.length });
  } catch (e) { next(e); }
});

// POST /api/races/:id/sprints
const CreateSprintSchema = z.object({
  isFinale: z.boolean().default(false),
  results: z.array(z.object({ teamId: z.string(), position: z.number().int().min(1) })).min(1),
});

router.post('/:id/sprints', requireAdmin, async (req, res, next) => {
  try {
    const parsed = CreateSprintSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json(parsed.error.flatten()); return; }
    const raceId = req.params.id;
    const lastSprint = await prisma.sprint.findFirst({ where: { raceId }, orderBy: { number: 'desc' } });
    const number = (lastSprint?.number ?? 0) + 1;
    const sprint = await prisma.$transaction(async (tx) => {
      const s = await tx.sprint.create({ data: { raceId, number, isFinale: parsed.data.isFinale } });
      await tx.sprintResult.createMany({
        data: parsed.data.results.map(r => ({ sprintId: s.id, teamId: r.teamId, position: r.position })),
      });
      return tx.sprint.findUnique({
        where: { id: s.id },
        include: { results: { include: { team: true }, orderBy: { position: 'asc' } } },
      });
    });
    res.status(201).json(sprint);
  } catch (e) { next(e); }
});

// POST /api/races/:id/laps
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

// POST /api/races/:id/flags — DSQ oder Verwarnung setzen
router.post('/:id/flags', requireAdmin, async (req, res, next) => {
  try {
    const { teamId, type } = req.body;
    if (!['DSQ', 'WARNING'].includes(type)) { res.status(400).json({ error: 'Ungültiger Typ' }); return; }
    await prisma.raceFlag.upsert({
      where: { raceId_teamId_type: { raceId: req.params.id, teamId, type } },
      create: { raceId: req.params.id, teamId, type },
      update: {},
    });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

export default router;
