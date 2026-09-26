// Neue Datei — CRUD für die manuelle MEV-Startnummern-Liste je Veranstaltung
// (Modell MevStartNumber, siehe schema.prisma). Ergänzt die automatische
// MEV-Erkennung aus mevDetect.ts (loadMevRoster) für Kommuniqués ohne
// LV-Spalte; siehe dortige Kommentare für den vollen Zusammenhang.
import { Router } from 'express';
import { z } from 'zod';
import prisma from '../prisma';
import { requireAdmin } from '../middleware/auth';
import { MEV_STARTNUMBER_AKS } from '../lib/mevDetect';

const router = Router();

// GET /api/events/:eventId/mev-startnumbers — alle manuell hinterlegten
// Startnummern einer Veranstaltung, über alle Altersklassen hinweg (das
// Frontend filtert selbst nach der aktiven AK-Reiterleiste).
router.get('/events/:eventId/mev-startnumbers', async (req, res, next) => {
  try {
    const rows = await prisma.mevStartNumber.findMany({
      where: { eventId: req.params.eventId },
      orderBy: [{ ak: 'asc' }, { startNo: 'asc' }],
    });
    res.json(rows);
  } catch (e) { next(e); }
});

const CreateSchema = z.object({
  ak: z.enum(MEV_STARTNUMBER_AKS),
  startNo: z.number().int().min(1),
  label: z.string().max(100).optional(),
});

// POST /api/events/:eventId/mev-startnumbers — eine Startnummer für eine AK hinzufügen
router.post('/events/:eventId/mev-startnumbers', requireAdmin, async (req, res, next) => {
  try {
    const parsed = CreateSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json(parsed.error.flatten()); return; }
    const row = await prisma.mevStartNumber.create({
      data: {
        eventId: req.params.eventId,
        ak: parsed.data.ak,
        startNo: parsed.data.startNo,
        label: parsed.data.label ?? null,
      },
    });
    res.status(201).json(row);
  } catch (e: any) {
    // Unique-Verletzung (eventId, ak, startNo) — dieselbe Startnummer wurde
    // für diese AK schon einmal hinterlegt.
    if (e.code === 'P2002') {
      res.status(409).json({ error: 'Diese Startnummer ist für diese Altersklasse bereits hinterlegt.' });
      return;
    }
    next(e);
  }
});

// DELETE /api/mev-startnumbers/:id — eine Startnummer entfernen
router.delete('/mev-startnumbers/:id', requireAdmin, async (req, res, next) => {
  try {
    await prisma.mevStartNumber.delete({ where: { id: req.params.id } });
    res.status(204).send();
  } catch (e) { next(e); }
});

export default router;
