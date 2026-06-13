import { Router } from 'express';
import { z } from 'zod';
import prisma from '../prisma';
import { requireAdmin } from '../middleware/auth';

const router = Router();

// GET /api/teams?categoryId=:id
router.get('/', async (req, res, next) => {
  try {
    const { categoryId } = req.query;
    if (!categoryId || typeof categoryId !== 'string') {
      res.status(400).json({ error: 'categoryId erforderlich' });
      return;
    }
    const teams = await prisma.team.findMany({
      where: { categoryId },
      orderBy: { number: 'asc' },
    });
    res.json(teams);
  } catch (e) { next(e); }
});

const TeamSchema = z.object({
  number: z.number().int().positive(),
  name: z.string().min(1),
  rider1: z.string().optional().nullable(),
  rider2: z.string().optional().nullable(),
});

// POST /api/teams (einzelnes Team)
const CreateTeamSchema = TeamSchema.extend({ categoryId: z.string() });

router.post('/', requireAdmin, async (req, res, next) => {
  try {
    const parsed = CreateTeamSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json(parsed.error.flatten()); return; }
    const team = await prisma.team.create({ data: parsed.data });
    res.status(201).json(team);
  } catch (e: any) {
    if (e.code === 'P2002') {
      res.status(409).json({ error: 'Startnummer bereits vergeben' });
    } else {
      next(e);
    }
  }
});

// POST /api/teams/batch (Bulk-Import)
const BatchSchema = z.object({
  categoryId: z.string(),
  teams: z.array(TeamSchema).min(1),
  replace: z.boolean().default(false), // true = vorhandene Teams löschen
});

router.post('/batch', requireAdmin, async (req, res, next) => {
  try {
    const parsed = BatchSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json(parsed.error.flatten()); return; }

    const { categoryId, teams, replace } = parsed.data;

    const result = await prisma.$transaction(async (tx) => {
      if (replace) {
        await tx.team.deleteMany({ where: { categoryId } });
      }
      await tx.team.createMany({
        data: teams.map(t => ({ ...t, categoryId })),
        skipDuplicates: !replace,
      });
      return tx.team.findMany({ where: { categoryId }, orderBy: { number: 'asc' } });
    });

    res.status(201).json(result);
  } catch (e) { next(e); }
});

// PATCH /api/teams/:id
router.patch('/:id', requireAdmin, async (req, res, next) => {
  try {
    const parsed = TeamSchema.partial().safeParse(req.body);
    if (!parsed.success) { res.status(400).json(parsed.error.flatten()); return; }
    const team = await prisma.team.update({
      where: { id: req.params.id },
      data: parsed.data,
    });
    res.json(team);
  } catch (e: any) {
    if (e.code === 'P2025') {
      res.status(404).json({ error: 'Nicht gefunden' });
    } else {
      next(e);
    }
  }
});

// DELETE /api/teams/:id
router.delete('/:id', requireAdmin, async (req, res, next) => {
  try {
    await prisma.team.delete({ where: { id: req.params.id } });
    res.status(204).send();
  } catch (e) { next(e); }
});

export default router;
