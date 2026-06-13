import { Router } from 'express';
import prisma from '../prisma';
import { requireAdmin } from '../middleware/auth';

export const sprintsRouter = Router();
export const lapsRouter    = Router();

// PUT /api/sprints/:id — Sprint-Ergebnisse ersetzen (zum Bearbeiten)
sprintsRouter.put('/:id', requireAdmin, async (req, res, next) => {
  try {
    const { isFinale, results } = req.body;
    if (!Array.isArray(results)) { res.status(400).json({ error: 'results required' }); return; }

    await prisma.$transaction(async (tx) => {
      await tx.sprint.update({ where: { id: req.params.id }, data: { isFinale: Boolean(isFinale) } });
      await tx.sprintResult.deleteMany({ where: { sprintId: req.params.id } });
      if (results.length > 0) {
        await tx.sprintResult.createMany({
          data: results.map((r: { teamId: string; position: number }) => ({
            sprintId: req.params.id, teamId: r.teamId, position: r.position,
          })),
        });
      }
    });

    const sprint = await prisma.sprint.findUnique({
      where: { id: req.params.id },
      include: { results: { include: { team: true }, orderBy: { position: 'asc' } } },
    });
    res.json(sprint);
  } catch (e) { next(e); }
});

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
});import { Router } from 'express';
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
