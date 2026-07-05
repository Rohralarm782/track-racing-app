import Anthropic from '@anthropic-ai/sdk';
import prisma from '../prisma';
import { fetchShareFile } from './webdav';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

/**
 * Analysiert ein einzelnes Startlisten-Kommuniqué per Claude Haiku und
 * speichert erkannte MEV-Fahrer/Teams direkt am CommuniqueDocument. Läuft nur
 * einmal pro Dokument (mevAnalyzedAt wird danach gesetzt) und wird vom
 * Poll-Zyklus für neu entdeckte STARTLISTE-Dokumente angestoßen — rein
 * informativ für die Zeitplan-Anzeige, verändert keine Renn-/Team-Daten.
 */
export async function analyzeMevForDocument(
  doc: { id: string; fileName: string },
  shareToken: string,
): Promise<void> {
  try {
    const file = await fetchShareFile(shareToken, doc.fileName);
    const base64 = file.data.toString('base64');

    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1500,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'document',
            source: { type: 'base64', media_type: 'application/pdf', data: base64 },
          } as any,
          {
            type: 'text',
            text: `Dies ist eine Startliste/Ansetzung einer Bahnrad-Veranstaltung.
Finde alle Fahrer bzw. Teams, deren Landesverband-Kürzel (Spalte "LV" o.ä.) "MEV" ist.
Gib NUR JSON zurück (kein Markdown, kein Text davor/danach):

{"mevNames":["Vorname Nachname"]}

Regeln:
- Nur "Vorname Nachname", keine Startnummer/Verein/UCI-ID
- Bei Team-Paaren (z.B. Madison) beide Fahrer einzeln auflisten, falls einer oder beide MEV sind
- Leeres Array, wenn kein MEV-Fahrer gefunden wird
- Nur JSON, sonst nichts`,
          },
        ],
      }],
    });

    const text = (message.content.find((c: any) => c.type === 'text') as any)?.text ?? '{}';
    const clean = text.replace(/```json\n?|```/g, '').trim();
    const parsed = JSON.parse(clean);
    const mevNames = Array.isArray(parsed?.mevNames) ? parsed.mevNames.filter((n: unknown) => typeof n === 'string') : [];

    await prisma.communiqueDocument.update({
      where: { id: doc.id },
      data: { mevNames, mevAnalyzedAt: new Date() },
    });
  } catch (err) {
    // Eine fehlgeschlagene Analyse darf den restlichen Poll-Zyklus nicht abbrechen —
    // das Dokument bleibt einfach unanalysiert (mevAnalyzedAt bleibt null) und wird
    // beim nächsten Zyklus erneut versucht, sofern es sich noch unter den neuen zählt.
    console.error(`MEV-Analyse fehlgeschlagen für ${doc.fileName}:`, err);
  }
}
