import { Router } from 'express';
import { z } from 'zod';
import prisma from '../prisma';
import { requireAdmin } from '../middleware/auth';
import { analyzeZeitplanPdf, autoMatch, loadScheduleWithLinks, ScheduleEntryInputSchema } from '../lib/scheduleImport';
import { ceremonyBlockMinutes, estimateMinutes, recalibrateFromStatusUpdate, usedFallback } from '../lib/durationEstimate';
import { getSettings } from '../lib/settings';
import { analyzeMevForDocument } from '../lib/mevDetect';

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
  id: string; day: number;
  ak: string; disciplineLabel: string; massStart: boolean; type: string; phase: string | null;
  manualUnitCount: number | null;
  plannedDurationMin: number | null;
  linkedDocument: { roundCount: number | null; heatCount: number | null } | null;
}>(
  entries: T[],
): Promise<Array<T & { estimatedMinutes: number | null; estimateIsFallback: boolean }>> {
  const settings = await getSettings();
  // Siegerehrungen blockweise vorab verrechnen (mehrere aufeinanderfolgende
  // Ehrungen teilen sich die Rüstzeit). Setzt voraus, dass entries nach order
  // sortiert sind — liefert loadScheduleWithLinks (orderBy: order asc).
  const ceremonyMin = ceremonyBlockMinutes(entries, settings);
  return Promise.all(entries.map(async e => {
    const base = await estimateMinutes(e, e.linkedDocument, settings);
    return {
      ...e,
      estimatedMinutes: ceremonyMin.has(e.id) ? ceremonyMin.get(e.id)! : base,
      estimateIsFallback: usedFallback(e, e.linkedDocument),
    };
  }));
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
  // Soll-Uhrzeit laut Zeitplan. Bewusst NICHT die Live-Verschiebung — die
  // läuft weiter über EventStatus/offsetMinutes. Hier wird korrigiert, wenn
  // der Veranstalter umplant, ohne einen neuen Zeitplan zu veröffentlichen.
  time: z.string().regex(/^\d{1,2}:\d{2}$/, 'Uhrzeit muss HH:MM sein').optional(),
});

router.patch('/schedule-entries/:id', requireAdmin, async (req, res, next) => {
  try {
    const parsed = PatchEntrySchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json(parsed.error.flatten()); return; }
    const { linkedDocumentId, linkedResultDocumentId, manualUnitCount, time } = parsed.data;
    if (linkedDocumentId === undefined && linkedResultDocumentId === undefined
        && manualUnitCount === undefined && time === undefined) {
      res.json(await prisma.scheduleEntry.findUnique({ where: { id: req.params.id } }));
      return;
    }
    const data: Record<string, string | number | boolean | null> = {};
    // Wird ein Kommuniqué von Hand verknüpft, das Ergebnis als „manuell" markieren,
    // damit autoMatch die Zuordnung beim nächsten Poll/Abgleich nicht wieder auflöst
    // (Disziplin-Selbstheilung, Nicht-Anker-Serie). Beim Lösen von Hand (id = null)
    // fällt der Eintrag bewusst wieder ins Auto-Matching zurück (Flag = false).
    if (linkedDocumentId !== undefined) {
      data.linkedDocumentId = linkedDocumentId;
      data.linkedDocumentManual = typeof linkedDocumentId === 'string' && linkedDocumentId.length > 0;
    }
    if (linkedResultDocumentId !== undefined) {
      data.linkedResultDocumentId = linkedResultDocumentId;
      data.linkedResultManual = typeof linkedResultDocumentId === 'string' && linkedResultDocumentId.length > 0;
    }
    if (manualUnitCount !== undefined) data.manualUnitCount = manualUnitCount;
    if (time !== undefined) data.time = time;

    // linkedDocumentId und linkedResultDocumentId sind @unique — ein Kommuniqué
    // darf nur an EINEM Eintrag hängen. Klebt dasselbe Dokument schon (per
    // Auto-Match) an einem anderen Eintrag, bräche die Zuordnung hier sonst mit
    // einem P2002-Constraint-Fehler ab (→ "Interner Serverfehler"). Die manuelle
    // Zuordnung ist die maßgebliche Korrektur: also das Dokument zuerst vom alten
    // Eintrag lösen, dann hier neu setzen — beides in einer Transaktion.
    const entry = await prisma.$transaction(async (tx) => {
      if (typeof linkedDocumentId === 'string' && linkedDocumentId) {
        await tx.scheduleEntry.updateMany({
          where: { linkedDocumentId, id: { not: req.params.id } },
          data: { linkedDocumentId: null },
        });
      }
      if (typeof linkedResultDocumentId === 'string' && linkedResultDocumentId) {
        await tx.scheduleEntry.updateMany({
          where: { linkedResultDocumentId, id: { not: req.params.id } },
          data: { linkedResultDocumentId: null },
        });
      }
      return tx.scheduleEntry.update({
        where: { id: req.params.id },
        data: data as any,
      });
    });

    // Wird ein Kommuniqué von Hand verknüpft, MEV-Analyse direkt anstoßen —
    // unabhängig vom docType. Grund: Rahmenprogramm-Startlisten (z.B.
    // "ME_250m_Zeitfahren.pdf") werden mangels Startlisten-Schlüsselwörtern als
    // SONSTIGES eingestuft, wodurch weder der Poll-Zyklus noch der übliche
    // STARTLISTE-Filter die MEV-Analyse auslösen. Die manuelle Verknüpfung ist
    // hier das Signal, dass es doch eine relevante Startliste ist. Blockierend,
    // damit die anschließende Neu-Abfrage im Frontend die frischen MEV-Daten
    // sieht; ein Analysefehler darf die Verknüpfung selbst aber nie scheitern
    // lassen.
    if (typeof linkedDocumentId === 'string' && linkedDocumentId) {
      const doc = await prisma.communiqueDocument.findUnique({
        where: { id: linkedDocumentId },
        include: { source: true },
      });
      if (doc) {
        try {
          await analyzeMevForDocument(doc, doc.source);
        } catch (err) {
          console.error('MEV-Analyse nach manueller Verknüpfung fehlgeschlagen:', err);
        }
      }
    }

    res.json(entry);
  } catch (e) { next(e); }
});

// ─── Zeitplan von Hand korrigieren ──────────────────────────────────────────
// Rückfallweg für den Fall, dass der Veranstalter kurzfristig umstellt, aber
// keinen korrigierten Zeitplan veröffentlicht. Bewusst schmal: Reihenfolge,
// Uhrzeit (siehe PATCH oben), Löschen, Hinzufügen. Alles andere macht der
// Neu-Import.
//
// Alle Endpunkte liefern die komplette, angereicherte Liste zurück (wie
// DELETE .../days/:day), damit das Frontend nach jeder Aktion sofort einen
// konsistenten Stand hat, ohne selbst nachzuladen.

/** "HH:MM" → Minuten seit Mitternacht. Ungültiges wird ans Tagesende sortiert. */
function timeToMinutes(t: string): number {
  const m = t.match(/^(\d{1,2}):(\d{2})$/);
  return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : 24 * 60;
}

const NewEntrySchema = z.object({
  day: z.number().int().positive(),
  time: z.string().regex(/^\d{1,2}:\d{2}$/, 'Uhrzeit muss HH:MM sein'),
  ak: z.string().min(1),
  disciplineLabel: z.string().min(1),
  phase: z.string().nullable().optional(),
  type: z.enum(['RACE', 'CEREMONY', 'INFO']).default('RACE'),
  massStart: z.boolean().default(false),
});

// POST /api/events/:id/schedule/entries — einzelnen Eintrag nachtragen
router.post('/events/:id/schedule/entries', requireAdmin, async (req, res, next) => {
  try {
    const parsed = NewEntrySchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json(parsed.error.flatten()); return; }
    const eventId = req.params.id;
    const d = parsed.data;

    await prisma.$transaction(async (tx) => {
      const all = await tx.scheduleEntry.findMany({
        where: { eventId }, orderBy: { order: 'asc' },
        select: { id: true, day: true, time: true, dayLabel: true },
      });

      // Einfügeposition: vor dem ersten späteren Eintrag DESSELBEN Tages.
      // Gibt es den Tag noch gar nicht, kommt der Eintrag ans Ende — die
      // Tagesreihenfolge selbst wird nie umsortiert, weil day die
      // Chronologie führt und nicht die Uhrzeit.
      const sameDay = all.map((e, i) => ({ e, i })).filter(x => x.e.day === d.day);
      let insertAt = all.length;
      if (sameDay.length > 0) {
        const later = sameDay.find(x => timeToMinutes(x.e.time) > timeToMinutes(d.time));
        insertAt = later ? later.i : sameDay[sameDay.length - 1].i + 1;
      }

      const created = await tx.scheduleEntry.create({
        data: {
          eventId,
          day: d.day,
          // dayLabel vom Tag übernehmen, damit die Dubletten-Erkennung beim
          // späteren Re-Import diesen Eintrag genauso behandelt wie die anderen.
          dayLabel: sameDay[0]?.e.dayLabel ?? null,
          time: d.time,
          ak: d.ak,
          disciplineLabel: d.disciplineLabel,
          phase: d.phase?.trim() ? d.phase.trim() : null,
          type: d.type,
          massStart: d.massStart,
          order: 0,
        } as any,
      });

      const ids = all.map(e => e.id);
      ids.splice(insertAt, 0, created.id);
      for (let i = 0; i < ids.length; i++) {
        await tx.scheduleEntry.update({ where: { id: ids[i] }, data: { order: i } });
      }
    });

    // Ein nachgetragenes Rennen kann sehr wohl schon ein Kommuniqué haben.
    await autoMatch(eventId);
    res.status(201).json(await withEstimates(await loadScheduleWithLinks(eventId)));
  } catch (e) { next(e); }
});

// POST /api/schedule-entries/:id/move — einen Platz hoch/runter, nur innerhalb
// des eigenen Tages. Getauscht werden ausschließlich die order-Werte der zwei
// betroffenen Einträge; autoMatch läuft bewusst NICHT mit, weil die
// Positions-Regel im Matching sonst bestehende Verknüpfungen still umhängen
// würde — wer neu zuordnen will, drückt "Kommuniqués abgleichen".
router.post('/schedule-entries/:id/move', requireAdmin, async (req, res, next) => {
  try {
    const parsed = z.object({ direction: z.enum(['up', 'down']) }).safeParse(req.body);
    if (!parsed.success) { res.status(400).json(parsed.error.flatten()); return; }

    const entry = await prisma.scheduleEntry.findUnique({ where: { id: req.params.id } });
    if (!entry) { res.status(404).json({ error: 'Eintrag nicht gefunden' }); return; }

    const siblings = await prisma.scheduleEntry.findMany({
      where: { eventId: entry.eventId, day: entry.day },
      orderBy: { order: 'asc' },
      select: { id: true, order: true },
    });
    const idx = siblings.findIndex(s => s.id === entry.id);
    const target = siblings[parsed.data.direction === 'up' ? idx - 1 : idx + 1];

    // Am Rand des Tages passiert nichts — kein Fehler, damit ein Doppelklick
    // auf den obersten Pfeil nicht als Störung erscheint.
    if (target) {
      await prisma.$transaction([
        prisma.scheduleEntry.update({ where: { id: entry.id }, data: { order: target.order } }),
        prisma.scheduleEntry.update({ where: { id: target.id }, data: { order: siblings[idx].order } }),
      ]);
    }

    res.json(await withEstimates(await loadScheduleWithLinks(entry.eventId)));
  } catch (e) { next(e); }
});

// DELETE /api/schedule-entries/:id — einzelnen Eintrag löschen. Hart, ohne
// Soft-Delete: ein versehentlich importierter Eintrag soll spurlos weg sein.
// Verknüpfte Live-Status und Status-Log verschwinden per Cascade mit.
// order-Werte werden NICHT neu vergeben — eine Lücke stört die Sortierung
// nicht, und weniger Schreibvorgänge heißt weniger, was schiefgehen kann.
router.delete('/schedule-entries/:id', requireAdmin, async (req, res, next) => {
  try {
    const entry = await prisma.scheduleEntry.findUnique({
      where: { id: req.params.id }, select: { id: true, eventId: true },
    });
    if (!entry) { res.status(404).json({ error: 'Eintrag nicht gefunden' }); return; }

    await prisma.scheduleEntry.delete({ where: { id: entry.id } });
    // Das freigewordene Kommuniqué darf sich einen neuen Eintrag suchen.
    await autoMatch(entry.eventId);
    res.json(await withEstimates(await loadScheduleWithLinks(entry.eventId)));
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

// Aktuelle Uhrzeit ("HH:MM") in deutscher Zeitzone — unabhängig davon, in
// welcher Zeitzone der Server läuft. Auf Render läuft der Prozess in UTC, dort
// würde new Date().getHours() im Sommer 2 h zu wenig liefern (10:14 → 8:14).
// Intl mit timeZone Europe/Berlin ist DST-sicher (Sommer- wie Winterzeit).
function nowMinutesBerlin(): number {
  const parts = new Intl.DateTimeFormat('de-DE', {
    timeZone: 'Europe/Berlin',
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(new Date());
  const nowH = Number(parts.find(p => p.type === 'hour')!.value);
  const nowM = Number(parts.find(p => p.type === 'minute')!.value);
  return nowH * 60 + nowM;
}

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
      offsetMinutes = nowMinutesBerlin() - plannedMin;
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
