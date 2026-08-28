import type { DocType, Discipline, SourceType } from '@prisma/client';
import Anthropic from '@anthropic-ai/sdk';
import prisma from '../prisma';
import { fetchDocumentFile } from './remoteSource';
import { getSettings } from './settings';
import { detectDiscipline } from './classify';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

/**
 * Auswertung abfotografierter Kommuniqués.
 *
 * Anlass: Kommt ein Aushang aus einer WhatsApp-Gruppe, heißt die Datei
 * "IMG-20260919-WA0037.jpg" und gibt über ihren Namen nichts her. Die gesamte
 * Zuordnungslogik der App hängt aber am Dateinamen. Statt trackside jede Datei
 * von Hand umzubenennen, wird hier der KOPF DES DOKUMENTS gelesen — dort steht
 * ohnehin alles, was gebraucht wird, und zwar zuverlässiger als in einem
 * Etikett.
 *
 * Für PDFs ändert sich nichts: die laufen weiter über classify.ts.
 *
 * ── Aufbau echter Kommuniqués ───────────────────────────────────────────────
 * Geprüft an Kommuniqués der DM Büttgen 2026. Der Kopf sieht so aus:
 *
 *   weibl. Jugend   powered by ...            Kommunique:   26-02
 *   2000 m Einerverfolgung                    Ergebnis / results
 *
 *   weibl. Jugend   powered by ...            Kommunique:   34-02
 *   Sprint          Qualifikation             Ergebnis
 *
 *                                             Kommunique 68-06
 *   weibl. Jugend   powered by ...   Finale   Ergebnis
 *   Punktefahren    12,5km / 50 Runden / 5 Wertungen
 *
 * Drei Dinge daraus, die der Prompt berücksichtigen muss:
 *   1. Die Altersklasse steht in LANGFORM ("weibl. Jugend"), nicht als "U17w".
 *   2. Die Nummer steht OHNE "K" und mit Unternummer ("Kommunique: 26-02").
 *   3. Phase und Art stehen mal nebeneinander, mal in verschiedenen Zeilen —
 *      bei Punktefahren sogar oberhalb der Disziplinzeile. Deshalb wird
 *      inhaltlich gesucht und nicht nach Position.
 */

/**
 * Version des Auswertungs-Prompts. Wird am Dokument gespeichert; der Poll wertet
 * jedes Bild mit kleinerer Version automatisch neu aus. Bei JEDER inhaltlichen
 * Änderung am Prompt hochzählen — sonst behalten bereits ausgewertete Bilder ihr
 * altes Ergebnis.
 */
export const IMAGE_ANALYSIS_VERSION = 1;

/**
 * Bildformate, die das Modell lesen kann.
 *
 * HEIC/HEIF fehlt hier bewusst und ist KEIN Versehen: iPhone-Aufnahmen liegen
 * in diesem Format vor, das Modell nimmt es nicht an. Eine Umwandlung im
 * Backend bräuchte eine zusätzliche Bibliothek. In der Praxis fällt das kaum
 * ins Gewicht, weil WhatsApp beim Versenden ohnehin in JPEG umwandelt — nur wer
 * direkt aus der Fotos-App in den Ordner teilt, kann eine HEIC-Datei erzeugen.
 * Solche Bilder werden angezeigt, aber nicht ausgewertet; die Zuordnung erfolgt
 * dann von Hand.
 */
const ANALYZABLE_MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const;
type AnalyzableMediaType = typeof ANALYZABLE_MEDIA_TYPES[number];

/** Obergrenze für ein einzelnes Bild (Rohbytes). Darüber weist das Modell ab. */
const MAX_IMAGE_BYTES = 4_500_000;

export interface ImageClassification {
  communiqueNumber: string | null; // normalisiert als "K68-05"
  ak: string;                      // "U17w", "Elite m", "Alle"
  disciplineCode: string | null;   // "PR", "EV", "MV", "TS", "OM", "TR", "VF"
  disciplineName: string | null;   // Klartext für die Anzeige, z.B. "Punktefahren"
  phaseLabel: string | null;       // "Finale", "Qualifikation", "1. Vorlauf"
  docType: DocType;
  discipline: Discipline;          // SPRINT / AUSDAUER / ALLGEMEIN
  confident: boolean;
}

interface AnalyzableImageDoc {
  id: string;
  fileName: string;
  remoteUrl?: string | null;
}

/** True, wenn der Dateiname auf ein Bild hindeutet (analysierbar oder nicht). */
export function isImageFileName(fileName: string): boolean {
  return /\.(jpe?g|png|webp|gif|hei[cf])$/i.test(fileName);
}

/** True, wenn das Bildformat vom Modell gelesen werden kann. */
export function isAnalyzableImage(fileName: string): boolean {
  return /\.(jpe?g|png|webp|gif)$/i.test(fileName);
}

function mediaTypeFor(fileName: string): AnalyzableMediaType | null {
  const lower = fileName.toLowerCase();
  if (/\.jpe?g$/.test(lower)) return 'image/jpeg';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif')) return 'image/gif';
  return null;
}

/**
 * Normalisiert die Kommuniqué-Nummer aus dem Dokumentkopf auf die Schreibweise,
 * die auch in Dateinamen steht: "26-02" → "K26-02". Damit greift
 * parseCommuniqueVersion() unverändert und Fotos können ältere Fassungen
 * desselben Aushangs genauso verdrängen wie PDFs.
 */
function normalizeCommuniqueNumber(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const m = raw.trim().match(/^K?\s*(\d+)(?:\s*-\s*0*(\d+))?\s*([A-Za-z]?)$/);
  if (!m) return null;
  const block = parseInt(m[1], 10);
  if (!Number.isFinite(block)) return null;
  const seq = m[2] ? `-${m[2].padStart(2, '0')}` : '';
  return `K${block}${seq}${(m[3] ?? '').toUpperCase()}`;
}

const VALID_DOC_TYPES: DocType[] = ['STARTLISTE', 'ERGEBNIS', 'ZEITPLAN', 'SONSTIGES'];
const VALID_CODES = ['PR', 'MA', 'OM', 'TR', 'MV', 'EV', 'VF', 'TS'];

/**
 * Baut den Anzeigenamen. Bewusst nicht wie ein Dateiname, sondern lesbar:
 *   "K68-05 · Punktefahren Finale · Ansetzung"
 * Fehlende Teile fallen einfach weg.
 */
export function buildDisplayName(c: ImageClassification, fallback: string): string {
  const mitte = [c.disciplineName, c.phaseLabel].filter(Boolean).join(' ');
  const art = c.docType === 'STARTLISTE' ? 'Ansetzung'
    : c.docType === 'ERGEBNIS' ? 'Ergebnis'
    : c.docType === 'ZEITPLAN' ? 'Zeitplan'
    : null;
  const teile = [c.communiqueNumber, mitte || null, art].filter(Boolean);
  // Ohne Nummer UND ohne Disziplin ist nichts Brauchbares erkannt worden —
  // dann bleibt der Dateiname stehen, statt ein nichtssagendes Etikett zu
  // erzeugen, das echte Information vortäuscht.
  if (!c.communiqueNumber && !mitte) return fallback;
  return teile.join(' · ');
}

/**
 * Wertet ein Bild aus und liefert die Klassifizierung — oder null, wenn das
 * nicht möglich war (falsches Format, zu groß, Modellfehler, unlesbar).
 * Wirft nicht: der Poll darf an einem einzelnen Foto nicht scheitern.
 */
export async function classifyImageDocument(
  doc: AnalyzableImageDoc,
  source: { sourceType: SourceType; shareToken: string | null },
): Promise<ImageClassification | null> {
  const mediaType = mediaTypeFor(doc.fileName);
  if (!mediaType) return null;

  try {
    const file = await fetchDocumentFile(source, {
      fileName: doc.fileName,
      remoteUrl: doc.remoteUrl ?? null,
    });
    if (file.data.length > MAX_IMAGE_BYTES) {
      console.warn(`[imageClassify] ${doc.fileName}: ${Math.round(file.data.length / 1024)} kB — zu groß, übersprungen`);
      return null;
    }

    const settings = await getSettings();
    const hint = (settings.docRecognitionHint ?? '').trim();
    const hintBlock = hint ? `\n\nZusätzlicher Hinweis zu dieser Veranstaltung:\n${hint}` : '';

    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: mediaType, data: file.data.toString('base64') },
          } as any,
          {
            type: 'text',
            text: `Dies ist das Foto eines Kommuniqués (Aushang) einer Bahnrad-Veranstaltung.
Lies den KOPFBEREICH des Dokuments und gib die Zuordnung zurück.

Der Kopf sieht typischerweise so aus:
  weibl. Jugend   powered by ...            Kommunique:   26-02
  2000 m Einerverfolgung                    Ergebnis / results

Die Angaben können auch anders angeordnet sein (Phase und Art in einer anderen
Zeile als die Disziplin). Suche inhaltlich, nicht nach Position.

Altersklasse: steht meist AUSGESCHRIEBEN. Übersetze so:
  "weibl. Jugend" / "weibliche Jugend"   -> "U17w"
  "männl. Jugend" / "männliche Jugend"   -> "U17m"
  "Juniorinnen"                          -> "U19w"
  "Junioren"                             -> "U19m"
  "Schülerinnen"                         -> "U15w"
  "Schüler"                              -> "U15m"
  "Frauen" / "Elite Frauen"              -> "Elite w"
  "Männer" / "Elite Männer"              -> "Elite m"
Steht dort bereits ein Kürzel wie "U17w", übernimm es unverändert.
Gilt das Dokument für alle Klassen (z.B. ein Zeitplan), gib "Alle" zurück.

Kommuniqué-Nummer: steht als "Kommunique: 26-02" o.ä., meist oben rechts.
Gib sie genau so zurück, wie sie dasteht (also "26-02"), ohne "K".

Disziplin-Kürzel, falls erkennbar:
  PR = Punktefahren, MA = Madison/Zweiermannschaft, OM = Omnium,
  TR = Temporunden, MV = Mannschaftsverfolgung, EV = Einer-/Einzelverfolgung,
  VF = sonstige Verfolgung, TS = Teamsprint.
Sprint, Keirin, Zeitfahren und Ausscheidungsfahren haben KEIN Kürzel -> null.

Art des Dokuments:
  STARTLISTE = Ansetzung, Startliste, Meldeliste (Fahrer VOR dem Rennen)
  ERGEBNIS   = Ergebnis, Resultat, Wertung, Endstand
  ZEITPLAN   = Zeitplan der Veranstaltung
  SONSTIGES  = alles andere

Setze "confident" auf false, wenn das Foto unscharf, angeschnitten oder schräg
ist, wenn der Kopfbereich nicht vollständig zu sehen ist, oder wenn du bei einer
der Angaben raten musst. Lieber einmal zu oft false als zu selten.${hintBlock}

Gib NUR JSON zurück (kein Markdown, kein Text davor oder danach):
{
  "communiqueNumber": "26-02" oder null,
  "ak": "U17w",
  "disciplineCode": "EV" oder null,
  "disciplineName": "Einerverfolgung" oder null,
  "phaseLabel": "Qualifikation" oder null,
  "docType": "ERGEBNIS",
  "confident": true
}`,
          },
        ],
      }],
    });

    const raw = message.content
      .map((b: any) => (b.type === 'text' ? b.text : ''))
      .join('')
      .replace(/```json|```/g, '')
      .trim();

    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      console.warn(`[imageClassify] ${doc.fileName}: Antwort war kein JSON`);
      return null;
    }

    const docType: DocType = VALID_DOC_TYPES.includes(parsed?.docType)
      ? parsed.docType
      : 'SONSTIGES';
    const disciplineName = typeof parsed?.disciplineName === 'string' && parsed.disciplineName.trim()
      ? parsed.disciplineName.trim()
      : null;
    const disciplineCode = typeof parsed?.disciplineCode === 'string'
      && VALID_CODES.includes(parsed.disciplineCode.toUpperCase())
      ? parsed.disciplineCode.toUpperCase()
      : null;

    return {
      communiqueNumber: normalizeCommuniqueNumber(parsed?.communiqueNumber),
      ak: typeof parsed?.ak === 'string' && parsed.ak.trim() ? parsed.ak.trim() : 'Alle',
      disciplineCode,
      disciplineName,
      phaseLabel: typeof parsed?.phaseLabel === 'string' && parsed.phaseLabel.trim()
        ? parsed.phaseLabel.trim()
        : null,
      docType,
      // Sprint/Ausdauer wird nicht erfragt, sondern aus dem Disziplinnamen
      // abgeleitet — dieselbe Zuordnung wie bei Dateinamen, also garantiert
      // dieselben Ergebnisse für dieselbe Disziplin.
      discipline: detectDiscipline(disciplineName ?? disciplineCode ?? ''),
      confident: parsed?.confident !== false,
    };
  } catch (err) {
    console.warn(`[imageClassify] ${doc.fileName}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Wertet ein Bild aus und schreibt das Ergebnis ans Dokument.
 *
 * Eine von Hand gesetzte Klassifizierung (classificationManual) wird nie
 * überschrieben. Schlägt die Auswertung fehl, wird trotzdem imageAnalyzedAt und
 * imageVersion gesetzt — sonst versuchte der Poll es bei jedem Durchlauf erneut
 * und lüde das Bild jedes Mal neu herunter.
 */
export async function analyzeImageForDocument(
  doc: AnalyzableImageDoc & { classificationManual: boolean },
  source: { sourceType: SourceType; shareToken: string | null },
): Promise<void> {
  if (doc.classificationManual) return;

  const result = await classifyImageDocument(doc, source);

  if (!result) {
    await prisma.communiqueDocument.update({
      where: { id: doc.id },
      data: {
        imageAnalyzedAt: new Date(),
        imageVersion: IMAGE_ANALYSIS_VERSION,
        imageConfident: false,
      },
    });
    return;
  }

  await prisma.communiqueDocument.update({
    where: { id: doc.id },
    data: {
      displayName: buildDisplayName(result, doc.fileName),
      communiqueNumber: result.communiqueNumber,
      ak: result.ak,
      discipline: result.discipline,
      disciplineCode: result.disciplineCode,
      phaseLabel: result.phaseLabel,
      docType: result.docType,
      imageAnalyzedAt: new Date(),
      imageVersion: IMAGE_ANALYSIS_VERSION,
      imageConfident: result.confident,
    },
  });
}
