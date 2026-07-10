import webpush from 'web-push';
import prisma from '../prisma';
import type { CommuniqueDocument } from '@prisma/client';

const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY ?? '';
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY ?? '';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT ?? 'mailto:Hauke.Schwarm@gmx.de';

if (VAPID_PUBLIC && VAPID_PRIVATE) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
}

/**
 * Benachrichtigt alle Subscriptions einer Quelle, deren Filter zum Dokument
 * passt. Neue Logik: `matrixFilter` (pro AK gewählte Disziplinen, z.B.
 * { "U17m": ["SPRINT"], "U19m": ["AUSDAUER"] }). Ist `matrixFilter` null
 * (ältere Subscriptions), gilt weiterhin die alte akFilter/disciplineFilter-
 * Logik. Ungültige/abgelaufene Subscriptions werden bei HTTP 404/410
 * automatisch entfernt.
 */
export async function notifyNewDocuments(sourceId: string, docs: CommuniqueDocument[]) {
  if (docs.length === 0 || !VAPID_PUBLIC || !VAPID_PRIVATE) return;

  const subs = await prisma.pushSubscription.findMany({ where: { sourceId } });
  if (subs.length === 0) return;

  for (const sub of subs) {
    const matrix = sub.matrixFilter as Record<string, string[]> | null;

    const relevant = docs.filter(d => {
      if (matrix && typeof matrix === 'object') {
        // ── Neue Logik: pro AK gewählte Disziplinen ──
        const hasAnySelection = Object.keys(matrix).length > 0;
        if (!hasAnySelection) return false; // bewusst nichts ausgewählt
        // Allgemeine Dokumente (ohne AK) kommen immer mit, solange etwas gewählt ist
        if (d.ak === 'Alle') return true;
        const discs = matrix[d.ak];
        if (!discs || discs.length === 0) return false;
        return d.discipline === 'ALLGEMEIN' || discs.includes(d.discipline);
      }
      // ── Alte Logik (Subscriptions ohne matrixFilter) ──
      const akMatch = d.ak === 'Alle' || sub.akFilter.includes('Alle') || sub.akFilter.includes(d.ak);
      const discMatch = d.discipline === 'ALLGEMEIN'
        || sub.disciplineFilter.includes('Alle')
        || sub.disciplineFilter.includes(d.discipline);
      return akMatch && discMatch;
    });
    if (relevant.length === 0) continue;

    const title = relevant.length === 1
      ? 'Neues Kommuniqué'
      : `${relevant.length} neue Kommuniqués`;
    const body = relevant.length === 1
      ? relevant[0].fileName
      : relevant.slice(0, 3).map(d => d.fileName).join(', ');

    const payload = JSON.stringify({ title, body, docCount: relevant.length });

    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        payload,
      );
    } catch (err: any) {
      if (err?.statusCode === 404 || err?.statusCode === 410) {
        await prisma.pushSubscription.delete({ where: { id: sub.id } }).catch(() => {});
      } else {
        console.error('Push-Versand fehlgeschlagen:', err?.message ?? err);
      }
    }
  }
}
