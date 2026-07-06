import Anthropic from '@anthropic-ai/sdk';
import prisma from '../prisma';
import { fetchShareFile } from './webdav';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

/**
 * Analysiert ein einzelnes Startlisten-Kommuniqué per Claude Haiku und
 * speichert erkannte MEV-Fahrer/Teams direkt am CommuniqueDocument, inkl.
 * Lauf-Nummer pro Fahrer, Gesamt-Laufzahl (Einzelstart-Formate), Starterzahl
 * und Rundenzahl (Massenstart-Formate) — Grundlage für die Zeitschätzung im
 * Zeitplan. Läuft nur einmal pro Dokument (mevAnalyzedAt wird danach gesetzt)
 * und wird vom Poll-Zyklus für neu entdeckte STARTLISTE-Dokumente
 * angestoßen — rein informativ, verändert keine Renn-/Team-Daten.
 */
export async function analyzeMevForDocument(
  doc: { id: string; fileName: string; disciplineCode?: string | null },
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
Prüfe außerdem:
- ob die Tabelle eine "Lauf"-Spalte hat (Lauf-/Paarungs-Nummer, typisch bei Einzelstart-Formaten wie Zeitfahren oder Verfolgung, aber auch bei anderen Formaten möglich)
- die Gesamtzahl der Starter/Teams in der Tabelle
- ob irgendwo im Dokument eine Rundenzahl für das Rennen genannt wird (z.B. "Wertung nach 40 Runden")

Gib NUR JSON zurück (kein Markdown, kein Text davor/danach):

{"mevRiders":[{"name":"Vorname Nachname","lauf":9}],"heatCount":13,"starterCount":24,"roundCount":40}

Regeln:
- name: "Vorname Nachname", keine Startnummer/Verein/UCI-ID
- lauf: die Lauf-Nummer dieses Fahrers laut Tabelle, falls eine Lauf-Spalte existiert, sonst null
- Bei Team-Paaren (z.B. Madison) beide Fahrer einzeln auflisten, falls einer oder beide MEV sind; beide bekommen denselben lauf-Wert, falls vorhanden
- heatCount: Gesamtzahl unterschiedlicher Lauf-Nummern in der GESAMTEN Tabelle (nicht nur bei MEV-Zeilen), oder null falls keine Lauf-Spalte existiert
- starterCount: Gesamtzahl der Fahrer/Teams (Zeilen) in der Tabelle, unabhängig von einer Lauf-Spalte
- roundCount: die im Dokument EXPLIZIT genannte Rundenzahl, oder null falls nirgends angegeben
- Leeres Array für mevRiders, wenn kein MEV-Fahrer gefunden wird
- Nur JSON, sonst nichts`,
          },
        ],
      }],
    });

    const text = (message.content.find((c: any) => c.type === 'text') as any)?.text ?? '{}';
    const clean = text.replace(/```json\n?|```/g, '').trim();
    const parsed = JSON.parse(clean);
    const mevRiders = Array.isArray(parsed?.mevRiders)
      ? parsed.mevRiders
          .filter((r: any) => r && typeof r.name === 'string')
          .map((r: any) => ({ name: r.name, lauf: typeof r.lauf === 'number' ? r.lauf : null }))
      : [];
    const heatCount = typeof parsed?.heatCount === 'number' ? parsed.heatCount : null;
    const starterCount = typeof parsed?.starterCount === 'number' ? parsed.starterCount : null;
    let roundCount = typeof parsed?.roundCount === 'number' ? parsed.roundCount : null;
    const mevNames = mevRiders.map((r: { name: string }) => r.name); // Abwärtskompatibilität

    // Ausscheidungsfahren: die Rundenzahl steht praktisch nie im Dokument,
    // folgt aber einer festen Formel (Starterzahl × 2) — verlässlicher als ein
    // Textfund, siehe Absprache mit Hauke.
    if (doc.disciplineCode === 'AF' && starterCount != null) {
      roundCount = starterCount * 2;
    }

    await prisma.communiqueDocument.update({
      where: { id: doc.id },
      data: { mevNames, mevRiders, heatCount, starterCount, roundCount, mevAnalyzedAt: new Date() } as any,
    });
  } catch (err) {
    // Eine fehlgeschlagene Analyse darf den restlichen Poll-Zyklus nicht abbrechen —
    // das Dokument bleibt einfach unanalysiert (mevAnalyzedAt bleibt null) und wird
    // beim nächsten Zyklus erneut versucht, sofern es sich noch unter den neuen zählt.
    console.error(`MEV-Analyse fehlgeschlagen für ${doc.fileName}:`, err);
  }
}
