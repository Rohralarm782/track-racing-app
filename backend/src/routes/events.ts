import { Router } from 'express';
import { z } from 'zod';
import prisma from '../prisma';
import { requireAdmin } from '../middleware/auth';

const router = Router();

router.get('/', async (_req, res, next) => {
  try {
    const events = await prisma.event.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        categories: {
          include: { _count: { select: { teams: true, races: true } } },
          orderBy: { name: 'asc' },
        },
      },
    });
    res.json(events);
  } catch (e) { next(e); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const event = await prisma.event.findUnique({
      where: { id: req.params.id },
      include: {
        categories: {
          include: {
            _count: { select: { teams: true } },
            races: {
              select: { id: true, name: true, type: true, status: true, order: true },
              orderBy: { order: 'asc' },
            },
          },
          orderBy: { name: 'asc' },
        },
      },
    });
    if (!event) { res.status(404).json({ error: 'Nicht gefunden' }); return; }
    res.json(event);
  } catch (e) { next(e); }
});

const CreateEventSchema = z.object({
  name: z.string().min(1, 'Name ist erforderlich'),
  date: z.string().datetime().optional(),
});

router.post('/', requireAdmin, async (req, res, next) => {
  try {
    const parsed = CreateEventSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json(parsed.error.flatten()); return; }
    const event = await prisma.event.create({
      data: {
        name: parsed.data.name,
        ...(parsed.data.date && { date: new Date(parsed.data.date) }),
      },
    });
    res.status(201).json(event);
  } catch (e) { next(e); }
});

const UpdateEventSchema = CreateEventSchema.partial();

router.patch('/:id', requireAdmin, async (req, res, next) => {
  try {
    const parsed = UpdateEventSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json(parsed.error.flatten()); return; }
    const event = await prisma.event.update({
      where: { id: req.params.id },
      data: {
        ...(parsed.data.name && { name: parsed.data.name }),
        ...(parsed.data.date && { date: new Date(parsed.data.date) }),
      },
    });
    res.json(event);
  } catch (e) { next(e); }
});

router.delete('/:id', requireAdmin, async (req, res, next) => {
  try {
    await prisma.event.delete({ where: { id: req.params.id } });
    res.status(204).send();
  } catch (e) { next(e); }
});

export default router;
