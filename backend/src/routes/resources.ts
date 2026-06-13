import { Router } from 'express';
import prisma from '../prisma';
import { requireAdmin } from '../middleware/auth';

export const sprintsRouter = Router();
export const lapsRouter    = Router();

// DELETE /api/sprints/:id
sprintsRouter.delete('/:id', requireAdmin, async (req, res, next) => {
  try {
    await prisma.sprint.delete({ where: { id: req.params.id } });
    res.status(204).send();
  } catch (e) { next(e); }
});

// DELETE /api/laps/:id
lapsRouter.delete('/:id', requireAdmin, async (req, res, next) => {
  try {
    await prisma.lapEvent.delete({ where: { id: req.params.id } });
    res.status(204).send();
  } catch (e) { next(e); }
});
