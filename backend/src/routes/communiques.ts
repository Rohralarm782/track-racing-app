import { Router } from 'express';
import { z } from 'zod';
import { Prisma, CommuniqueSource } from '@prisma/client';
import prisma from '../prisma';
import { requireAdmin } from '../middleware/auth';
import { listShareFiles } from '../lib/webdav';
import { listHtmlFiles } from '../lib/htmlScrape';
import { fetchDocumentFile } from '../lib/remoteSource';
import { classifyFileName } from '../lib/classify';
import { getCachedFile, setCachedFile } from '../lib/fileCache';
import { notifyNewDocuments } from '../lib/push';
import { analyzeMevForDocument, needsRosterRecheck, MEV_ANALYSIS_VERSION } from '../lib/mevDetect';
import { autoImportScheduleFromDocument, autoMatch } from '../lib/scheduleImport';

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
  sourceType: z.enum(['WEBDAV', 'HTML']).default('WEBDAV'),
  shareToken: z.string().optional(),
  htmlPageUrls: z.array(z.string().url()).optional(),
  label: z.string().optional(),
}).refine(
  d => d.sourceType === 'HTML'
    ? (d.htmlPageUrls?.length ?? 0) > 0
    : !!d.shareToken?.trim(),
  { message: 'WEBDAV benötigt einen shareToken, HTML mindestens eine Seiten-URL.' },
);

// POST /api/communiques/:eventId — Share-Link hinterlegen (Admin)
router.post('/:eventId', requireAdmin, async (req, res, next) => {
  try {
    const parsed = SourceSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json(parsed.error.flatten()); return; }

    const { sourceType, shareToken, htmlPageUrls, label } = parsed.data;
    // Nur die zur Quellenart passenden Felder schreiben, die jeweils andere
    // Konfiguration wird geleert (sauberer Wechsel WebDAV <-> HTML).
    const data = {
      sourceType,
      shareToken: sourceType === 'WEBDAV' ? (shareToken?.trim() || null) : null,
      htmlPageUrls: sourceType === 'HTML' ? (htmlPageUrls ?? []) : [],
      ...(label !== undefined ? { label } : {}),
    };
    const source = await prisma.communiqueSource.upsert({
      where: { eventId: req.params.eventId },
      create: { eventId: req.params.eventId, ...data },
      update: data,
    });
    res.status(201).json(source);
  } catch (e) { next(e); }
});

// POST /api/communiques/:eventId/poll — manuelles Anstoßen (auch vom Cron-Interval genutzt)
router.post('/:eventId/poll', async (req, res, next) => {
  try {
    const source = await prisma.communiqueSource.findUnique({ where: { eventId: req.params.eventId } });
    if (!source) { res.status(404).json({ error: 'Keine Quelle hinterlegt' }); return; }

    const newDocs = await pollSource(source);
    res.json({ newCount: newDocs.length, newDocs });
  } catch (e) { next(e); }
});

// POST /api/communiques/:eventId/subscribe — Push-Subscription registrieren
const SubscribeSchema = z.object({
  endpoint: z.string(),
  keys: z.object({ p256dh: z.string(), auth: z.string() }),
  akFilter: z.array(z.string()).default(['Alle']),
  disciplineFilter: z.array(z.string()).default(['Alle']),
  // Pro-AK-Disziplinauswahl, z.B. { "U17m": ["SPRINT"] }; null = alte Logik
  matrixFilter: z.record(z.array(z.string())).nullable().optional(),
});

router.post('/:eventId/subscribe', async (req, res, next) => {
  try {
    const parsed = SubscribeSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json(parsed.error.flatten()); return; }

    const source = await prisma.communiqueSource.findUnique({ where: { eventId: req.params.eventId } });
    if (!source) { res.status(404).json({ error: 'Keine Quelle hinterlegt' }); return; }

    const { endpoint, keys, akFilter, disciplineFilter, matrixFilter } = parsed.data;
    const matrixValue = matrixFilter ?? Prisma.DbNull;
    const sub = await prisma.pushSubscription.upsert({
      where: { endpoint },
      create: {
        sourceId: source.id, endpoint, p256dh: keys.p256dh, auth: keys.auth,
        akFilter, disciplineFilter, matrixFilter: matrixValue,
      },
      update: { akFilter, disciplineFilter, matrixFilter: matrixValue },
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
      file = await fetchDocumentFile(doc.source, doc);
      setCachedFile(cacheKey, file);
    }

    res.setHeader('Content-Type', file.contentType);
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(doc.fileName)}`);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.send(file.data);
  } catch (e) { next(e); }
});

// PATCH /api/communiques/:eventId/documents/:documentId/pin — Anheften umschalten
router.patch('/:eventId/documents/:documentId/pin', requireAdmin, async (req, res, next) => {
  try {
    const { pinned } = req.body as { pinned?: boolean };
    // Sicherstellen, dass das Dokument wirklich zu diesem Event gehört
    const existing = await prisma.communiqueDocument.findFirst({
      where: { id: req.params.documentId, source: { eventId: req.params.eventId } },
      select: { id: true },
    });
    if (!existing) { res.status(404).json({ error: 'Dokument nicht gefunden' }); return; }
    const doc = await prisma.communiqueDocument.update({
      where: { id: existing.id },
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
    await analyzeMevForDocument(doc, doc.source);
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

    await autoImportScheduleFromDocument(req.params.eventId, doc, doc.source);
    res.status(204).send();
  } catch (e) { next(e); }
});

/**
 * Kernlogik: Ordner abfragen, neue/geänderte Dateien gegen DB abgleichen,
 * neue Einträge speichern und Push auslösen. Wird sowohl vom manuellen
 * Poll-Endpunkt als auch vom Hintergrund-Interval in index.ts genutzt.
 */
export async function pollSource(source: CommuniqueSource) {
  const { id: sourceId, eventId } = source;
  const remoteFiles = source.sourceType === 'HTML'
    ? await listHtmlFiles(source.htmlPageUrls)
    : await listShareFiles(source.shareToken ?? '');
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
          create: { sourceId, fileName: f.fileName, docType, ak, discipline, disciplineCode, phaseLabel, remoteModifiedAt: f.modifiedAt, remoteUrl: f.url ?? null },
          update: { remoteModifiedAt: f.modifiedAt, docType, ak, discipline, disciplineCode, phaseLabel, remoteUrl: f.url ?? null },
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
  // Trigger für die MEV-Analyse (die Json-Spalte mevRiders lässt sich nicht
  // sinnvoll in der DB filtern, deshalb alle Startlisten laden und in JS aussieben):
  //   1. starterCount === null  -> noch nie erfolgreich analysiert
  //   2. mevVersion veraltet    -> mit einem älteren Prompt/Auswertungsstand
  //      analysiert (siehe MEV_ANALYSIS_VERSION); einmaliger Nachtrag
  //   3. needsRosterRecheck     -> Dokument ohne LV-Spalte, für dessen AK
  //      inzwischen ein Dokument MIT LV-Spalte analysiert wurde (Roster gewachsen)
  const startlists = await prisma.communiqueDocument.findMany({
    where: { sourceId, docType: 'STARTLISTE' },
  });
  const needsAnalysis = startlists.filter(
    d => d.starterCount === null
      || d.mevVersion < MEV_ANALYSIS_VERSION
      || needsRosterRecheck(d, startlists),
  );
  for (const doc of needsAnalysis) {
    await analyzeMevForDocument(doc, source);
  }

  // Zweiter Durchgang: Die Reihenfolge oben ist nicht garantiert — ein Dokument
  // ohne LV-Spalte kann VOR dem Dokument mit LV-Spalte derselben AK analysiert
  // worden sein und hätte den Roster dann noch nicht gesehen. Ein Nachlauf
  // genügt, danach sind alle LV-Dokumente analysiert und der Roster vollständig.
  if (needsAnalysis.length > 0) {
    const refreshed = await prisma.communiqueDocument.findMany({
      where: { sourceId, docType: 'STARTLISTE' },
    });
    for (const doc of refreshed.filter(d => needsRosterRecheck(d, refreshed))) {
      await analyzeMevForDocument(doc, source);
    }
  }

  const newZeitplanDocs = created.filter(d => d.docType === 'ZEITPLAN');
  for (const doc of newZeitplanDocs) {
    await autoImportScheduleFromDocument(eventId, doc, source);
  }

  // ── Zeitplan-Verknüpfung nachziehen ───────────────────────────────────────
  // Kommuniqués treffen über den ganzen Veranstaltungstag verteilt ein, der
  // Zeitplan steht aber schon vorher. Ohne diesen Aufruf läuft autoMatch nur
  // beim Speichern des Zeitplans und beim manuellen Rematch — jedes danach
  // eintreffende Dokument bliebe bis zu einem manuellen Rematch unverknüpft
  // (real aufgetreten: Punktefahren-Vorläufe ohne Kommuniqué, obwohl die
  // Ansetzungen längst da waren).
  //
  // Auch nach reinen Reklassifizierungen (toReclassify), da sich dabei
  // Disziplin/Phase eines bekannten Dokuments ändern können — genau die
  // Signale, auf denen das Matching beruht. autoMatch ist idempotent: schon
  // korrekt verknüpfte Einträge werden nicht angefasst.
  //
  // autoImportScheduleFromDocument ruft autoMatch selbst am Ende auf; ein
  // zusätzlicher Aufruf hier schadet daher nicht, sondern deckt den (häufigen)
  // Fall ab, dass gar kein Zeitplan-Dokument dabei war.
  if (created.length > 0 || toReclassify.length > 0) {
    try {
      await autoMatch(eventId);
    } catch (err) {
      // Darf den Poll-Zyklus nicht abbrechen — beim nächsten Eintreffen eines
      // Dokuments (oder per manuellem Rematch) wird es erneut versucht.
      console.error('Zeitplan-Matching nach Poll fehlgeschlagen:', err);
    }
  }

  return created;
}

export default router;
