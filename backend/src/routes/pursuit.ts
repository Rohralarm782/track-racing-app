import { Router } from 'express';
import { z } from 'zod';
import prisma from '../prisma';
import { requireAdmin } from '../middleware/auth';

const router = Router();

const PlanSchema = z.object({
  name:        z.string().min(1),
  trackLength: z.number().positive().default(250),
  totalLaps:   z.number().int().positive(),
  anfahrtSec:  z.number().positive(),
  lapTimeSec:  z.number().positive(),
});

// Öffentlich lesbar – kein Admin nötig
router.get('/', async (_req, res, next) => {
  try {
    const plans = await prisma.pursuitPlan.findMany({ orderBy: { createdAt: 'desc' } });
    res.json(plans);
  } catch (e) { next(e); }
});

router.post('/', requireAdmin, async (req, res, next) => {
  try {
    const parsed = PlanSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json(parsed.error.flatten()); return; }
    const plan = await prisma.pursuitPlan.create({ data: parsed.data });
    res.status(201).json(plan);
  } catch (e) { next(e); }
});

router.delete('/:id', requireAdmin, async (req, res, next) => {
  try {
    await prisma.pursuitPlan.delete({ where: { id: req.params.id } });
    res.status(204).send();
  } catch (e) { next(e); }
});

export default router;
