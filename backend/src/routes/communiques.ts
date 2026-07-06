import { Router } from 'express';
import { z } from 'zod';
import prisma from '../prisma';
import { requireAdmin } from '../middleware/auth';
import { listShareFiles, fetchShareFile } from '../lib/webdav';
import { classifyFileName } from '../lib/classify';
import { getCachedFile, setCachedFile } from '../lib/fileCache';
import { notifyNewDocuments } from '../lib/push';
import { analyzeMevForDocument } from '../lib/mevDetect';
import { autoImportScheduleFromDocument } from '../lib/scheduleImport';

const router = Router();

// GET /api/communiques/vapid-public-key — Frontend braucht das für die Subscription
router.get('/vapid-public-key', (_req, res) => {
  res.json({ key: process.env.VAPID_PUBLIC_KEY ?? '' });
});

// GET /api/communiques/:eventId — Quelle + bekannte Dokumente
router.get('/:eventId', async (req, res, next) => {
  try {
    const source = await prisma.communiqueSource.findUnique({
      where: { eventId: req.params.eventId },
      include: { documents: { orderBy: { remoteModifiedAt: 'desc' } } },
    });
    if (!source) { res.json(null); return; }
    res.json(source);
  } catch (e) { next(e); }
});

const SourceSchema = z.object({
  shareToken: z.string().min(1),
  label: z.string().optional(),
});

// POST /api/communiques/:eventId — Share-Link hinterlegen (Admin)
router.post('/:eventId', requireAdmin, async (req, res, next) => {
  try {
    const parsed = SourceSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json(parsed.error.flatten()); return; }

    const source = await prisma.communiqueSource.upsert({
      where: { eventId: req.params.eventId },
      create: { eventId: req.params.eventId, ...parsed.data },
      update: parsed.data,
    });
    res.status(201).json(source);
  } catch (e) { next(e); }
});

// POST /api/communiques/:eventId/poll — manuelles Anstoßen (auch vom Cron-Interval genutzt)
router.post('/:eventId/poll', async (req, res, next) => {
  try {
    const source = await prisma.communiqueSource.findUnique({ where: { eventId: req.params.eventId } });
    if (!source) { res.status(404).json({ error: 'Keine Quelle hinterlegt' }); return; }

    const newDocs = await pollSource(source.id, source.shareToken, source.eventId);
    res.json({ newCount: newDocs.length, newDocs });
  } catch (e) { next(e); }
});

// POST /api/communiques/:eventId/subscribe — Push-Subscription registrieren
const SubscribeSchema = z.object({
  endpoint: z.string(),
  keys: z.object({ p256dh: z.string(), auth: z.string() }),
  akFilter: z.array(z.string()).default(['Alle']),
  disciplineFilter: z.array(z.string()).default(['Alle']),
});

router.post('/:eventId/subscribe', async (req, res, next) => {
  try {
    const parsed = SubscribeSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json(parsed.error.flatten()); return; }

    const source = await prisma.communiqueSource.findUnique({ where: { eventId: req.params.eventId } });
    if (!source) { res.status(404).json({ error: 'Keine Quelle hinterlegt' }); return; }

    const { endpoint, keys, akFilter, disciplineFilter } = parsed.data;
    const sub = await prisma.pushSubscription.upsert({
      where: { endpoint },
      create: { sourceId: source.id, endpoint, p256dh: keys.p256dh, auth: keys.auth, akFilter, disciplineFilter },
      update: { akFilter, disciplineFilter },
    });
    res.status(201).json(sub);
  } catch (e) { next(e); }
});

// DELETE /api/communiques/subscribe?endpoint=... — Subscription entfernen
router.delete('/subscribe', async (req, res, next) => {
  try {
    const endpoint = req.query.endpoint as string | undefined;
    if (!endpoint) { res.status(400).json({ error: 'endpoint fehlt' }); return; }
    await prisma.pushSubscription.deleteMany({ where: { endpoint } });
    res.status(204).send();
  } catch (e) { next(e); }
});

// GET /api/communiques/:eventId/file/:documentId — PDF direkt anzeigen statt
// herunterzuladen (Content-Disposition: inline), mit In-Memory-Cache für
// häufig geöffnete Dokumente (z.B. der Zeitplan).
router.get('/:eventId/file/:documentId', async (req, res, next) => {
  try {
    const doc = await prisma.communiqueDocument.findUnique({
      where: { id: req.params.documentId },
      include: { source: true },
    });
    if (!doc || doc.source.eventId !== req.params.eventId) {
      res.status(404).json({ error: 'Dokument nicht gefunden' });
      return;
    }

    const cacheKey = `${doc.id}:${doc.remoteModifiedAt.toISOString()}`;
    let file = getCachedFile(cacheKey);
    if (!file) {
      file = await fetchShareFile(doc.source.shareToken, doc.fileName);
      setCachedFile(cacheKey, file);
    }

    res.setHeader('Content-Type', file.contentType);
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(doc.fileName)}`);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.send(file.data);
  } catch (e) { next(e); }
});

// PATCH /api/communiques/:eventId/documents/:documentId/pin — Anheften umschalten
router.patch('/:eventId/documents/:documentId/pin', async (req, res, next) => {
  try {
    const { pinned } = req.body as { pinned?: boolean };
    const doc = await prisma.communiqueDocument.update({
      where: { id: req.params.documentId },
      data: { isPinned: !!pinned },
    });
    res.json(doc);
  } catch (e) { next(e); }
});

// POST /api/communiques/:eventId/documents/:documentId/reanalyze-mev — MEV-Analyse
// manuell neu anstoßen. Fallback für Dokumente, die bereits VOR Einführung von
// Lauf-Nummer/Laufzahl/Rundenzahl analysiert wurden (mevAnalyzedAt ist dann
// schon gesetzt, der normale Poll-Zyklus fasst sie deshalb nicht mehr an).
router.post('/:eventId/documents/:documentId/reanalyze-mev', requireAdmin, async (req, res, next) => {
  try {
    const doc = await prisma.communiqueDocument.findUnique({
      where: { id: req.params.documentId },
      include: { source: true },
    });
    if (!doc || doc.source.eventId !== req.params.eventId) {
      res.status(404).json({ error: 'Dokument nicht gefunden' });
      return;
    }
    await analyzeMevForDocument(doc, doc.source.shareToken);
    const updated = await prisma.communiqueDocument.findUnique({ where: { id: doc.id } });
    res.json(updated);
  } catch (e) { next(e); }
});

// POST /api/communiques/:eventId/documents/:documentId/import-schedule — Zeitplan
// manuell (erneut) aus einem bereits bekannten Dokument importieren. Für neu
// entdeckte Zeitplan-Kommuniqués passiert das automatisch (siehe pollSource
// unten); dieser Endpunkt ist der Fallback für bereits vorhandene Dokumente,
// die vor Einführung dieses Features hochgeladen wurden und deshalb beim
// nächsten Poll nicht als "neu" erkannt werden.
router.post('/:eventId/documents/:documentId/import-schedule', requireAdmin, async (req, res, next) => {
  try {
    const doc = await prisma.communiqueDocument.findUnique({
      where: { id: req.params.documentId },
      include: { source: true },
    });
    if (!doc || doc.source.eventId !== req.params.eventId) {
      res.status(404).json({ error: 'Dokument nicht gefunden' });
      return;
    }
    if (doc.docType !== 'ZEITPLAN') {
      res.status(400).json({ error: 'Dokument ist nicht als Zeitplan erkannt' });
      return;
    }

    await autoImportScheduleFromDocument(req.params.eventId, doc, doc.source.shareToken);
    res.status(204).send();
  } catch (e) { next(e); }
});

/**
 * Kernlogik: Ordner abfragen, neue/geänderte Dateien gegen DB abgleichen,
 * neue Einträge speichern und Push auslösen. Wird sowohl vom manuellen
 * Poll-Endpunkt als auch vom Hintergrund-Interval in index.ts genutzt.
 */
export async function pollSource(sourceId: string, shareToken: string, eventId: string) {
  const remoteFiles = await listShareFiles(shareToken);
  const known = await prisma.communiqueDocument.findMany({ where: { sourceId } });
  const knownMap = new Map(known.map(d => [d.fileName, d]));

  const toCreate = remoteFiles.filter(f => {
    const existing = knownMap.get(f.fileName);
    return !existing || existing.remoteModifiedAt.getTime() !== f.modifiedAt.getTime();
  });

  // Bereits bekannte, unveränderte Dateien: Klassifizierung nachträglich korrigieren
  // (z.B. nach einem Update der Erkennungslogik), aber ohne erneuten Push-Trigger.
  const remoteByName = new Map(remoteFiles.map(f => [f.fileName, f]));
  const toReclassify = known.filter(d => {
    const remote = remoteByName.get(d.fileName);
    if (!remote || remote.modifiedAt.getTime() !== d.remoteModifiedAt.getTime()) return false; // steckt schon in toCreate
    const fresh = classifyFileName(d.fileName);
    return fresh.docType !== d.docType || fresh.ak !== d.ak || fresh.discipline !== d.discipline
      || fresh.disciplineCode !== d.disciplineCode || fresh.phaseLabel !== d.phaseLabel;
  });

  if (toReclassify.length > 0) {
    await prisma.$transaction(
      toReclassify.map(d => {
        const fresh = classifyFileName(d.fileName);
        return prisma.communiqueDocument.update({ where: { id: d.id }, data: fresh });
      })
    );
  }

  let created: Awaited<ReturnType<typeof prisma.communiqueDocument.upsert>>[] = [];

  if (toCreate.length > 0) {
    created = await prisma.$transaction(
      toCreate.map(f => {
        const { docType, ak, discipline, disciplineCode, phaseLabel } = classifyFileName(f.fileName);
        return prisma.communiqueDocument.upsert({
          where: { sourceId_fileName: { sourceId, fileName: f.fileName } },
          create: { sourceId, fileName: f.fileName, docType, ak, discipline, disciplineCode, phaseLabel, remoteModifiedAt: f.modifiedAt },
          update: { remoteModifiedAt: f.modifiedAt, docType, ak, discipline, disciplineCode, phaseLabel },
        });
      })
    );
    await notifyNewDocuments(sourceId, created);
  }

  await prisma.communiqueSource.update({ where: { id: sourceId }, data: { lastPolledAt: new Date() } });

  // ── MEV-Hintergrund-Analyse für Startlisten ohne (vollständige) Analyse ────
  // Läuft für neu entdeckte Startlisten, als Selbstheilung für fehlgeschlagene
  // Analyseversuche, UND als automatischer Nachtrag für Dokumente, die noch
  // VOR Einführung von Lauf-/Rundenzahl analysiert wurden. Trigger ist
  // starterCount (nicht mevAnalyzedAt): jede erfolgreiche Analyse liefert so
  // gut wie immer eine zählbare Teilnehmerzahl, im Unterschied zu
  // heatCount/roundCount, die bei vielen Disziplinen legitim leer bleiben —
  // darauf zu triggern würde diese Dokumente bei jedem Poll erneut anfassen.
  // Sequentiell, um die Anthropic-API nicht mit vielen gleichzeitigen
  // Anfragen zu treffen — bei der Erstverbindung einer Quelle mit vielen
  // Dokumenten dauert ein Poll-Zyklus dadurch entsprechend länger, blockiert
  // aber keine anderen Quellen (siehe index.ts).
  const unanalyzed = await prisma.communiqueDocument.findMany({
    where: { sourceId, docType: 'STARTLISTE', starterCount: null },
  });
  for (const doc of unanalyzed) {
    await analyzeMevForDocument(doc, shareToken);
  }

  // ── Automatischer Zeitplan-Import ──────────────────────────────────────────
  // Nur für NEU entdeckte Zeitplan-Dokumente (created), nicht für
  // reklassifizierte — ein bereits einmal importiertes Dokument, das sich
  // nicht geändert hat, soll nicht bei jedem Poll erneut analysiert werden.
  // Sequentiell aus demselben Grund wie die MEV-Analyse oben.
  const newZeitplanDocs = created.filter(d => d.docType === 'ZEITPLAN');
  for (const doc of newZeitplanDocs) {
    await autoImportScheduleFromDocument(eventId, doc, shareToken);
  }

  return created;
}

export default router;
