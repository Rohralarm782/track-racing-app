import type { SourceType } from '@prisma/client';
import Anthropic from '@anthropic-ai/sdk';
import prisma from '../prisma';
import { fetchDocumentFile } from './remoteSource';
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
export const MEV_ANALYSIS_VERSION = 8;

export interface MevRider {
  name: string;
  /**
   * 0-basierter Index der Startaufstellung, in der dieser Fahrer steht (siehe
   * MevSection). Bei Dokumenten mit nur einer Startaufstellung immer 0.
   */
  section: number;
  lauf: number | null;
  laufLabel: string | null;
  startSlot: number | null;
  team: string | null;
  startNo: number | null;
  startPos: string | null;
  startOrder: number | null;
}

/**
 * Eine von mehreren Startaufstellungen INNERHALB einer Datei. Real (DM 2026):
 * "R13-R14 Ansetzung Punktefahren U15m.pdf" enthält den A-Lauf (R14) und den
 * B-Lauf (R13) — zwei getrennte Rennen, zwei getrennte Zeitplan-Einträge.
 *
 * Reihenfolge = Reihenfolge IM DOKUMENT, nicht nach Lauf-Nummer: in besagter
 * Datei steht R14 vor R13. Deshalb wird die Zuordnung nie aus der Position
 * abgeleitet, sondern aus runNo bzw. phaseLabel der Überschrift.
 *
 * Die Fahrer selbst stehen weiterhin gesammelt in mevRiders und tragen dort
 * ihren Abschnitt (MevRider.section) — bewusst keine zweite Liste, damit es
 * für jeden Fahrer genau eine Quelle gibt.
 */
export interface MevSection {
  index: number;
  title: string | null;
  runNo: number | null;
  phaseLabel: string | null;
  heatCount: number | null;
  starterCount: number | null;
  roundCount: number | null;
}

// Was analyzeMevForDocument vom Dokument braucht — deckungsgleich mit dem
// Prisma-Modell, damit Aufrufer einfach das geladene Dokument durchreichen können.
interface AnalyzableDoc {
  id: string;
  sourceId: string;
  fileName: string;
  ak: string;
  disciplineCode?: string | null;
  remoteUrl?: string | null; // HTML: PDF-Adresse · GDRIVE: Datei-ID · WebDAV: null
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
  source: { sourceType: SourceType; shareToken: string | null },
): Promise<void> {
  // Bilder überspringen. Die Datei wird unten als PDF-Block an das Modell
  // geschickt; ein Foto würde dort abgewiesen. Der Schutz steht bewusst HIER
  // und nicht nur beim Aufrufer, damit auch die manuellen Auslöser (Analyse-
  // Knopf, Verknüpfung im Zeitplan) abgedeckt sind. Das Dokument bleibt
  // sichtbar und nutzbar, es wird nur nicht automatisch ausgewertet.
  if (!/\.pdf$/i.test(doc.fileName)) return;
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

    const file = await fetchDocumentFile(source, { fileName: doc.fileName, remoteUrl: doc.remoteUrl ?? null });
    const base64 = file.data.toString('base64');

    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1500,
      // Ohne diese Angabe arbeitet die Auswertung mit dem Vorgabewert 1.0 und
      // liefert bei JEDEM Durchlauf derselben Datei ein anderes Ergebnis —
      // real aufgetreten (DM Öschelbronn, U15m Verfolgung): vier Neuanalysen
      // desselben Kommuniqués ergaben nacheinander nur Namen, Namen mit
      // Startposition, Namen mit falschen Lauf-Nummern und wieder Namen mit
      // Startposition. 0 macht das Ergebnis reproduzierbar. Es wird dadurch
      // nicht automatisch richtig — aber ohne Reproduzierbarkeit lässt sich
      // eine Verbesserung nicht von Zufall unterscheiden.
      temperature: 0,
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
- ob die Tabelle eine Startreihenfolge-Spalte hat (Überschrift "Pos.", "Position", "Startreihenfolge", "Startfolge" oder "Reihenfolge") — typisch bei "Startreihenfolge 100m fliegend", wo jeder Fahrer einzeln nacheinander startet (siehe startOrder unten)
- ob die Tabelle eine "Team"/"Mannschaft"-Spalte hat (typisch bei Mannschafts-Disziplinen wie Teamsprint, Mannschaftsverfolgung, Madison — dort stehen mehrere Fahrer pro Lauf, gruppiert unter einem Team-Kürzel wie "${lv} 2" oder "${lv} 1")
- die Startposition jedes gefundenen "${lv}"-Fahrers/Teams (siehe startPos unten)
- die Gesamtzahl der Starter/Teams in der Tabelle
- die Rundenzahl für das Rennen. Bei allen Disziplinen AUSSER Ausscheidungsfahren steht diese praktisch immer irgendwo im Dokument, oft in einer Zeile direkt unter der Renn-Überschrift im Format "<Distanz> / <Rundenzahl> Runden / <Anzahl> Wertungen" (z.B. "15km / 60 Runden / 6 Wertungen") — diese Zeile kann auch am Ende des Dokuments wiederholt werden. Manchmal auch anders formuliert, z.B. "Wertung nach 40 Runden" oder als Teil der Renn-Überschrift ("Punktefahren über 40 Runden").${rosterBlock}

ABSCHNITTE — mehrere Startaufstellungen in EINER Datei:
Manche Dateien enthalten MEHRERE vollständige Startaufstellungen, jede mit eigener Überschrift, z.B. "U15m – Startaufstellung Punktefahren A-Lauf (R14)" und weiter unten "U15m – Startaufstellung Punktefahren B-Lauf (R13)". Das sind GETRENNTE Rennen und werden getrennt ausgewertet. Die Überschriften stehen nicht zwingend in aufsteigender Reihenfolge — im genannten Beispiel steht R14 vor R13. Sortiere nichts um.

Gib NUR JSON zurück (kein Markdown, kein Text davor/danach):

{"hasLvColumn":true,"sections":[{"title":"U15m – Startaufstellung Punktefahren A-Lauf (R14)","runNo":14,"phaseLabel":"A-Lauf","heatCount":null,"starterCount":20,"roundCount":40}],"mevRiders":[{"name":"Vorname Nachname","section":0,"startNo":88,"lauf":9,"laufLabel":null,"team":"${lv} 2","startPos":"B","startSlot":10,"startOrder":null}],"heatCount":13,"starterCount":24,"roundCount":40}

Regeln:
- hasLvColumn: true, wenn die Tabelle eine LV-/Landesverband-Spalte hat, sonst false.
  ACHTUNG: Die Spalte heißt nicht immer "LV". Bei Meisterschafts-Ansetzungen stehen
  häufig ZWEI Spalten nebeneinander, die BEIDE mit "Verein" überschrieben sind — die
  erste enthält den ausgeschriebenen Vereinsnamen ("RSC Cottbus"), die zweite ein
  Kurzkürzel aus 2–4 Großbuchstaben ("BRA", "MEV", "NRW", "THÜ"). Die zweite ist die
  LV-Spalte: hasLvColumn true, und daraus den Landesverband lesen.
- sections: ein Eintrag je Startaufstellung, in der Reihenfolge, in der sie IM DOKUMENT stehen. Enthält die Datei nur eine Startaufstellung, hat sections genau EINEN Eintrag.
  * title: die Überschrift der Startaufstellung im Wortlaut
  * runNo: die Programm-/Laufnummer, wenn sie in der Überschrift in Klammern steht ("(R14)" -> 14, "(R3)" -> 3), sonst null. Das ist WEDER eine Lauf-Nummer aus einer Lauf-Spalte NOCH eine Startnummer.
  * phaseLabel: die Phasen-Bezeichnung aus der Überschrift, im Wortlaut — z.B. "A-Lauf", "B-Lauf", "Quali 1", "Quali 2", "1. Vorlauf", "Finale". Steht dort keine, null.
  * heatCount / starterCount / roundCount: wie unten beschrieben, aber jeweils NUR für diesen einen Abschnitt gezählt.
- section: bei JEDEM gefundenen Fahrer der 0-basierte Index seines Abschnitts in sections. Bei nur einer Startaufstellung immer 0. Ein Fahrer, der in zwei Abschnitten steht, wird zweimal aufgeführt — einmal je Abschnitt.
- Alle Zählungen beziehen sich immer nur auf den eigenen Abschnitt: die Startreihen (Ballustrade/Messlinie) des zweiten Abschnitts werden wieder ab 1 gezählt, nicht weitergezählt.
- Die Felder heatCount/starterCount/roundCount AUSSERHALB von sections beziehen sich bei mehreren Abschnitten auf den ERSTEN Abschnitt.
- name: "Vorname Nachname", keine Startnummer/Verein/UCI-ID
- startNo: die Startnummer dieses Fahrers laut Spalte "Start-Nr." o.ä., sonst null
- lauf / laufLabel: beide beziehen sich AUSSCHLIESSLICH auf eine echte Lauf-Spalte der Tabelle (Spaltenüberschrift "Lauf", "Heat", "Paarung" o.ä.). Gibt es keine solche Spalte, sind BEIDE null. Die Startnummer ("Start-Nr.") ist NIEMALS die Lauf-Nummer — verwechsle die beiden Spalten nicht. Auch eine Überschrift wie "Vorlauf 1" über der Tabelle ist KEINE Lauf-Angabe im Sinne dieser Felder: dann beide null.
  * ENTSCHEIDEND ist allein die SPALTENÜBERSCHRIFT: Hat die Tabelle eine mit "Lauf"/"Heat"/"Paarung" überschriebene Spalte, ist das eine echte Lauf-Spalte — AUCH dann, wenn dort nur fortlaufende Zahlen 1, 2, 3 … N stehen und jeder Lauf nur EINEN Fahrer enthält (völlig normal beim Einzel-Zeitfahren, wo jede Fahrerin einzeln startet). Übernimm diese Zahl dann als lauf und zähle heatCount entsprechend. Solche fortlaufenden Zahlen NICHT als bloßen Zeilenindex abtun. Das Verbot oben betrifft ausschließlich Tabellen OHNE Lauf-Spalte, wo sonst fälschlich die Start-Nr. als Lauf herhalten müsste.
  * lauf: der Wert der Lauf-Spalte, wenn er eine reine Zahl ist (z.B. "9" -> 9), sonst null
  * laufLabel: der Text der Lauf-Spalte, wenn er KEINE reine Zahl ist — z.B. bei Sprint-Finals steht dort "Platz 1/2" bzw. "Platz 3/4", bei Hoffnungsläufen o.ä. auch anderer Text. Wortlaut aus dem Dokument übernehmen (Zeilenumbrüche in der Zelle als Leerzeichen). Ist der Wert eine reine Zahl, dann null.
  * Ein Fahrer hat also entweder lauf ODER laufLabel gesetzt, nie beides.
- team: der Wert aus der Team-/Mannschaft-Spalte (z.B. "${lv} 2"), falls eine solche Spalte existiert, sonst null. NICHT der Vereinsname aus der "Verein"-Spalte — das Team-Kürzel besteht meist aus Landesverband-Kürzel + Nummer.
  * SONDERFALL Madison: Hat die Tabelle eine Spalte "Mad.Nr." mit Werten wie "5R"/"5S"
    (Zahl + R für rote bzw. S für schwarze Rückennummer), so ist die ZAHL die Team-Nummer
    — beide Fahrer eines Teams bekommen denselben team-Wert, nämlich diese Zahl als Text
    ("5"). Die Mad.Nr. ist dabei WEDER eine Start-Nr. NOCH eine Lauf-Nummer: steht keine
    eigene "Startnr."-Spalte daneben, ist startNo null, und lauf/laufLabel bleiben null,
    solange es keine echte Lauf-Spalte gibt.
- Bei Team-Paaren/Mannschaften (z.B. Madison, Teamsprint, Mannschaftsverfolgung) ALLE Fahrer des Teams einzeln auflisten, falls einer oder mehrere "${lv}" sind; alle bekommen denselben lauf- und team-Wert
- startPos: die Startposition dieses Fahrers/Teams. Genau einer dieser vier Werte oder null:
  * Einzelstart-Formate (Zeitfahren, Einzel-/Mannschaftsverfolgung — je nach Format EIN oder ZWEI Starter pro Lauf; beim 1000m-Zeitfahren startet oft nur eine Fahrerin pro Lauf, das ist normal und macht die Lauf-Spalte nicht ungültig): "ZG" (Zielgerade) oder "GG" (Gegengerade). Die Zuordnung steht NICHT in der Tabelle, sondern in einem Hinweissatz unter der Tabelle, z.B. "Die erstgenannte Fahrerin startet von der Zielgeraden". Diesen Satz wörtlich auswerten und auf die Zeilen-Reihenfolge INNERHALB des Laufs anwenden: bei dieser Formulierung startet der im Lauf zuerst genannte Fahrer von "ZG", der zweite (falls vorhanden) von "GG". Steht dort stattdessen "Gegengeraden", gilt es genau umgekehrt. Fehlt der Hinweissatz, ist die Position unbekannt -> null.
  * Massenstart-Formate (Punktefahren, Madison, Scratch, Ausscheidungsfahren): "B" (Ballustrade/Balustrade) oder "M" (Messlinie/Mess-linie). Die Startaufstellung besteht dort aus ZWEI nebeneinander oder untereinander stehenden Tabellen bzw. einer Spalte mit genau diesen Überschriften — maßgeblich ist, in welcher der beiden der Fahrer steht. Die zweite Tabelle kann auch "Cote d'Azur" überschrieben sein — das ist die Messlinien-Gruppe -> "M".
    HARTE VORBEDINGUNG: "B"/"M" nur, wenn diese Überschriften bzw. die zwei getrennten Startreihen im Dokument WÖRTLICH vorkommen. Eine einzige durchlaufende Startaufstellung ohne solche Überschriften (real: "U17m – Startaufstellung Madison Quali 2" mit den Spalten Mad.Nr./Name/Vorname/UCI-ID/Verein/LV) enthält KEINE Startposition -> startPos null UND startSlot null. Nicht raten, nur weil es ein Massenstart-Rennen ist.
  * In allen anderen Fällen: null
- startSlot: NUR bei Massenstart (startPos "B" oder "M"): die Position des Fahrers INNERHALB seiner Startreihe, also die 1-basierte Zeilennummer in genau der Tabelle, in der er steht (erste Zeile der Ballustrade-Tabelle = 1, zweite = 2, usw.; die Messlinien-/Cote-d'Azur-Tabelle wird separat ab 1 gezählt). Leerzeilen am Tabellenende nicht mitzählen. Gibt es eine eigene, GEFÜLLTE Positions-Spalte, deren Wert verwenden. Bei Einzelstart (startPos "ZG"/"GG") und wenn startPos null ist: immer null.
  Niemals aus der Zeilenreihenfolge der gefundenen "${lv}"-Fahrer ableiten (also nicht 1, 2, 3 … über die Treffer hinweg durchzählen) und niemals aus dem R/S-Suffix einer Mad.Nr.: die zwei Fahrer eines Madison-Teams belegen EINEN Startplatz, nicht zwei. Bei Team-Disziplinen haben deshalb alle Fahrer eines Teams denselben startSlot — oder null.
- startOrder: der Platz dieses Fahrers in der Startreihenfolge, also der Wert der mit "Pos."/"Position"/"Startreihenfolge"/"Startfolge"/"Reihenfolge" überschriebenen Spalte (1-basiert, 1 = startet zuerst). Das ist WEDER die Start-Nr. NOCH die Mad.Nr. NOCH eine Lauf-Nummer. Gibt es keine solche Spalte: null.
  * Typischer Fall: "Startreihenfolge 100m fliegend" — jeder Fahrer fährt allein, die Tabelle hat "Pos." und "Startnr." nebeneinander. Dann ist startOrder der Wert aus "Pos." und startNo der Wert aus "Startnr.".
  * NUR in Startlisten/Ansetzungen/Startreihenfolgen. In einer ERGEBNIS-Liste ist eine Spalte "Pl."/"Pos."/"Rang" die PLATZIERUNG und niemals eine Startreihenfolge -> dann startOrder null.
  * Hat die Tabelle zusätzlich eine echte Lauf-Spalte, dürfen lauf und startOrder beide gefüllt sein.
- heatCount: Gesamtzahl unterschiedlicher Werte in der Lauf-Spalte der GESAMTEN Tabelle (nicht nur bei "${lv}"-Zeilen) — Text-Werte wie "Platz 1/2" zählen genauso mit wie Zahlen. Leerzeilen ohne Fahrer am Tabellenende (z.B. eine vornummerierte Zeile "10." ohne Namen) NICHT mitzählen. null, falls die Tabelle keine Lauf-Spalte hat.
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
            // Abschnitt (Startaufstellung), in dem der Fahrer steht. Fehlt die
            // Angabe oder ist sie unbrauchbar, gilt der erste Abschnitt — das
            // entspricht dem bisherigen Verhalten bei einteiligen Dokumenten.
            section: typeof r.section === 'number' && r.section >= 0 ? Math.trunc(r.section) : 0,
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
            // Platz in der Startreihenfolge ("Pos."-Spalte, z.B. bei
            // "Startreihenfolge 100m fliegend") — Bereichsprüfung unten.
            startOrder: typeof r.startOrder === 'number' ? r.startOrder : null,
          }))
      : [];
    const hasLvColumn = typeof parsed?.hasLvColumn === 'boolean' ? parsed.hasLvColumn : null;
    const heatCount = typeof parsed?.heatCount === 'number' ? parsed.heatCount : null;
    const starterCount = typeof parsed?.starterCount === 'number' ? parsed.starterCount : null;
    const roundCount = typeof parsed?.roundCount === 'number' ? parsed.roundCount : null;
    // ── Abschnitte ────────────────────────────────────────────────────────
    // Eine Datei kann mehrere Startaufstellungen enthalten (siehe MevSection).
    // Liefert das Modell keine oder nur eine, wird daraus EIN Abschnitt aus den
    // Top-Level-Zahlen gebaut — damit die Auswertung unten für einteilige und
    // mehrteilige Dokumente identisch läuft.
    const rawSections: any[] = Array.isArray(parsed?.sections) ? parsed.sections : [];
    const sections: MevSection[] = rawSections.length >= 2
      ? rawSections.map((sec: any, i: number) => ({
          index: i,
          title: typeof sec?.title === 'string' && sec.title.trim()
            ? sec.title.trim().replace(/\s+/g, ' ').slice(0, 120) : null,
          runNo: typeof sec?.runNo === 'number' ? sec.runNo : null,
          phaseLabel: typeof sec?.phaseLabel === 'string' && sec.phaseLabel.trim()
            ? sec.phaseLabel.trim().replace(/\s+/g, ' ').slice(0, 40) : null,
          heatCount: typeof sec?.heatCount === 'number' ? sec.heatCount : null,
          starterCount: typeof sec?.starterCount === 'number' ? sec.starterCount : null,
          roundCount: typeof sec?.roundCount === 'number' ? sec.roundCount : null,
        }))
      : [{ index: 0, title: null, runNo: null, phaseLabel: null, heatCount, starterCount, roundCount }];

    // Ein Fahrer außerhalb des gültigen Bereichs landet im ersten Abschnitt,
    // statt die Auswertung mit undefined zu sprengen.
    for (const r of mevRiders) {
      if (r.section >= sections.length) r.section = 0;
    }
    // Abschnitts-Grenzwerte für die Prüfungen unten. Entscheidend ist, dass
    // NICHT mehr die Zahlen des ganzen Dokuments gelten: der zweite Lauf hat
    // sein eigenes Starterfeld und seine eigene Laufzahl.
    const secOf = (r: MevRider): MevSection => sections[r.section] ?? sections[0];

    const mevNames = mevRiders.map(r => r.name); // Abwärtskompatibilität

    // Schutz gegen eine wiederkehrende Verwechslung: Ohne Lauf-Spalte gibt es
    // keine heatCount — dann darf auch kein Fahrer eine Lauf-Nummer haben. Das
    // Modell hat in solchen Dokumenten (z.B. Vorlauf-Ansetzungen im Massenstart,
    // die nur Start-Nr./Name/Vorname enthalten) sonst gern die STARTNUMMER als
    // Lauf-Nummer ausgegeben — im Zeitplan stand dann "Dorothea (Lauf 88)".
    // Gilt für beide Lauf-Felder, numerisch wie textuell.
    for (const r of mevRiders) {
      if (secOf(r).heatCount == null) { r.lauf = null; r.laufLabel = null; }
    }

    // Zweiter Guard gegen dieselbe Verwechslung: Eine Lauf-Nummer liegt immer
    // zwischen 1 und der Gesamt-Laufzahl. Eine Startnummer sprengt diesen
    // Bereich fast immer (real: Sprint-Finale mit 2 Läufen, das Modell gab die
    // Startnummer 186 als Lauf aus). Der textuelle laufLabel bleibt erhalten —
    // in genau diesen Dokumenten steht in der Lauf-Spalte "Platz 3/4" o.ä.,
    // was die eigentlich gemeinte Information ist.
    for (const r of mevRiders) {
      const hc = secOf(r).heatCount;
      if (r.lauf != null && hc != null && (r.lauf < 1 || r.lauf > hc)) {
        r.lauf = null;
      }
    }

    // startSlot ist nur im Massenstart definiert (Platz in der Ballustrade- bzw.
    // Messlinien-Reihe) und kann nie größer als das Starterfeld sein.
    for (const r of mevRiders) {
      const sc = secOf(r).starterCount;
      const massStart = r.startPos === 'B' || r.startPos === 'M';
      const outOfRange = r.startSlot != null
        && (r.startSlot < 1 || (sc != null && r.startSlot > sc));
      if (!massStart || outOfRange) r.startSlot = null;
    }

    // Bei Mannschafts-Disziplinen gehört die Startposition dem TEAM, nicht dem
    // einzelnen Fahrer: die zwei Fahrer eines Madison-Teams belegen EINEN Platz.
    // Unterschiedliche startSlot-Werte innerhalb eines Teams sind damit sicher
    // falsch. Real (DM 2026, "U17m Startaufstellung Madison Quali 2"): das Modell
    // hat die gefundenen Fahrer einfach durchgezählt — Team 20 -> 1 und 2, in
    // einem anderen Lauf Team 28 -> 1 und 2, Team 29 -> 3 und 4 — obwohl das
    // Dokument gar keine Startpositions-Spalte hat. Im Zeitplan stand dann
    // "MEV: 20 (B 1)". In dem Fall die Position fürs ganze Team verwerfen statt
    // zu raten; das erfundene "B" fällt mit weg.
    // Schlüssel enthält den Abschnitt: dieselbe Team-Nummer kann im A-Lauf und
    // im B-Lauf desselben Dokuments vorkommen, ohne dass das ein Widerspruch wäre.
    const teamKey = (r: MevRider) => `${r.section}|${r.team}`;
    const slotsByTeam = new Map<string, Set<number>>();
    for (const r of mevRiders) {
      if (r.team == null || r.startSlot == null) continue;
      const k = teamKey(r);
      if (!slotsByTeam.has(k)) slotsByTeam.set(k, new Set());
      slotsByTeam.get(k)!.add(r.startSlot);
    }
    for (const r of mevRiders) {
      if (r.team == null) continue;
      if ((slotsByTeam.get(teamKey(r))?.size ?? 0) > 1) { r.startSlot = null; r.startPos = null; }
    }

    // Die Startreihenfolge ist ein Platz im Starterfeld: 1 bis Starterzahl. Eine
    // Startnummer oder eine Platzierung aus einer Ergebnisliste sprengt diesen
    // Bereich meist; zusätzlich greift die Anzeige-Regel im Zeitplan.
    for (const r of mevRiders) {
      const sc = secOf(r).starterCount;
      if (r.startOrder != null
        && (r.startOrder < 1 || (sc != null && r.startOrder > sc))) {
        r.startOrder = null;
      }
    }

    // Ausscheidungsfahren: die Rundenzahl steht praktisch nie im Dokument,
    // folgt aber einer festen Formel (Starterzahl × 2) — verlässlicher als ein
    // Textfund, siehe Absprache mit Hauke. Je Abschnitt gerechnet: bei
    // "R09-R10 Ansetzung Ausscheidungsfahren U15m" haben die beiden Läufe
    // unterschiedlich große Starterfelder und damit unterschiedliche Rundenzahlen.
    if (doc.disciplineCode === 'AF') {
      for (const sec of sections) {
        if (sec.starterCount != null) sec.roundCount = sec.starterCount * 2;
      }
    }

    // Die Felder AM DOKUMENT (heatCount/starterCount/roundCount) bleiben
    // erhalten und tragen die Werte des Abschnitts mit den meisten MEV-Fahrern
    // — bei Gleichstand des ersten. Damit laufen Dauer-Schätzung und alle
    // Ansichten, die den Abschnitt nicht kennen, unverändert weiter; die
    // abschnittsgenaue Anzeige läuft über sections (siehe routes/schedule.ts).
    const leadSection = sections.reduce((best, sec) => {
      const n = mevRiders.filter(r => r.section === sec.index).length;
      const bestN = mevRiders.filter(r => r.section === best.index).length;
      return n > bestN ? sec : best;
    }, sections[0]);

    // Nur mehrteilige Dokumente bekommen sections gespeichert. Ein leeres Array
    // heißt an jeder auswertenden Stelle: ein Rennen je Dokument, alles wie bisher.
    const storedSections = sections.length >= 2 ? sections : [];

    await prisma.communiqueDocument.update({
      where: { id: doc.id },
      data: {
        mevNames, mevRiders, hasLvColumn,
        heatCount: leadSection.heatCount,
        starterCount: leadSection.starterCount,
        roundCount: leadSection.roundCount,
        sections: storedSections,
        mevAnalyzedAt: new Date(), mevVersion: MEV_ANALYSIS_VERSION,
      } as any,
    });
  } catch (err) {
    // Eine fehlgeschlagene Analyse darf den restlichen Poll-Zyklus nicht abbrechen.
    console.error(`MEV-Analyse fehlgeschlagen für ${doc.fileName}:`, err);
    // mevAnalyzedAt/mevVersion trotzdem stempeln — wie bei classifyImageDocument
    // in imageClassify.ts (dort mit derselben Begründung). Ohne diesen Stempel
    // bleibt starterCount null, und der Poll-Trigger in communiques.ts würde
    // dieselbe Datei alle 90 Sekunden erneut vollständig herunterladen und ans
    // Modell schicken — mit temperature: 0 liefert ein Wiederholungsversuch fast
    // immer denselben Fehlschlag, kauft also keine zweite Chance, kostet aber
    // jedes Mal Token. Ein echter Zufallsfehler (Timeout, kurzer API-Ausfall)
    // bleibt über den "Neu analysieren"-Knopf (reanalyze-mev-Route) jederzeit von
    // Hand nachholbar; dieser Weg prüft explizit ohne Rücksicht auf den Stempel.
    try {
      await prisma.communiqueDocument.update({
        where: { id: doc.id },
        data: { mevAnalyzedAt: new Date(), mevVersion: MEV_ANALYSIS_VERSION },
      });
    } catch (updateErr) {
      console.error(`MEV-Analyse: Fehlschlag konnte nicht vermerkt werden für ${doc.fileName}:`, updateErr);
    }
  }
}
