import { Router } from 'express';
import { z } from 'zod';
import prisma from '../prisma';
import { requireAdmin } from '../middleware/auth';

const router = Router();

// GET /api/categories/:id
router.get('/:id', async (req, res, next) => {
  try {
    const category = await prisma.category.findUnique({
      where: { id: req.params.id },
      include: {
        event: { select: { id: true, name: true, date: true } },
        teams: { orderBy: { number: 'asc' } },
        races: { orderBy: { order: 'asc' } },
      },
    });
    if (!category) { res.status(404).json({ error: 'Nicht gefunden' }); return; }
    res.json(category);
  } catch (e) { next(e); }
});

// POST /api/categories
const CreateCategorySchema = z.object({
  eventId: z.string(),
  name: z.string().min(1, 'Name ist erforderlich'),
  format: z.enum(['INDIVIDUAL', 'TEAM_PAIRS']).default('INDIVIDUAL'),
});

router.post('/', requireAdmin, async (req, res, next) => {
  try {
    const parsed = CreateCategorySchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json(parsed.error.flatten()); return; }
    const category = await prisma.category.create({ data: parsed.data });
    res.status(201).json(category);
  } catch (e) { next(e); }
});

// PATCH /api/categories/:id
const UpdateCategorySchema = z.object({
  name: z.string().min(1).optional(),
  format: z.enum(['INDIVIDUAL', 'TEAM_PAIRS']).optional(),
});

router.patch('/:id', requireAdmin, async (req, res, next) => {
  try {
    const parsed = UpdateCategorySchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json(parsed.error.flatten()); return; }
    const category = await prisma.category.update({
      where: { id: req.params.id },
      data: parsed.data,
    });
    res.json(category);
  } catch (e) { next(e); }
});

// DELETE /api/categories/:id
router.delete('/:id', requireAdmin, async (req, res, next) => {
  try {
    await prisma.category.delete({ where: { id: req.params.id } });
    res.status(204).send();
  } catch (e) { next(e); }
});

export default router;
