import { Router } from 'express';
import { z } from 'zod';
import { Prisma, CommuniqueSource } from '@prisma/client';
import prisma from '../prisma';
import { requireAdmin } from '../middleware/auth';
import { listShareFiles } from '../lib/webdav';
import { listHtmlFiles, scanHtmlSections } from '../lib/htmlScrape';
import { listDriveFiles, isPdfFileName } from '../lib/gdrive';
import { isSpinsUrl, listSpinsFiles, listSpinsEventsForPicker } from '../lib/spins';
import {
  IMAGE_ANALYSIS_VERSION, analyzeImageForDocument, classifyImageDocument,
  buildDisplayName, isImageFileName, isAnalyzableImage, needsHeadAnalysis,
} from '../lib/imageClassify';
import { fetchDocumentFile } from '../lib/remoteSource';
import { classifyFileName, parseCommuniqueVersion } from '../lib/classify';
import { getCachedFile, setCachedFile } from '../lib/fileCache';
import { notifyNewDocuments } from '../lib/push';
import { analyzeMevForDocument, needsRosterRecheck, MEV_ANALYSIS_VERSION } from '../lib/mevDetect';
import { autoImportScheduleFromDocument, autoMatch } from '../lib/scheduleImport';

const router = Router();

// GET /api/communiques/vapid-public-key — Frontend braucht das für die Subscription
router.get('/vapid-public-key', (_req, res) => {
  res.json({ key: process.env.VAPID_PUBLIC_KEY ?? '' });
});

// GET /api/communiques/:eventId — alle Quellen der Veranstaltung + ihre
// bekannten Dokumente. Liefert ein Array (leer = keine Quelle hinterlegt),
// seit v-NEXT: eine Veranstaltung kann mehrere Quellen haben (z.B. Website +
// eigener Drive-Ordner für abfotografierte Aushänge).
router.get('/:eventId', async (req, res, next) => {
  try {
    const sources = await prisma.communiqueSource.findMany({
      where: { eventId: req.params.eventId },
      orderBy: { createdAt: 'asc' },
      include: {
        documents: {
          orderBy: { remoteModifiedAt: 'desc' },
          // supersededBy für die Anzeige „ersetzt durch K12B" im Admin-Bereich.
          // supersededById und missingSince sind Skalare und kommen ohnehin mit.
          include: { supersededBy: { select: { id: true, fileName: true } } },
        },
      },
    });
    res.json(sources);
  } catch (e) { next(e); }
});

const SourceSchema = z.object({
  sourceType: z.enum(['WEBDAV', 'HTML', 'GDRIVE']).default('WEBDAV'),
  shareToken: z.string().optional(),
  // Nur GDRIVE: ID des öffentlich freigegebenen Ordners.
  driveFolderId: z.string().optional(),
  htmlPageUrls: z.array(z.string().url()).optional(),
  // Nur HTML: Auswahl der Seiten-Abschnitte (Überschriften-Blöcke). Leer/fehlend
  // = ganze Seite, wie bisher.
  htmlSections: z.array(z.string()).optional(),
  label: z.string().optional(),
  // true = beim Speichern alle bereits gefundenen Dokumente dieser Quelle
  // löschen. Sinnvoll, wenn die Links komplett umgezogen sind: die alten
  // CommuniqueDocument-Einträge zeigen dann auf tote PDF-URLs. Zeitplan-
  // Verknüpfungen (linkedDocument*) sind per onDelete: SetNull abgesichert.
  purgeDocuments: z.boolean().optional(),
}).refine(
  d => d.sourceType === 'HTML'
    ? (d.htmlPageUrls?.length ?? 0) > 0
    : d.sourceType === 'GDRIVE'
      ? !!d.driveFolderId?.trim()
      : !!d.shareToken?.trim(),
  {
    message: 'WEBDAV benötigt einen shareToken, HTML mindestens eine Seiten-URL, '
      + 'GDRIVE eine Ordner-ID.',
  },
);

// Aus den geparsten Formulardaten nur die zur Quellenart passenden Felder
// bauen — die jeweils andere Konfiguration wird geleert (sauberer Wechsel
// WebDAV <-> HTML <-> GDRIVE). Gemeinsam für Anlegen (POST) und Bearbeiten
// (PATCH) einer einzelnen Quelle genutzt.
function buildSourceData(parsed: z.infer<typeof SourceSchema>) {
  const { sourceType, shareToken, driveFolderId, htmlPageUrls, htmlSections, label } = parsed;
  return {
    sourceType,
    shareToken: sourceType === 'WEBDAV' ? (shareToken?.trim() || null) : null,
    driveFolderId: sourceType === 'GDRIVE' ? (driveFolderId?.trim() || null) : null,
    htmlPageUrls: sourceType === 'HTML' ? (htmlPageUrls ?? []) : [],
    htmlSections: sourceType === 'HTML' ? (htmlSections ?? []) : [],
    ...(label !== undefined ? { label } : {}),
  };
}

// POST /api/communiques/:eventId/sources — neue Quelle anlegen (Admin).
// Reines Insert, kein Upsert mehr: eine Veranstaltung kann mehrere Quellen
// haben (z.B. Website + eigener Drive-Ordner für Sprint-Fotos).
router.post('/:eventId/sources', requireAdmin, async (req, res, next) => {
  try {
    const parsed = SourceSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json(parsed.error.flatten()); return; }
    const source = await prisma.communiqueSource.create({
      data: { eventId: req.params.eventId, ...buildSourceData(parsed.data) },
    });
    res.status(201).json(source);
  } catch (e) { next(e); }
});

// PATCH /api/communiques/:eventId/sources/:sourceId — bestehende Quelle
// bearbeiten (Admin). Ersetzt das frühere Upsert-per-eventId.
router.patch('/:eventId/sources/:sourceId', requireAdmin, async (req, res, next) => {
  try {
    const parsed = SourceSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json(parsed.error.flatten()); return; }
    const existing = await prisma.communiqueSource.findFirst({
      where: { id: req.params.sourceId, eventId: req.params.eventId },
      select: { id: true },
    });
    if (!existing) { res.status(404).json({ error: 'Quelle nicht gefunden' }); return; }

    const source = await prisma.communiqueSource.update({
      where: { id: existing.id },
      data: buildSourceData(parsed.data),
    });
    // Alte Dokumente entfernen, wenn die Quelle umgezogen ist. Der nächste Poll
    // (unmittelbar danach vom Frontend angestoßen) findet die aktuellen PDFs neu.
    if (parsed.data.purgeDocuments) {
      await prisma.communiqueDocument.deleteMany({ where: { sourceId: source.id } });
    }
    res.json(source);
  } catch (e) { next(e); }
});

// DELETE /api/communiques/:eventId/sources/:sourceId — Quelle entfernen
// (Admin). Ihre Dokumente hängen per onDelete: Cascade daran und werden mit
// gelöscht — die Bestätigung dafür liegt im Frontend beim Menschen.
router.delete('/:eventId/sources/:sourceId', requireAdmin, async (req, res, next) => {
  try {
    const existing = await prisma.communiqueSource.findFirst({
      where: { id: req.params.sourceId, eventId: req.params.eventId },
      select: { id: true },
    });
    if (!existing) { res.status(404).json({ error: 'Quelle nicht gefunden' }); return; }
    await prisma.communiqueSource.delete({ where: { id: existing.id } });
    res.status(204).send();
  } catch (e) { next(e); }
});

// POST /api/communiques/:eventId/scan-sections — Seite(n) auf Überschriften-
// Blöcke untersuchen (Admin). Bewusst mit den URLs aus dem Request und nicht aus
// der gespeicherten Quelle: die Auswahl passiert beim Einrichten bzw. Ändern,
// also bevor gespeichert wird. Rein lesend, ohne HEAD-Requests.
const ScanSchema = z.object({ htmlPageUrls: z.array(z.string().url()).min(1) });

router.post('/:eventId/scan-sections', requireAdmin, async (req, res, next) => {
  try {
    const parsed = ScanSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json(parsed.error.flatten()); return; }
    res.json(await scanHtmlSections(parsed.data.htmlPageUrls));
  } catch (e) { next(e); }
});

// GET /api/communiques/:eventId/spins-events — Veranstaltungen bei SPINS zur
// Auswahl (Admin). Der Link auf die SPINS-Seite ist für alle Veranstaltungen
// derselbe; welche gemeint ist, steht nirgends darin. Deshalb hier die Liste,
// vorsortiert danach, ob sie zeitlich zur Veranstaltung in der App passt.
router.get('/:eventId/spins-events', requireAdmin, async (req, res, next) => {
  try {
    const event = await prisma.event.findUnique({
      where: { id: req.params.eventId },
      select: { date: true },
    });
    res.json({ events: await listSpinsEventsForPicker(event?.date ?? null) });
  } catch (e) { next(e); }
});

// POST /api/communiques/:eventId/poll — manuelles Anstoßen aller Quellen
// dieser Veranstaltung (auch vom Cron-Interval pro Quelle einzeln genutzt).
// Eine fehlschlagende Quelle darf die anderen nicht blockieren — analog zum
// globalen Poll-Zyklus in index.ts.
router.post('/:eventId/poll', async (req, res, next) => {
  try {
    const sources = await prisma.communiqueSource.findMany({ where: { eventId: req.params.eventId } });
    if (sources.length === 0) { res.status(404).json({ error: 'Keine Quelle hinterlegt' }); return; }

    const newDocs: Awaited<ReturnType<typeof pollSource>> = [];
    for (const source of sources) {
      try {
        newDocs.push(...await pollSource(source));
      } catch (err) {
        console.error(`Manueller Poll fehlgeschlagen für Quelle ${source.id}:`, err);
      }
    }
    res.json({ newCount: newDocs.length, newDocs });
  } catch (e) { next(e); }
});

// PATCH /api/communiques/:eventId/documents/:docId/classification
// Zuordnung von Hand setzen. Markiert das Dokument als classificationManual,
// damit weder der Poll noch eine erneute Bild-Auswertung sie überschreibt.
const ClassificationSchema = z.object({
  communiqueNumber: z.string().max(20).nullable().optional(),
  ak: z.string().min(1).max(40).optional(),
  disciplineCode: z.string().max(4).nullable().optional(),
  phaseLabel: z.string().max(60).nullable().optional(),
  docType: z.enum(['STARTLISTE', 'ERGEBNIS', 'ZEITPLAN', 'SONSTIGES']).optional(),
  displayName: z.string().max(200).nullable().optional(),
  // false zurücksetzen = wieder der automatischen Erkennung überlassen
  classificationManual: z.boolean().optional(),
});

router.patch('/:eventId/documents/:docId/classification', requireAdmin, async (req, res, next) => {
  try {
    const parsed = ClassificationSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json(parsed.error.flatten()); return; }

    const doc = await prisma.communiqueDocument.findUnique({ where: { id: req.params.docId } });
    if (!doc) { res.status(404).json({ error: 'Dokument nicht gefunden' }); return; }

    const d = parsed.data;
    const manual = d.classificationManual ?? true;
    const updated = await prisma.communiqueDocument.update({
      where: { id: doc.id },
      data: {
        ...(d.communiqueNumber !== undefined ? { communiqueNumber: d.communiqueNumber } : {}),
        ...(d.ak !== undefined ? { ak: d.ak } : {}),
        ...(d.disciplineCode !== undefined ? { disciplineCode: d.disciplineCode } : {}),
        ...(d.phaseLabel !== undefined ? { phaseLabel: d.phaseLabel } : {}),
        ...(d.docType !== undefined ? { docType: d.docType } : {}),
        ...(d.displayName !== undefined ? { displayName: d.displayName } : {}),
        classificationManual: manual,
        // Von Hand gesetzt heißt: die Unsicherheits-Markierung ist erledigt.
        // Wird die Zuordnung wieder freigegeben, greift beim nächsten Poll die
        // automatische Auswertung erneut (imageVersion zurücksetzen).
        ...(manual ? { imageConfident: true } : { imageVersion: 0 }),
      },
    });
    res.json(updated);
  } catch (e) { next(e); }
});

// POST /api/communiques/:eventId/documents/:docId/recognize
// Erkennung prüfen, ohne etwas zu speichern. Zweck: am Vorabend einer
// Veranstaltung testen, ob die Aushänge gelesen werden — und bei Bedarf den
// Hinweistext in den Einstellungen nachziehen, statt am Renntag zu deployen.
router.post('/:eventId/documents/:docId/recognize', requireAdmin, async (req, res, next) => {
  try {
    const doc = await prisma.communiqueDocument.findUnique({
      where: { id: req.params.docId },
      include: { source: true },
    });
    if (!doc) { res.status(404).json({ error: 'Dokument nicht gefunden' }); return; }
    // PDFs sind hier ausdrücklich erlaubt: Genau dieser Knopf beantwortet am
    // Vorabend die Frage, ob eine Ansetzung wie "R03.pdf" gelesen wird —
    // ohne dass dafür etwas gespeichert oder deployt werden muss.
    if (!isAnalyzableImage(doc.fileName) && !isPdfFileName(doc.fileName)) {
      res.status(400).json({
        error: isImageFileName(doc.fileName)
          ? 'Dieses Bildformat kann nicht ausgewertet werden (HEIC/HEIF). Bitte von Hand zuordnen.'
          : 'Diese Datei kann nicht aus dem Dokument heraus erkannt werden (nur Fotos und PDFs).',
      });
      return;
    }

    const result = await classifyImageDocument(doc, doc.source);
    if (!result) { res.status(422).json({ error: 'Aus diesem Dokument ließ sich nichts lesen.' }); return; }
    res.json({ ...result, displayName: buildDisplayName(result, doc.fileName) });
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

    // Weiterhin nur abonnierbar, wenn mindestens eine Quelle hinterlegt ist —
    // ein Abo pro Veranstaltung deckt jetzt ALLE ihre Quellen ab, statt eines
    // getrennten Abos je Quelle.
    const anySource = await prisma.communiqueSource.findFirst({ where: { eventId: req.params.eventId } });
    if (!anySource) { res.status(404).json({ error: 'Keine Quelle hinterlegt' }); return; }

    const { endpoint, keys, akFilter, disciplineFilter, matrixFilter } = parsed.data;
    const matrixValue = matrixFilter ?? Prisma.DbNull;
    const sub = await prisma.pushSubscription.upsert({
      where: { endpoint },
      create: {
        eventId: req.params.eventId, endpoint, p256dh: keys.p256dh, auth: keys.auth,
        akFilter, disciplineFilter, matrixFilter: matrixValue,
      },
      update: { eventId: req.params.eventId, akFilter, disciplineFilter, matrixFilter: matrixValue },
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

// PATCH /api/communiques/:eventId/documents/:documentId/hide — Als veraltet
// ausblenden umschalten (Gegenstück zum Anheften). Das Dokument bleibt in der
// DB und wird weiter gepollt, verschwindet aber aus der Standard-Dokumentliste.
// Nützlich, wenn der Veranstalter eine neue Version unter neuem Dateinamen
// hochlädt (z.B. Zeitplan K12 → K12A) und die alte Fassung nicht mehr stören
// soll — insbesondere, damit Athleten nicht versehentlich ein veraltetes PDF öffnen.
router.patch('/:eventId/documents/:documentId/hide', requireAdmin, async (req, res, next) => {
  try {
    const { hidden } = req.body as { hidden?: boolean };
    const existing = await prisma.communiqueDocument.findFirst({
      where: { id: req.params.documentId, source: { eventId: req.params.eventId } },
      select: { id: true },
    });
    if (!existing) { res.status(404).json({ error: 'Dokument nicht gefunden' }); return; }
    const doc = await prisma.communiqueDocument.update({
      where: { id: existing.id },
      data: { isHidden: !!hidden },
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

// ─── MEV-Fahrer von Hand eintragen (Fallback/Überschreiben) ────────────────
// Ergänzt die automatische Erkennung: für Dokumente, bei denen sie wiederholt
// falsch liegt, lässt sich die Fahrerliste hier direkt festlegen. Danach fasst
// weder der automatische Poll noch der "Neu analysieren"-Knopf dieses
// Dokument mehr an (siehe mevManual-Guard in mevDetect.ts), bis .../reset
// wieder auf automatisch zurückstellt.
const ManualRiderSchema = z.object({
  name: z.string().trim().min(1).max(80),
  lauf: z.number().int().positive().nullable().optional(),
  startPos: z.enum(['ZG', 'GG', 'B', 'M']).nullable().optional(),
});
const ManualRidersSchema = z.object({
  riders: z.array(ManualRiderSchema).max(50),
});

router.patch('/:eventId/documents/:documentId/mev-manual', requireAdmin, async (req, res, next) => {
  try {
    const doc = await prisma.communiqueDocument.findUnique({
      where: { id: req.params.documentId },
      include: { source: true },
    });
    if (!doc || doc.source.eventId !== req.params.eventId) {
      res.status(404).json({ error: 'Dokument nicht gefunden' });
      return;
    }
    const parsed = ManualRidersSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json(parsed.error.flatten()); return; }
    // Volle MevRider-Form aufbauen (siehe MevRider in mevDetect.ts) — Felder,
    // die das Formular nicht erhebt (team, startSlot, startOrder, laufLabel),
    // bleiben null, genau wie bei automatisch erkannten Fahrern ohne diese Spalten.
    const mevRiders = parsed.data.riders.map(r => ({
      name: r.name,
      section: 0,
      lauf: r.lauf ?? null,
      laufLabel: null,
      team: null,
      startNo: null,
      startPos: r.startPos ?? null,
      startSlot: null,
      startOrder: null,
    }));
    const updated = await prisma.communiqueDocument.update({
      where: { id: doc.id },
      data: { mevManual: true, mevRiders },
    });
    res.json(updated);
  } catch (e) { next(e); }
});

router.post('/:eventId/documents/:documentId/mev-manual/reset', requireAdmin, async (req, res, next) => {
  try {
    const doc = await prisma.communiqueDocument.findUnique({
      where: { id: req.params.documentId },
      include: { source: true },
    });
    if (!doc || doc.source.eventId !== req.params.eventId) {
      res.status(404).json({ error: 'Dokument nicht gefunden' });
      return;
    }
    // mevVersion auf 0: der nächste Poll (oder ein manueller "Neu
    // analysieren"-Klick) wertet das Dokument dadurch garantiert neu aus,
    // unabhängig vom aktuellen MEV_ANALYSIS_VERSION-Stand. mevRiders schon
    // jetzt leeren, statt bis zum nächsten Poll (bis zu 90s) die alte,
    // unbeschriftete Handeingabe stehen zu lassen.
    const updated = await prisma.communiqueDocument.update({
      where: { id: doc.id },
      data: { mevManual: false, mevRiders: [], mevAnalyzedAt: null, mevVersion: 0 },
    });
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
    if (!isPdfFileName(doc.fileName)) {
      res.status(400).json({
        error: 'Aus einem Bild kann kein Zeitplan übernommen werden. '
          + 'Bitte die Einträge von Hand anlegen oder den Zeitplan als PDF ablegen.',
      });
      return;
    }

    await autoImportScheduleFromDocument(req.params.eventId, doc, doc.source);
    res.status(204).send();
  } catch (e) { next(e); }
});

/**
 * Automatische Ersetzung veralteter Kommuniqués (K12 → K12A → K12B).
 *
 * Gruppiert alle Dokumente einer Quelle nach K-Nummer + IDENTISCHER
 * Klassifizierung (AK + Disziplin-Kürzel + Phase + Dokumenttyp). Trägt eine
 * Gruppe mehr als ein Dokument, gewinnt der höchste Buchstaben-Suffix; alle
 * anderen bekommen supersededById = Gewinner-ID gesetzt und verschwinden damit
 * aus der Standardliste. Anschließend werden Zeitplan-Verknüpfungen, die noch
 * auf eine ausgeblendete Fassung zeigen, auf den Gewinner umgehängt.
 *
 * Bewusst konservativ: Nur bei EXAKT gleicher Klassifizierung. So verdrängen
 * sich z.B. „K160 Quali" und „K160B Finale" (unterschiedliche Phase) NICHT
 * gegenseitig — beides sind legitime, verschiedene Startlisten. Ohne erkennbare
 * K-Nummer (number = MAX_SAFE_INTEGER) ist ein Dokument nicht versionierbar und
 * bleibt unangetastet. Idempotent: bei jedem Poll neu berechnet, setzt nur
 * tatsächlich abweichende Felder.
 */
export async function applySupersessions(sourceId: string): Promise<void> {
  const docs = await prisma.communiqueDocument.findMany({
    where: { sourceId },
    select: {
      id: true, fileName: true, ak: true, disciplineCode: true,
      phaseLabel: true, docType: true, supersededById: true,
      communiqueNumber: true,
    },
  });

  // Bei Fotos steht die Nummer nicht im Dateinamen, sondern wurde aus dem
  // Dokumentkopf gelesen. Sie hat deshalb Vorrang; fehlt sie, bleibt es beim
  // bisherigen Verhalten (Dateiname).
  const versionKey = (d: { fileName: string; communiqueNumber?: string | null }) =>
    parseCommuniqueVersion(d.communiqueNumber ?? d.fileName);

  const groups = new Map<string, typeof docs>();
  for (const d of docs) {
    const { number } = versionKey(d);
    if (number === Number.MAX_SAFE_INTEGER) continue; // keine K-Nummer → nicht versionierbar
    const key = [number, d.ak, d.disciplineCode ?? '', d.phaseLabel ?? '', d.docType].join('::');
    const bucket = groups.get(key);
    if (bucket) bucket.push(d); else groups.set(key, [d]);
  }

  // Soll-Zustand: pro Dokument die ID der neuesten Fassung (bzw. null).
  const desired = new Map<string, string | null>();
  for (const d of docs) desired.set(d.id, null);
  const relink: Array<{ loserId: string; winnerId: string }> = [];

  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const winner = [...group].sort((a, b) =>
      versionKey(a).suffix.localeCompare(versionKey(b).suffix)
    ).at(-1)!;
    for (const d of group) {
      if (d.id === winner.id) continue;
      desired.set(d.id, winner.id);
      relink.push({ loserId: d.id, winnerId: winner.id });
    }
  }

  // Nur geänderte supersededById-Felder schreiben.
  for (const d of docs) {
    const next = desired.get(d.id) ?? null;
    if ((d.supersededById ?? null) !== next) {
      await prisma.communiqueDocument.update({ where: { id: d.id }, data: { supersededById: next } });
    }
  }

  // Zeitplan-Verknüpfungen vom veralteten Dokument auf den Nachfolger umhängen.
  // Einzeln mit try/catch, damit eine (sehr seltene) Unique-Kollision — falls
  // der Nachfolger bereits an einem anderen Eintrag hängt — den Poll nicht
  // abbricht. linkedDocumentId/linkedResultDocumentId sind jeweils @unique.
  for (const { loserId, winnerId } of relink) {
    for (const field of ['linkedDocumentId', 'linkedResultDocumentId'] as const) {
      const entries = await prisma.scheduleEntry.findMany({ where: { [field]: loserId }, select: { id: true } });
      for (const e of entries) {
        try {
          await prisma.scheduleEntry.update({ where: { id: e.id }, data: { [field]: winnerId } as any });
        } catch (err) {
          console.error(`Umhängen ${field} ${loserId} → ${winnerId} fehlgeschlagen:`, err);
        }
      }
    }
  }
}

/**
 * Markiert Dokumente, deren Datei nicht mehr in der (vollständig gelesenen)
 * Quelle liegt, mit missingSince (Zeitpunkt des ersten Fehlens). Taucht eine
 * Datei wieder auf, wird missingSince wieder gelöscht. Setzt nur tatsächlich
 * abweichende Felder. Die Verknüpfung im Zeitplan bleibt bewusst bestehen —
 * die MEV-Daten sind bereits gespeichert und weiter nutzbar.
 */
export async function markMissingDocuments(sourceId: string, remoteFileNames: string[]): Promise<void> {
  const remote = new Set(remoteFileNames);
  const docs = await prisma.communiqueDocument.findMany({
    where: { sourceId },
    select: { id: true, fileName: true, missingSince: true },
  });
  const now = new Date();
  for (const d of docs) {
    const present = remote.has(d.fileName);
    if (!present && d.missingSince === null) {
      await prisma.communiqueDocument.update({ where: { id: d.id }, data: { missingSince: now } });
    } else if (present && d.missingSince !== null) {
      await prisma.communiqueDocument.update({ where: { id: d.id }, data: { missingSince: null } });
    }
  }
}

/**
 * Kernlogik: Ordner abfragen, neue/geänderte Dateien gegen DB abgleichen,
 * neue Einträge speichern und Push auslösen. Wird sowohl vom manuellen
 * Poll-Endpunkt als auch vom Hintergrund-Interval in index.ts genutzt.
 */
/**
 * Hält den Grund eines fehlgeschlagenen Quellen-Abrufs an der Quelle fest.
 * lastPollErrorAt markiert den Beginn der aktuellen Fehler-Serie und bleibt bei
 * Folgefehlern unverändert stehen.
 */
async function recordPollError(source: CommuniqueSource, message: string): Promise<void> {
  await prisma.communiqueSource.update({
    where: { id: source.id },
    data: {
      lastPollError: message.slice(0, 500),
      ...(source.lastPollError ? {} : { lastPollErrorAt: new Date() }),
    },
  });
}

export async function pollSource(source: CommuniqueSource) {
  const { id: sourceId, eventId } = source;
  // listingComplete = die Remote-Liste ist vollständig genug, um daraus auf
  // „Datei fehlt jetzt in der Quelle" zu schließen. WebDAV wirft bei Fehler
  // (bricht den Poll ab, kein Fehlalarm möglich) → immer true. HTML meldet
  // complete=false, wenn eine Seite nicht geladen werden konnte.
  let listingComplete = true;
  // Klartext-Grund, falls die Quelle (teilweise) nicht erreichbar war — wird
  // unten an der Quelle gespeichert und in der Quellen-Karte angezeigt.
  let pollError: string | null = null;
  let remoteFiles;
  if (source.sourceType === 'HTML') {
    // SPINS-Adressen (spins-live.de) werden NICHT gescrapt: die Seite baut ihre
    // Liste per JavaScript auf und enthält im Quelltext keinen PDF-Link. Sie
    // laufen über die SPINS-Datei-Schnittstelle, der Rest der Adressen wie
    // bisher über den Scraper. Beide Listen werden zusammengeführt — so lassen
    // sich Zeitplan/Startlisten von der Ausrichterseite und Ergebnisse aus
    // SPINS in EINER HTML-Quelle führen (mehrere Quellen pro Veranstaltung
    // sind ebenfalls möglich, z.B. zusätzlich eine eigene GDRIVE-Quelle).
    const spinsUrls = source.htmlPageUrls.filter(isSpinsUrl);
    const pageUrls = source.htmlPageUrls.filter((u: string) => !isSpinsUrl(u));
    // Ohne Seiten gar nicht erst scrapen: sonst meldet der Abschnitts-Filter
    // alle hinterlegten Abschnitte als "nicht gefunden", obwohl es schlicht
    // keine Seite zu durchsuchen gibt.
    const html = pageUrls.length > 0
      ? await listHtmlFiles(pageUrls, source.htmlSections)
      : { files: [], complete: true, errors: [] as string[], missingSections: [] as string[] };
    let spins: { files: typeof html.files; complete: boolean; errors: string[] } =
      { files: [], complete: true, errors: [] };
    if (spinsUrls.length > 0) {
      // Name, Datum und Ort der Veranstaltung dienen dazu, die richtige
      // SPINS-Veranstaltung zu finden — deren Kennung steht nicht im Link.
      const event = await prisma.event.findUnique({
        where: { id: eventId },
        select: { name: true, date: true, location: true },
      });
      spins = await listSpinsFiles(spinsUrls, {
        name: event?.name ?? '',
        date: event?.date ?? null,
        location: event?.location ?? null,
      });
    }
    remoteFiles = [...html.files, ...spins.files];
    listingComplete = html.complete && spins.complete;
    const problems = [...html.errors, ...spins.errors];
    // Ein hinterlegter Abschnitt, den es auf der Seite nicht mehr gibt (Ausrichter
    // hat die Überschrift umbenannt), liefert lautlos null Dokumente. Deshalb als
    // Fehler melden, damit die rote Box in der Quellen-Karte anschlägt.
    if (html.missingSections.length > 0) {
      problems.push(
        `Abschnitt nicht mehr auf der Seite gefunden: ${html.missingSections.join(' / ')}. `
        + 'Bitte die Quelle prüfen und den Abschnitt neu wählen.',
      );
    }
    if (problems.length > 0) pollError = problems.join(' · ');
  } else if (source.sourceType === 'GDRIVE') {
    // Drive verhält sich wie HTML: Fehler brechen den Poll NICHT ab, sondern
    // melden complete=false. Ein Teilergebnis ist brauchbar (die gelesenen
    // Dateien stimmen), nur die Missing-Erkennung muss dann aussetzen.
    const drive = await listDriveFiles(source.driveFolderId ?? '');
    remoteFiles = drive.files;
    listingComplete = drive.complete;
    if (drive.error) pollError = drive.error;
  } else {
    // WebDAV wirft bei Fehlern und bricht den Poll ab. Damit der Grund nicht
    // nur im Log landet, vor dem Weiterwerfen an der Quelle festhalten.
    try {
      remoteFiles = await listShareFiles(source.shareToken ?? '');
    } catch (err) {
      await recordPollError(source, err instanceof Error ? err.message : String(err));
      throw err;
    }
  }
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
    // Von Hand gesetzte Zuordnungen sind unantastbar.
    if (d.classificationManual) return false;
    // Bilder ebenfalls: ihre Zuordnung stammt aus dem Dokumentkopf, nicht aus
    // dem Dateinamen. Ohne diese Ausnahme würde classifyFileName bei JEDEM Poll
    // ein "IMG-20260919-WA0037.jpg" auf "Alle/SONSTIGES" zurücksetzen und die
    // Bild-Erkennung damit sofort wieder zunichtemachen.
    if (isImageFileName(d.fileName)) return false;
    // PDFs, deren Zuordnung aus dem DOKUMENTKOPF stammt (nichtssagender
    // Dateiname wie "R03.pdf", siehe imageClassify.ts), aus demselben Grund:
    // classifyFileName würde sie bei jedem Poll wieder auf "Alle/SONSTIGES"
    // zurücksetzen und damit die Auswertung sofort zunichtemachen. Erkennbar
    // daran, dass eine Auswertung gelaufen ist UND einen Anzeigenamen ergeben hat.
    if (d.imageVersion > 0 && d.displayName) return false;
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
        const existing = knownMap.get(f.fileName);
        // Wurde die Zuordnung von Hand gesetzt, bleibt sie auch dann stehen,
        // wenn die Datei in der Quelle ersetzt wurde — nur Zeitstempel und
        // Adresse werden nachgezogen.
        const update = existing?.classificationManual
          ? { remoteModifiedAt: f.modifiedAt, remoteUrl: f.url ?? null }
          : {
              remoteModifiedAt: f.modifiedAt, docType, ak, discipline, disciplineCode, phaseLabel,
              remoteUrl: f.url ?? null,
              // Datei wurde ausgetauscht → erneut auswerten. Gilt für Fotos und
              // für PDFs, die schon einmal über ihren Kopf ausgewertet wurden
              // (sonst bliebe der Name des alten Standes stehen).
              ...(isImageFileName(f.fileName) || (existing?.imageVersion ?? 0) > 0
                ? { imageVersion: 0, displayName: null }
                : {}),
            };
        return prisma.communiqueDocument.upsert({
          where: { sourceId_fileName: { sourceId, fileName: f.fileName } },
          create: { sourceId, fileName: f.fileName, docType, ak, discipline, disciplineCode, phaseLabel, remoteModifiedAt: f.modifiedAt, remoteUrl: f.url ?? null },
          update,
        });
      })
    );
    await notifyNewDocuments(eventId, created);
  }

  await prisma.communiqueSource.update({
    where: { id: sourceId },
    data: {
      lastPolledAt: new Date(),
      lastPollError: pollError ? pollError.slice(0, 500) : null,
      // Beginn der Fehler-Serie nur beim ERSTEN Fehler setzen, damit die Karte
      // "seit wann" anzeigen kann; bei Erfolg zurücksetzen.
      ...(pollError
        ? (source.lastPollError ? {} : { lastPollErrorAt: new Date() })
        : { lastPollErrorAt: null }),
    },
  });

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
  //   1. starterCount === null UND mevAnalyzedAt === null -> noch nie versucht.
  //      Das mevAnalyzedAt-Kriterium ist nötig, weil analyzeMevForDocument auch
  //      bei einem Fehlschlag mevAnalyzedAt/mevVersion setzt (siehe mevDetect.ts) —
  //      ohne dieses zweite Kriterium würde ein dauerhaft scheiterndes Dokument
  //      (starterCount bleibt für immer null) bei JEDEM Poll erneut versucht.
  //   2. mevVersion veraltet    -> mit einem älteren Prompt/Auswertungsstand
  //      analysiert (siehe MEV_ANALYSIS_VERSION); einmaliger Nachtrag
  //   3. needsRosterRecheck     -> Dokument ohne LV-Spalte, für dessen AK
  //      inzwischen ein Dokument MIT LV-Spalte analysiert wurde (Roster gewachsen)
  const startlists = await prisma.communiqueDocument.findMany({
    where: { sourceId, docType: 'STARTLISTE' },
  });
  const needsAnalysis = startlists.filter(
    // Bilder (abfotografierte Aushänge) werden hier bewusst übergangen: die
    // Auswertung schickt die Datei als PDF-Block an das Modell und liefe in
    // einen Fehler. Weil der Trigger starterCount === null lautet, würde das
    // OHNE diesen Filter bei JEDEM Poll erneut versucht — die Datei würde
    // jedes Mal neu geladen. Auswertung von Fotos ist ein eigener Schritt.
    // Von Hand gepflegte Dokumente (mev-manual) nie automatisch anfassen —
    // Muster wie bei classificationManual/linkedDocumentManual.
    d => !d.mevManual
      && isPdfFileName(d.fileName)
      && ((d.starterCount === null && d.mevAnalyzedAt === null)
        || d.mevVersion < MEV_ANALYSIS_VERSION
        || needsRosterRecheck(d, startlists)),
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
    for (const doc of refreshed.filter(d => !d.mevManual && isPdfFileName(d.fileName) && needsRosterRecheck(d, refreshed))) {
      await analyzeMevForDocument(doc, source);
    }
  }

  // Wie bei der MEV-Analyse: der Zeitplan-Import liest ein PDF. Ein als
  // Zeitplan erkanntes Foto würde nur einen API-Fehler erzeugen; es bleibt
  // sichtbar und kann von Hand verknüpft werden.
  const newZeitplanDocs = created.filter(d => d.docType === 'ZEITPLAN' && isPdfFileName(d.fileName));
  for (const doc of newZeitplanDocs) {
    await autoImportScheduleFromDocument(eventId, doc, source);
  }

  // ── Kopf-Auswertung: Fotos und PDFs ohne sprechenden Dateinamen ────────────
  // Muss VOR applySupersessions laufen: erst danach steht communiqueNumber am
  // Dokument, und ohne die kann eine neuere Fassung desselben Aushangs die
  // ältere nicht verdrängen.
  //
  // Trigger ist imageVersion (nicht imageAnalyzedAt): auch ein fehlgeschlagener
  // Versuch setzt die Version, sonst würde der Poll dasselbe unlesbare Foto bei
  // jedem Durchlauf erneut herunterladen und erneut ans Modell schicken.
  // Sequentiell, aus demselben Grund wie bei der MEV-Analyse weiter unten.
  const imageDocs = await prisma.communiqueDocument.findMany({
    where: {
      sourceId,
      classificationManual: false,
      imageVersion: { lt: IMAGE_ANALYSIS_VERSION },
    },
    select: {
      id: true, fileName: true, remoteUrl: true, classificationManual: true,
      // Für needsHeadAnalysis: nur PDFs, aus deren Namen NICHTS zu holen war.
      docType: true, ak: true, disciplineCode: true,
    },
  });
  // isAnalyzableImage statt isImageFileName: HEIC-Aufnahmen sind Bilder, können
  // vom Modell aber nicht gelesen werden. Sie bleiben unangetastet in der Liste
  // stehen und werden von Hand zugeordnet.
  //
  // Dazu PDFs mit nichtssagendem Dateinamen ("R03.pdf"): Ohne Kopf-Auswertung
  // blieben sie ohne Altersklasse, ohne Disziplin und als SONSTIGES — damit
  // weder im Zeitplan verknüpfbar noch Grundlage der MEV-Analyse.
  const toAnalyze = imageDocs.filter(d => isAnalyzableImage(d.fileName) || needsHeadAnalysis(d));
  let imagesAnalyzed = 0;
  for (const doc of toAnalyze) {
    try {
      await analyzeImageForDocument(doc, source);
      imagesAnalyzed++;
    } catch (err) {
      // Ein einzelnes Dokument darf den Poll nicht abbrechen.
      console.error(`[poll] Kopf-Auswertung fehlgeschlagen (${doc.fileName}):`, err);
    }
  }

  // ── Automatische Ersetzung (K12 → K12A → K12B) ─────────────────────────────
  // Nur nötig, wenn sich Dokumente geändert haben — eine neue Fassung ist immer
  // ein „created" (neuer Dateiname). Blendet veraltete Fassungen aus und hängt
  // bestehende Zeitplan-Verknüpfungen auf den Nachfolger um. Läuft VOR autoMatch,
  // damit ersetzte Dokumente dort schon als Kandidaten ausgeschlossen sind.
  if (created.length > 0 || toReclassify.length > 0 || imagesAnalyzed > 0) {
    try {
      await applySupersessions(sourceId);
    } catch (err) {
      console.error('Automatische Ersetzung nach Poll fehlgeschlagen:', err);
    }
  }

  // ── „Fehlt in Quelle" ──────────────────────────────────────────────────────
  // Läuft bei JEDEM vollständigen Poll (nicht nur bei Änderungen), da eine Datei
  // aus der Quelle verschwinden kann, ohne dass etwas Neues auftaucht. Bei
  // unvollständigem Listing (HTML-Teilausfall) übersprungen, um keine gültigen
  // Dokumente fälschlich als fehlend zu markieren.
  if (listingComplete) {
    try {
      await markMissingDocuments(sourceId, remoteFiles.map(f => f.fileName));
    } catch (err) {
      console.error('Missing-Erkennung nach Poll fehlgeschlagen:', err);
    }
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
