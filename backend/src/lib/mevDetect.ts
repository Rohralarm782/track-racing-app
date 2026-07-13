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
 * Version der MEV-Analyse (Prompt + Nachbearbeitung). Wird am Dokument
 * gespeichert; der Poll-Zyklus analysiert jedes Dokument mit kleinerer Version
 * automatisch neu. Bei JEDER inhaltlichen Änderung an Prompt oder Auswertung
 * hochzählen — sonst behalten bereits analysierte Dokumente ihr altes Ergebnis.
 */
export const MEV_ANALYSIS_VERSION = 4;

export interface MevRider {
  name: string;
  lauf: number | null;
  laufLabel: string | null;
  startSlot: number | null;
  team: string | null;
  startNo: number | null;
  startPos: string | null;
}

// Was analyzeMevForDocument vom Dokument braucht — deckungsgleich mit dem
// Prisma-Modell, damit Aufrufer einfach das geladene Dokument durchreichen können.
interface AnalyzableDoc {
  id: string;
  sourceId: string;
  fileName: string;
  ak: string;
  disciplineCode?: string | null;
}

/**
 * True, wenn ein Dokument OHNE LV-Spalte neu analysiert werden muss, weil
 * inzwischen ein Dokument MIT LV-Spalte derselben Altersklasse analysiert
 * wurde — das Roster (Startnummer → MEV-Fahrer) ist also größer geworden als
 * beim letzten Analyseversuch dieses Dokuments.
 *
 * Hintergrund: Vorlauf-Ansetzungen im Massenstart enthalten oft NUR
 * Startnummer + Name, keine LV-Spalte (real: "K134A - U17w Ansetz 1.Vorl
 * Punktefahren.pdf"). Erkannt werden die MEV-Fahrer dort nur über ihre
 * Startnummer, die aus anderen Kommuniqués derselben Veranstaltung bekannt
 * ist. Trifft ein solches Dokument VOR dem ersten Dokument mit LV-Spalte ein,
 * ist das Roster noch leer — deshalb dieser Nachzieh-Trigger.
 */
export function needsRosterRecheck(
  doc: { id: string; ak: string; hasLvColumn: boolean | null; mevAnalyzedAt: Date | null },
  allDocs: Array<{ id: string; ak: string; hasLvColumn: boolean | null; mevAnalyzedAt: Date | null }>,
): boolean {
  if (doc.hasLvColumn !== false || !doc.mevAnalyzedAt) return false;
  return allDocs.some(d =>
    d.id !== doc.id
    && d.ak === doc.ak
    && d.hasLvColumn === true
    && d.mevAnalyzedAt != null
    && d.mevAnalyzedAt > doc.mevAnalyzedAt!,
  );
}

// Alle bereits bekannten MEV-Fahrer derselben Veranstaltung und Altersklasse,
// zusammengetragen aus den Dokumenten MIT LV-Spalte. Startnummern sind
// innerhalb einer Veranstaltung eindeutig und damit der verlässlichste
// Anknüpfungspunkt; der Name dient als Rückfallebene.
async function loadMevRoster(doc: AnalyzableDoc): Promise<Array<{ startNo: number | null; name: string }>> {
  const lvDocs = await prisma.communiqueDocument.findMany({
    where: { sourceId: doc.sourceId, ak: doc.ak, hasLvColumn: true, id: { not: doc.id } },
    select: { mevRiders: true },
  });

  const byKey = new Map<string, { startNo: number | null; name: string }>();
  for (const d of lvDocs) {
    const riders = Array.isArray(d.mevRiders) ? (d.mevRiders as any[]) : [];
    for (const r of riders) {
      if (!r || typeof r.name !== 'string') continue;
      const startNo = typeof r.startNo === 'number' ? r.startNo : null;
      const key = startNo != null ? `n${startNo}` : `x${r.name.toLowerCase()}`;
      if (!byKey.has(key)) byKey.set(key, { startNo, name: r.name });
    }
  }
  return [...byKey.values()];
}

/**
 * Analysiert ein einzelnes Startlisten-Kommuniqué per Claude Haiku und
 * speichert erkannte Fahrer/Teams des konfigurierten Landesverbands (siehe
 * AppSettings.mevLv, Standard "MEV") direkt am CommuniqueDocument, inkl.
 * Startnummer, Lauf-Nummer, Startposition, Gesamt-Laufzahl, Starterzahl und
 * Rundenzahl — Grundlage für die Zeitschätzung und die Anzeige im Zeitplan.
 * Wird vom Poll-Zyklus angestoßen — rein informativ, verändert keine
 * Renn-/Team-Daten.
 */
export async function analyzeMevForDocument(
  doc: AnalyzableDoc,
  shareToken: string,
): Promise<void> {
  try {
    const settings = await getSettings();
    const lv = settings.mevLv;

    const roster = await loadMevRoster(doc);
    // Nur wenn überhaupt etwas bekannt ist — ein leerer Roster-Block im Prompt
    // würde das Modell nur zu Fehlschlüssen einladen ("keine bekannt" ≠ "keine da").
    const rosterBlock = roster.length === 0 ? '' : `

FALLS DIE TABELLE KEINE LV-SPALTE HAT (kommt bei Vorlauf-Ansetzungen im Massenstart häufig vor — dort stehen nur Startnummer und Name):
Aus anderen Kommuniqués DERSELBEN Veranstaltung und Altersklasse sind diese "${lv}"-Fahrer bekannt:
${roster.map(r => `- Startnummer ${r.startNo ?? '?'} = ${r.name}`).join('\n')}
Dann gelten GENAU diese Fahrer als "${lv}". Erkenne sie in der Tabelle vorrangig an der STARTNUMMER (innerhalb der Veranstaltung eindeutig), hilfsweise am Namen. Nimm keine anderen Fahrer auf.
Hat die Tabelle dagegen eine LV-Spalte, ist AUSSCHLIESSLICH diese Spalte maßgeblich — die Liste oben dann ignorieren.`;

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
- ob die Tabelle überhaupt eine "LV"-Spalte (Landesverband) hat
- ob die Tabelle eine "Lauf"-Spalte hat (Lauf-/Paarungs-Nummer, typisch bei Einzelstart-Formaten wie Zeitfahren oder Verfolgung, aber auch bei anderen Formaten möglich)
- ob die Tabelle eine "Team"/"Mannschaft"-Spalte hat (typisch bei Mannschafts-Disziplinen wie Teamsprint, Mannschaftsverfolgung, Madison — dort stehen mehrere Fahrer pro Lauf, gruppiert unter einem Team-Kürzel wie "${lv} 2" oder "${lv} 1")
- die Startposition jedes gefundenen "${lv}"-Fahrers/Teams (siehe startPos unten)
- die Gesamtzahl der Starter/Teams in der Tabelle
- die Rundenzahl für das Rennen. Bei allen Disziplinen AUSSER Ausscheidungsfahren steht diese praktisch immer irgendwo im Dokument, oft in einer Zeile direkt unter der Renn-Überschrift im Format "<Distanz> / <Rundenzahl> Runden / <Anzahl> Wertungen" (z.B. "15km / 60 Runden / 6 Wertungen") — diese Zeile kann auch am Ende des Dokuments wiederholt werden. Manchmal auch anders formuliert, z.B. "Wertung nach 40 Runden" oder als Teil der Renn-Überschrift ("Punktefahren über 40 Runden").${rosterBlock}

Gib NUR JSON zurück (kein Markdown, kein Text davor/danach):

{"hasLvColumn":true,"mevRiders":[{"name":"Vorname Nachname","startNo":88,"lauf":9,"laufLabel":null,"team":"${lv} 2","startPos":"B","startSlot":10}],"heatCount":13,"starterCount":24,"roundCount":40}

Regeln:
- hasLvColumn: true, wenn die Tabelle eine LV-/Landesverband-Spalte hat, sonst false
- name: "Vorname Nachname", keine Startnummer/Verein/UCI-ID
- startNo: die Startnummer dieses Fahrers laut Spalte "Start-Nr." o.ä., sonst null
- lauf / laufLabel: beide beziehen sich AUSSCHLIESSLICH auf eine echte Lauf-Spalte der Tabelle (Spaltenüberschrift "Lauf", "Heat", "Paarung" o.ä.). Gibt es keine solche Spalte, sind BEIDE null. Die Startnummer ("Start-Nr.") ist NIEMALS die Lauf-Nummer — verwechsle die beiden Spalten nicht. Auch eine Überschrift wie "Vorlauf 1" über der Tabelle ist KEINE Lauf-Angabe im Sinne dieser Felder: dann beide null.
  * lauf: der Wert der Lauf-Spalte, wenn er eine reine Zahl ist (z.B. "9" -> 9), sonst null
  * laufLabel: der Text der Lauf-Spalte, wenn er KEINE reine Zahl ist — z.B. bei Sprint-Finals steht dort "Platz 1/2" bzw. "Platz 3/4", bei Hoffnungsläufen o.ä. auch anderer Text. Wortlaut aus dem Dokument übernehmen (Zeilenumbrüche in der Zelle als Leerzeichen). Ist der Wert eine reine Zahl, dann null.
  * Ein Fahrer hat also entweder lauf ODER laufLabel gesetzt, nie beides.
- team: der Wert aus der Team-/Mannschaft-Spalte (z.B. "${lv} 2"), falls eine solche Spalte existiert, sonst null. NICHT der Vereinsname aus der "Verein"-Spalte — das Team-Kürzel besteht meist aus Landesverband-Kürzel + Nummer.
- Bei Team-Paaren/Mannschaften (z.B. Madison, Teamsprint, Mannschaftsverfolgung) ALLE Fahrer des Teams einzeln auflisten, falls einer oder mehrere "${lv}" sind; alle bekommen denselben lauf- und team-Wert
- startPos: die Startposition dieses Fahrers/Teams. Genau einer dieser vier Werte oder null:
  * Einzelstart-Formate (Zeitfahren, Einzel-/Mannschaftsverfolgung — zwei Starter je Lauf): "ZG" (Zielgerade) oder "GG" (Gegengerade). Die Zuordnung steht NICHT in der Tabelle, sondern in einem Hinweissatz unter der Tabelle, z.B. "Die erstgenannte Fahrerin startet von der Zielgeraden". Diesen Satz wörtlich auswerten und auf die Zeilen-Reihenfolge INNERHALB des Laufs anwenden: bei dieser Formulierung startet der im Lauf zuerst genannte Fahrer von "ZG", der zweite von "GG". Steht dort stattdessen "Gegengeraden", gilt es genau umgekehrt. Fehlt der Hinweissatz, ist die Position unbekannt -> null.
  * Massenstart-Formate (Punktefahren, Madison, Scratch, Ausscheidungsfahren): "B" (Ballustrade/Balustrade) oder "M" (Messlinie/Mess-linie). Die Startaufstellung besteht dort aus ZWEI nebeneinander oder untereinander stehenden Tabellen bzw. einer Spalte mit genau diesen Überschriften — maßgeblich ist, in welcher der beiden der Fahrer steht. Die zweite Tabelle kann auch "Cote d'Azur" überschrieben sein — das ist die Messlinien-Gruppe -> "M".
  * In allen anderen Fällen: null
- startSlot: NUR bei Massenstart (startPos "B" oder "M"): die Position des Fahrers INNERHALB seiner Startreihe, also die 1-basierte Zeilennummer in genau der Tabelle, in der er steht (erste Zeile der Ballustrade-Tabelle = 1, zweite = 2, usw.; die Messlinien-/Cote-d'Azur-Tabelle wird separat ab 1 gezählt). Leerzeilen am Tabellenende nicht mitzählen. Gibt es eine eigene, GEFÜLLTE Positions-Spalte, deren Wert verwenden. Bei Einzelstart (startPos "ZG"/"GG") und wenn startPos null ist: immer null.
- heatCount: Gesamtzahl unterschiedlicher Werte in der Lauf-Spalte der GESAMTEN Tabelle (nicht nur bei "${lv}"-Zeilen) — Text-Werte wie "Platz 1/2" zählen genauso mit wie Zahlen. null, falls die Tabelle keine Lauf-Spalte hat.
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
    const mevRiders: MevRider[] = Array.isArray(parsed?.mevRiders)
      ? parsed.mevRiders
          .filter((r: any) => r && typeof r.name === 'string')
          .map((r: any) => ({
            name: r.name,
            lauf: typeof r.lauf === 'number' ? r.lauf : null,
            // Textueller Lauf ("Platz 3/4" im Sprint-Finale) — die Lauf-Spalte
            // enthält nicht immer eine Zahl. Kürzen, damit ein ausufernder
            // Freitext die Zeitplan-Zeile nicht sprengt.
            laufLabel: typeof r.laufLabel === 'string' && r.laufLabel.trim()
              ? r.laufLabel.trim().replace(/\s+/g, ' ').slice(0, 20)
              : null,
            team: typeof r.team === 'string' ? r.team : null,
            startNo: typeof r.startNo === 'number' ? r.startNo : null,
            // Nur die vier bekannten Positionen zulassen — ein halluziniertes
            // Freitext-Feld würde sonst ungeprüft in der Zeitplan-Zeile landen.
            startPos: START_POSITIONS.includes(r.startPos) ? r.startPos : null,
            startSlot: typeof r.startSlot === 'number' ? r.startSlot : null,
          }))
      : [];
    const hasLvColumn = typeof parsed?.hasLvColumn === 'boolean' ? parsed.hasLvColumn : null;
    const heatCount = typeof parsed?.heatCount === 'number' ? parsed.heatCount : null;
    const starterCount = typeof parsed?.starterCount === 'number' ? parsed.starterCount : null;
    let roundCount = typeof parsed?.roundCount === 'number' ? parsed.roundCount : null;
    const mevNames = mevRiders.map(r => r.name); // Abwärtskompatibilität

    // Schutz gegen eine wiederkehrende Verwechslung: Ohne Lauf-Spalte gibt es
    // keine heatCount — dann darf auch kein Fahrer eine Lauf-Nummer haben. Das
    // Modell hat in solchen Dokumenten (z.B. Vorlauf-Ansetzungen im Massenstart,
    // die nur Start-Nr./Name/Vorname enthalten) sonst gern die STARTNUMMER als
    // Lauf-Nummer ausgegeben — im Zeitplan stand dann "Dorothea (Lauf 88)".
    // Gilt für beide Lauf-Felder, numerisch wie textuell.
    if (heatCount == null) {
      for (const r of mevRiders) { r.lauf = null; r.laufLabel = null; }
    }

    // Zweiter Guard gegen dieselbe Verwechslung: Eine Lauf-Nummer liegt immer
    // zwischen 1 und der Gesamt-Laufzahl. Eine Startnummer sprengt diesen
    // Bereich fast immer (real: Sprint-Finale mit 2 Läufen, das Modell gab die
    // Startnummer 186 als Lauf aus). Der textuelle laufLabel bleibt erhalten —
    // in genau diesen Dokumenten steht in der Lauf-Spalte "Platz 3/4" o.ä.,
    // was die eigentlich gemeinte Information ist.
    for (const r of mevRiders) {
      if (r.lauf != null && heatCount != null && (r.lauf < 1 || r.lauf > heatCount)) {
        r.lauf = null;
      }
    }

    // startSlot ist nur im Massenstart definiert (Platz in der Ballustrade- bzw.
    // Messlinien-Reihe) und kann nie größer als das Starterfeld sein.
    for (const r of mevRiders) {
      const massStart = r.startPos === 'B' || r.startPos === 'M';
      const outOfRange = r.startSlot != null
        && (r.startSlot < 1 || (starterCount != null && r.startSlot > starterCount));
      if (!massStart || outOfRange) r.startSlot = null;
    }

    // Ausscheidungsfahren: die Rundenzahl steht praktisch nie im Dokument,
    // folgt aber einer festen Formel (Starterzahl × 2) — verlässlicher als ein
    // Textfund, siehe Absprache mit Hauke.
    if (doc.disciplineCode === 'AF' && starterCount != null) {
      roundCount = starterCount * 2;
    }

    await prisma.communiqueDocument.update({
      where: { id: doc.id },
      data: {
        mevNames, mevRiders, hasLvColumn, heatCount, starterCount, roundCount,
        mevAnalyzedAt: new Date(), mevVersion: MEV_ANALYSIS_VERSION,
      } as any,
    });
  } catch (err) {
    // Eine fehlgeschlagene Analyse darf den restlichen Poll-Zyklus nicht abbrechen —
    // das Dokument bleibt einfach unanalysiert (mevAnalyzedAt bleibt null) und wird
    // beim nächsten Zyklus erneut versucht.
    console.error(`MEV-Analyse fehlgeschlagen für ${doc.fileName}:`, err);
  }
}
