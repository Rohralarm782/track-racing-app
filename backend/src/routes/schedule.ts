import { Router } from 'express';
import { z } from 'zod';
import prisma from '../prisma';
import { requireAdmin } from '../middleware/auth';
import { analyzeZeitplanPdf, autoMatch, loadScheduleWithLinks, ScheduleEntryInputSchema } from '../lib/scheduleImport';
import { estimateMinutes, recalibrateFromStatusUpdate, usedFallback } from '../lib/durationEstimate';
import { getSettings } from '../lib/settings';

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
          plannedDurationMin: e.plannedDurationMin ?? null,
          order: i,
        })),
      });
    });

    await autoMatch(eventId);
    res.status(201).json(await withEstimates(await loadScheduleWithLinks(eventId)));
  } catch (e) { next(e); }
});

// Reichert eine geladene Zeitplan-Liste um die geschätzte Dauer pro Rennen an
// (siehe durationEstimate.ts). Separat von loadScheduleWithLinks gehalten,
// da nicht jeder Aufrufer (z.B. autoMatch) das braucht. Lädt die Einstellungen
// (Formel-Werte) EINMAL für die ganze Liste statt pro Eintrag neu.
async function withEstimates<T extends {
  ak: string; disciplineLabel: string; massStart: boolean; type: string; phase: string | null;
  manualUnitCount: number | null;
  plannedDurationMin: number | null;
  linkedDocument: { roundCount: number | null; heatCount: number | null } | null;
}>(
  entries: T[],
): Promise<Array<T & { estimatedMinutes: number | null; estimateIsFallback: boolean }>> {
  const settings = await getSettings();
  return Promise.all(entries.map(async e => ({
    ...e,
    estimatedMinutes: await estimateMinutes(e, e.linkedDocument, settings),
    estimateIsFallback: usedFallback(e, e.linkedDocument),
  })));
}

// GET /api/events/:id/schedule — Liste inkl. verknüpftem Kommuniqué
router.get('/events/:id/schedule', async (req, res, next) => {
  try {
    const entries = await loadScheduleWithLinks(req.params.id);
    res.json(await withEstimates(entries));
  } catch (e) { next(e); }
});

// POST /api/events/:id/schedule/rematch — Matching manuell erneut anstoßen
// (z.B. nachdem neue Kommuniqués eingetroffen sind)
router.post('/events/:id/schedule/rematch', requireAdmin, async (req, res, next) => {
  try {
    await autoMatch(req.params.id);
    res.json(await withEstimates(await loadScheduleWithLinks(req.params.id)));
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
    res.json(await withEstimates(await loadScheduleWithLinks(req.params.id)));
  } catch (e) { next(e); }
});

// PATCH /api/schedule-entries/:id — manuelle Korrektur (Kommuniqué per Hand
// verknüpfen/lösen, oder Runden-/Laufzahl von Hand eintragen)
const PatchEntrySchema = z.object({
  linkedDocumentId: z.string().nullable().optional(),
  linkedResultDocumentId: z.string().nullable().optional(),
  manualUnitCount: z.number().int().min(0).nullable().optional(),
});

router.patch('/schedule-entries/:id', requireAdmin, async (req, res, next) => {
  try {
    const parsed = PatchEntrySchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json(parsed.error.flatten()); return; }
    const { linkedDocumentId, linkedResultDocumentId, manualUnitCount } = parsed.data;
    if (linkedDocumentId === undefined && linkedResultDocumentId === undefined && manualUnitCount === undefined) {
      res.json(await prisma.scheduleEntry.findUnique({ where: { id: req.params.id } }));
      return;
    }
    const data: Record<string, string | number | null> = {};
    if (linkedDocumentId !== undefined) data.linkedDocumentId = linkedDocumentId;
    if (linkedResultDocumentId !== undefined) data.linkedResultDocumentId = linkedResultDocumentId;
    if (manualUnitCount !== undefined) data.manualUnitCount = manualUnitCount;
    const entry = await prisma.scheduleEntry.update({
      where: { id: req.params.id },
      data: data as any,
    });
    res.json(entry);
  } catch (e) { next(e); }
});

// ─── Aktueller Stand ────────────────────────────────────────────────────────
// scheduleEntry.linkedDocument wird mit eingebunden, damit das Frontend bei
// Einzelstart-Disziplinen "Lauf X von Y" anzeigen kann (Y = heatCount aus der
// Startliste) — ohne das würde status.scheduleEntry.linkedDocument undefined
// bleiben, obwohl der TS-Typ ScheduleEntry es eigentlich erwartet.
const STATUS_ENTRY_INCLUDE = {
  scheduleEntry: {
    include: {
      linkedDocument: {
        select: {
          id: true, fileName: true, mevNames: true, mevRiders: true,
          heatCount: true, roundCount: true, starterCount: true, mevAnalyzedAt: true,
        },
      },
      linkedResultDocument: { select: { id: true, fileName: true } },
    },
  },
} as const;

router.get('/events/:id/status', async (req, res, next) => {
  try {
    const status = await prisma.eventStatus.findUnique({
      where: { eventId: req.params.id },
      include: STATUS_ENTRY_INCLUDE,
    });
    res.json(status);
  } catch (e) { next(e); }
});

const StatusSchema = z.object({
  scheduleEntryId: z.string(),
  statusKey: z.enum(['STARTING', 'RUNNING', 'FINISHED', 'STARTS_AT']),
  roundsLeft: z.number().int().min(0).nullable().optional(),
  // Nur bei statusKey "STARTS_AT" relevant: die angesagte Startzeit ("HH:MM"),
  // ersetzt die aktuelle Uhrzeit bei der offsetMinutes-Berechnung unten.
  announcedTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
});

router.put('/events/:id/status', requireAdmin, async (req, res, next) => {
  try {
    const parsed = StatusSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json(parsed.error.flatten()); return; }
    const { scheduleEntryId, statusKey, roundsLeft, announcedTime } = parsed.data;

    const entry = await prisma.scheduleEntry.findUnique({ where: { id: scheduleEntryId } });
    if (!entry || entry.eventId !== req.params.id) {
      res.status(404).json({ error: 'Zeitplan-Eintrag nicht gefunden' });
      return;
    }

    const [h, m] = entry.time.split(':').map(Number);
    const plannedMin = h * 60 + m;

    // Bei "startet um" wird die angesagte Zeit statt der echten aktuellen Zeit
    // verwendet — dieselbe offsetMinutes-Formel wie sonst, nur mit einer
    // angekündigten statt einer beobachteten Uhrzeit.
    let offsetMinutes: number;
    if (statusKey === 'STARTS_AT' && announcedTime) {
      const [ah, am] = announcedTime.split(':').map(Number);
      offsetMinutes = (ah * 60 + am) - plannedMin;
    } else {
      const now = new Date();
      offsetMinutes = (now.getHours() * 60 + now.getMinutes()) - plannedMin;
    }

    const status = await prisma.eventStatus.upsert({
      where: { eventId: req.params.id },
      create: {
        eventId: req.params.id, scheduleEntryId, statusKey,
        roundsLeft: roundsLeft ?? null, offsetMinutes,
      },
      update: { scheduleEntryId, statusKey, roundsLeft: roundsLeft ?? null, offsetMinutes },
      include: STATUS_ENTRY_INCLUDE,
    });

    // Verlaufseintrag für die Selbstkalibrierung (siehe durationEstimate.ts) —
    // getrennt vom EventStatus-Singleton oben, das nur den letzten Stand hält.
    // "Startet um" ist eine ANSAGE, keine BEOBACHTUNG — fließt bewusst nicht in
    // die Kalibrierung ein, da sie sich als falsch herausstellen könnte.
    if (statusKey !== 'STARTS_AT') {
      const logEntry = await prisma.statusUpdateLog.create({
        data: { eventId: req.params.id, scheduleEntryId, statusKey },
      });
      // Läuft bewusst nicht blockierend für die Antwort, aber mit Fehlerprotokoll —
      // ein Kalibrierungsfehler darf das eigentliche Speichern nie verhindern.
      recalibrateFromStatusUpdate(req.params.id, logEntry.id, scheduleEntryId, logEntry.createdAt)
        .catch(err => console.error('Kalibrierung fehlgeschlagen:', err));
    }

    res.json(status);
  } catch (e) { next(e); }
});

export default router;
