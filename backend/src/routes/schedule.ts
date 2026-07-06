import { Router } from 'express';
import { z } from 'zod';
import prisma from '../prisma';
import { requireAdmin } from '../middleware/auth';
import { analyzeZeitplanPdf, autoMatch, loadScheduleWithLinks, ScheduleEntryInputSchema } from '../lib/scheduleImport';

const router = Router();

// ─── Zeitplan-Import ────────────────────────────────────────────────────────

// POST /api/events/:id/schedule/analyze — Zeitplan-PDF analysieren, noch nicht speichern
router.post('/events/:id/schedule/analyze', requireAdmin, async (req, res, next) => {
  try {
    const { pdfBase64 } = req.body;
    if (!pdfBase64) { res.status(400).json({ error: 'pdfBase64 fehlt' }); return; }
    const entries = await analyzeZeitplanPdf(pdfBase64);
    res.json({ entries });
  } catch (e) { next(e); }
});

// POST /api/events/:id/schedule — bestätigte Liste speichern (ersetzt bestehende Einträge komplett)
router.post('/events/:id/schedule', requireAdmin, async (req, res, next) => {
  try {
    const parsed = z.object({ entries: z.array(ScheduleEntryInputSchema) }).safeParse(req.body);
    if (!parsed.success) { res.status(400).json(parsed.error.flatten()); return; }
    const eventId = req.params.id;

    await prisma.$transaction(async (tx) => {
      await tx.scheduleEntry.deleteMany({ where: { eventId } });
      await tx.scheduleEntry.createMany({
        data: parsed.data.entries.map((e, i) => ({
          eventId,
          day: e.day,
          dayLabel: e.dayLabel ?? null,
          time: e.time,
          ak: e.ak,
          disciplineLabel: e.disciplineLabel,
          phase: e.phase ?? null,
          type: e.type,
          massStart: e.massStart,
          order: i,
        })),
      });
    });

    await autoMatch(eventId);
    res.status(201).json(await loadScheduleWithLinks(eventId));
  } catch (e) { next(e); }
});

// GET /api/events/:id/schedule — Liste inkl. verknüpftem Kommuniqué
router.get('/events/:id/schedule', async (req, res, next) => {
  try {
    res.json(await loadScheduleWithLinks(req.params.id));
  } catch (e) { next(e); }
});

// POST /api/events/:id/schedule/rematch — Matching manuell erneut anstoßen
// (z.B. nachdem neue Kommuniqués eingetroffen sind)
router.post('/events/:id/schedule/rematch', requireAdmin, async (req, res, next) => {
  try {
    await autoMatch(req.params.id);
    res.json(await loadScheduleWithLinks(req.params.id));
  } catch (e) { next(e); }
});

// DELETE /api/events/:id/schedule/days/:day — einen kompletten Tag löschen
// (Aufräum-Werkzeug, z.B. für versehentlich doppelt angelegte Tage). Nummern
// werden bewusst NICHT neu vergeben — andere Tage behalten ihre Nummer, auch
// wenn dadurch eine Lücke entsteht, damit die chronologische Reihenfolge nie
// durch eine Löschung durcheinandergerät.
router.delete('/events/:id/schedule/days/:day', requireAdmin, async (req, res, next) => {
  try {
    const day = Number(req.params.day);
    if (!Number.isInteger(day)) { res.status(400).json({ error: 'Ungültige Tagesnummer' }); return; }
    await prisma.scheduleEntry.deleteMany({ where: { eventId: req.params.id, day } });
    res.json(await loadScheduleWithLinks(req.params.id));
  } catch (e) { next(e); }
});

// PATCH /api/schedule-entries/:id — manuelle Korrektur (z.B. Kommuniqué per Hand verknüpfen/lösen)
const PatchEntrySchema = z.object({
  linkedDocumentId: z.string().nullable().optional(),
  linkedResultDocumentId: z.string().nullable().optional(),
});

router.patch('/schedule-entries/:id', requireAdmin, async (req, res, next) => {
  try {
    const parsed = PatchEntrySchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json(parsed.error.flatten()); return; }
    const { linkedDocumentId, linkedResultDocumentId } = parsed.data;
    if (linkedDocumentId === undefined && linkedResultDocumentId === undefined) {
      res.json(await prisma.scheduleEntry.findUnique({ where: { id: req.params.id } }));
      return;
    }
    const data: Record<string, string | null> = {};
    if (linkedDocumentId !== undefined) data.linkedDocumentId = linkedDocumentId;
    if (linkedResultDocumentId !== undefined) data.linkedResultDocumentId = linkedResultDocumentId;
    const entry = await prisma.scheduleEntry.update({
      where: { id: req.params.id },
      data: data as any,
    });
    res.json(entry);
  } catch (e) { next(e); }
});

// ─── Aktueller Stand ────────────────────────────────────────────────────────

router.get('/events/:id/status', async (req, res, next) => {
  try {
    const status = await prisma.eventStatus.findUnique({
      where: { eventId: req.params.id },
      include: { scheduleEntry: true },
    });
    res.json(status);
  } catch (e) { next(e); }
});

const StatusSchema = z.object({
  scheduleEntryId: z.string(),
  statusKey: z.enum(['STARTING', 'RUNNING', 'FINISHED']),
  roundsLeft: z.number().int().min(0).nullable().optional(),
});

router.put('/events/:id/status', requireAdmin, async (req, res, next) => {
  try {
    const parsed = StatusSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json(parsed.error.flatten()); return; }
    const { scheduleEntryId, statusKey, roundsLeft } = parsed.data;

    const entry = await prisma.scheduleEntry.findUnique({ where: { id: scheduleEntryId } });
    if (!entry || entry.eventId !== req.params.id) {
      res.status(404).json({ error: 'Zeitplan-Eintrag nicht gefunden' });
      return;
    }

    const [h, m] = entry.time.split(':').map(Number);
    const plannedMin = h * 60 + m;
    const now = new Date();
    const offsetMinutes = (now.getHours() * 60 + now.getMinutes()) - plannedMin;

    const status = await prisma.eventStatus.upsert({
      where: { eventId: req.params.id },
      create: {
        eventId: req.params.id, scheduleEntryId, statusKey,
        roundsLeft: roundsLeft ?? null, offsetMinutes,
      },
      update: { scheduleEntryId, statusKey, roundsLeft: roundsLeft ?? null, offsetMinutes },
      include: { scheduleEntry: true },
    });
    res.json(status);
  } catch (e) { next(e); }
});

export default router;
