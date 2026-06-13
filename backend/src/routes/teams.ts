import { Router } from 'express';
import { z } from 'zod';
import prisma from '../prisma';
import { requireAdmin } from '../middleware/auth';

const router = Router();

router.get('/', async (req, res, next) => {
  try {
    const { categoryId } = req.query;
    if (!categoryId || typeof categoryId !== 'string') {
      res.status(400).json({ error: 'categoryId erforderlich' }); return;
    }
    const teams = await prisma.team.findMany({
      where: { categoryId }, orderBy: { number: 'asc' },
    });
    res.json(teams);
  } catch (e) { next(e); }
});

const TeamSchema = z.object({
  number: z.number().int().positive(),
  name: z.string().min(1),
  club: z.string().optional().nullable(),
  rider1: z.string().optional().nullable(),
  rider2: z.string().optional().nullable(),
});

router.post('/', requireAdmin, async (req, res, next) => {
  try {
    const parsed = CreateTeamSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json(parsed.error.flatten()); return; }
    const team = await prisma.team.create({ data: parsed.data });
    res.status(201).json(team);
  } catch (e: any) {
    if (e.code === 'P2002') res.status(409).json({ error: 'Startnummer bereits vergeben' });
    else next(e);
  }
});

const CreateTeamSchema = TeamSchema.extend({ categoryId: z.string() });

const BatchSchema = z.object({
  categoryId: z.string(),
  teams: z.array(TeamSchema).min(1),
  replace: z.boolean().default(false),
});

router.post('/batch', requireAdmin, async (req, res, next) => {
  try {
    const parsed = BatchSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json(parsed.error.flatten()); return; }
    const { categoryId, teams, replace } = parsed.data;
    const result = await prisma.$transaction(async (tx) => {
      if (replace) await tx.team.deleteMany({ where: { categoryId } });
      await tx.team.createMany({
        data: teams.map(t => ({ ...t, categoryId })),
        skipDuplicates: !replace,
      });
      return tx.team.findMany({ where: { categoryId }, orderBy: { number: 'asc' } });
    });
    res.status(201).json(result);
  } catch (e) { next(e); }
});

// PATCH /api/teams/:id/favorite
router.patch('/:id/favorite', requireAdmin, async (req, res, next) => {
  try {
    const team = await prisma.team.findUnique({ where: { id: req.params.id }, select: { isFavorite: true } });
    if (!team) { res.status(404).json({ error: 'Nicht gefunden' }); return; }
    const updated = await prisma.team.update({
      where: { id: req.params.id },
      data: { isFavorite: !team.isFavorite },
    });
    res.json(updated);
  } catch (e) { next(e); }
});

// PATCH /api/teams/:id
router.patch('/:id', requireAdmin, async (req, res, next) => {
  try {
    const parsed = TeamSchema.partial().safeParse(req.body);
    if (!parsed.success) { res.status(400).json(parsed.error.flatten()); return; }
    const team = await prisma.team.update({ where: { id: req.params.id }, data: parsed.data });
    res.json(team);
  } catch (e: any) {
    if (e.code === 'P2025') res.status(404).json({ error: 'Nicht gefunden' });
    else next(e);
  }
});

// DELETE /api/teams/:id
// Löscht zuerst alle abhängigen Datensätze, dann den Fahrer selbst.
// Nötig weil die FK-Relationen im Schema kein onDelete:Cascade haben.
router.delete('/:id', requireAdmin, async (req, res, next) => {
  try {
    const teamId = req.params.id;
    await prisma.$transaction(async (tx) => {
      // Ergebnisse & Ereignisse löschen
      await tx.sprintResult.deleteMany({ where: { teamId } });
      await tx.lapEvent.deleteMany({ where: { teamId } });
      await tx.omniumScore.deleteMany({ where: { teamId } });
      await tx.timeResult.deleteMany({ where: { teamId } });
      await tx.raceFlag.deleteMany({ where: { teamId } });

      // PursuitRound: Felder nullen statt die Runde zu löschen
      await tx.pursuitRound.updateMany({ where: { team1Id: teamId },  data: { team1Id: null, time1Ms: null } });
      await tx.pursuitRound.updateMany({ where: { team2Id: teamId },  data: { team2Id: null, time2Ms: null } });
      await tx.pursuitRound.updateMany({ where: { winnerId: teamId }, data: { winnerId: null } });

      // Fahrer löschen
      await tx.team.delete({ where: { id: teamId } });
    });
    res.status(204).send();
  } catch (e: any) {
    if (e.code === 'P2025') res.status(404).json({ error: 'Nicht gefunden' });
    else next(e);
  }
});

export default router;
