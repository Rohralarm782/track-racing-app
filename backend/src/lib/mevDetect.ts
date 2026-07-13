import Anthropic from '@anthropic-ai/sdk';
import prisma from '../prisma';
import { fetchShareFile } from './webdav';
import { getSettings } from './settings';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Startpositionen auf der Bahn:
//   ZG/GG — Ziel-/Gegengerade (Einzelstart: Zeitfahren, Verfolgung)
//   B/M   — Ballustrade/Messlinie (Massenstart: Punktefahren, Madison, ...)
const START_POSITIONS = ['ZG', 'GG', 'B', 'M'];

/**
 * True, wenn ein bereits analysiertes Dokument MEV-Fahrer OHNE startPos-Feld
 * enthält — also vor Einführung der Startpositions-Erkennung analysiert wurde.
 * Dient dem einmaligen Nachtrag im Poll-Zyklus (siehe communiques.ts): nach der
 * Neuanalyse hat jeder Fahrer das Feld (ggf. mit Wert null) und das Dokument
 * wird nicht erneut angefasst. Dokumente ganz ohne MEV-Fahrer brauchen keinen
 * Nachtrag — dort gibt es nichts anzuzeigen.
 */
export function needsStartPosBackfill(mevRiders: unknown): boolean {
  return Array.isArray(mevRiders)
    && mevRiders.length > 0
    && mevRiders.some(r => r && typeof r === 'object' && !('startPos' in r));
}

/**
 * Analysiert ein einzelnes Startlisten-Kommuniqué per Claude Haiku und
 * speichert erkannte Fahrer/Teams des konfigurierten Landesverbands (siehe
 * AppSettings.mevLv, Standard "MEV") direkt am CommuniqueDocument, inkl.
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
    const settings = await getSettings();
    const lv = settings.mevLv;

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
Finde alle Fahrer bzw. Teams, deren Landesverband-Kürzel (Spalte "LV" o.ä.) "${lv}" ist.
Prüfe außerdem:
- ob die Tabelle eine "Lauf"-Spalte hat (Lauf-/Paarungs-Nummer, typisch bei Einzelstart-Formaten wie Zeitfahren oder Verfolgung, aber auch bei anderen Formaten möglich)
- ob die Tabelle eine "Team"/"Mannschaft"-Spalte hat (typisch bei Mannschafts-Disziplinen wie Teamsprint, Mannschaftsverfolgung, Madison — dort stehen mehrere Fahrer pro Lauf, gruppiert unter einem Team-Kürzel wie "${lv} 2" oder "${lv} 1")
- die Gesamtzahl der Starter/Teams in der Tabelle
- die Startposition jedes gefundenen ${lv}-Fahrers/Teams (siehe startPos unten)
- die Rundenzahl für das Rennen. Bei allen Disziplinen AUSSER Ausscheidungsfahren steht diese praktisch immer irgendwo im Dokument, oft in einer Zeile direkt unter der Renn-Überschrift im Format "<Distanz> / <Rundenzahl> Runden / <Anzahl> Wertungen" (z.B. "15km / 60 Runden / 6 Wertungen") — diese Zeile kann auch am Ende des Dokuments wiederholt werden. Manchmal auch anders formuliert, z.B. "Wertung nach 40 Runden" oder als Teil der Renn-Überschrift ("Punktefahren über 40 Runden").

Gib NUR JSON zurück (kein Markdown, kein Text davor/danach):

{"mevRiders":[{"name":"Vorname Nachname","lauf":9,"team":"${lv} 2","startPos":"ZG"}],"heatCount":13,"starterCount":24,"roundCount":40}

Regeln:
- name: "Vorname Nachname", keine Startnummer/Verein/UCI-ID
- lauf: die Lauf-Nummer dieses Fahrers laut Tabelle, falls eine Lauf-Spalte existiert, sonst null
- team: der Wert aus der Team-/Mannschaft-Spalte (z.B. "${lv} 2"), falls eine solche Spalte existiert, sonst null. NICHT der Vereinsname aus der "Verein"-Spalte — das Team-Kürzel besteht meist aus Landesverband-Kürzel + Nummer.
- Bei Team-Paaren/Mannschaften (z.B. Madison, Teamsprint, Mannschaftsverfolgung) ALLE Fahrer des Teams einzeln auflisten, falls einer oder mehrere "${lv}" sind; alle bekommen denselben lauf- und team-Wert
- startPos: die Startposition dieses Fahrers/Teams. Genau einer dieser vier Werte oder null:
  * Einzelstart-Formate (Zeitfahren, Einzel-/Mannschaftsverfolgung — Tabelle mit Lauf-Spalte, zwei Starter je Lauf): "ZG" (Zielgerade) oder "GG" (Gegengerade). Die Zuordnung steht NICHT in der Tabelle, sondern in einem Hinweissatz unter der Tabelle, z.B. "Die erstgenannte Fahrerin startet von der Zielgeraden". Diesen Satz wörtlich auswerten und auf die Zeilen-Reihenfolge INNERHALB des Laufs anwenden: bei dieser Formulierung startet der im Lauf zuerst genannte Fahrer von "ZG", der zweite von "GG". Steht dort stattdessen "Gegengeraden", gilt es genau umgekehrt. Fehlt der Hinweissatz, ist die Position unbekannt -> null.
  * Massenstart-Formate (Punktefahren, Madison, Scratch, Ausscheidungsfahren): "B" (Ballustrade/Balustrade) oder "M" (Messlinie/Mess-linie). Die Startaufstellung besteht dort typischerweise aus ZWEI Tabellen bzw. einer Spalte mit genau diesen Überschriften — maßgeblich ist, in welcher der beiden der Fahrer steht.
  * In allen anderen Fällen (keine der genannten Angaben im Dokument): null
- heatCount: Gesamtzahl unterschiedlicher Lauf-Nummern in der GESAMTEN Tabelle (nicht nur bei ${lv}-Zeilen), oder null falls keine Lauf-Spalte existiert
- starterCount: Gesamtzahl der Fahrer/Teams (Zeilen) in der Tabelle, unabhängig von einer Lauf-Spalte
- roundCount: die im Dokument genannte Rundenzahl. Aktiv danach suchen (siehe oben) — nur null zurückgeben, wenn wirklich nirgends im Dokument eine Rundenzahl steht
- Leeres Array für mevRiders, wenn kein "${lv}"-Fahrer gefunden wird
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
          .map((r: any) => ({
            name: r.name,
            lauf: typeof r.lauf === 'number' ? r.lauf : null,
            team: typeof r.team === 'string' ? r.team : null,
            // Nur die vier bekannten Positionen zulassen — ein halluziniertes
            // Freitext-Feld würde sonst ungeprüft in der Zeitplan-Zeile landen.
            startPos: START_POSITIONS.includes(r.startPos) ? r.startPos : null,
          }))
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
