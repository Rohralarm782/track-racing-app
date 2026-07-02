import { Router } from 'express';
import { z } from 'zod';
import prisma from '../prisma';
import { requireAdmin } from '../middleware/auth';
import { listShareFiles } from '../lib/webdav';
import { classifyFileName } from '../lib/classify';
import { notifyNewDocuments } from '../lib/push';

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

    const newDocs = await pollSource(source.id, source.shareToken);
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

/**
 * Kernlogik: Ordner abfragen, neue/geänderte Dateien gegen DB abgleichen,
 * neue Einträge speichern und Push auslösen. Wird sowohl vom manuellen
 * Poll-Endpunkt als auch vom Hintergrund-Interval in index.ts genutzt.
 */
export async function pollSource(sourceId: string, shareToken: string) {
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
    return fresh.docType !== d.docType || fresh.ak !== d.ak || fresh.discipline !== d.discipline;
  });

  if (toReclassify.length > 0) {
    await prisma.$transaction(
      toReclassify.map(d => {
        const fresh = classifyFileName(d.fileName);
        return prisma.communiqueDocument.update({ where: { id: d.id }, data: fresh });
      })
    );
  }

  if (toCreate.length === 0) {
    await prisma.communiqueSource.update({ where: { id: sourceId }, data: { lastPolledAt: new Date() } });
    return [];
  }

  const created = await prisma.$transaction(
    toCreate.map(f => {
      const { docType, ak, discipline } = classifyFileName(f.fileName);
      return prisma.communiqueDocument.upsert({
        where: { sourceId_fileName: { sourceId, fileName: f.fileName } },
        create: { sourceId, fileName: f.fileName, docType, ak, discipline, remoteModifiedAt: f.modifiedAt },
        update: { remoteModifiedAt: f.modifiedAt, docType, ak, discipline },
      });
    })
  );

  await prisma.communiqueSource.update({ where: { id: sourceId }, data: { lastPolledAt: new Date() } });
  await notifyNewDocuments(sourceId, created);

  return created;
}

export default router;
