import { z } from 'zod';
import Anthropic from '@anthropic-ai/sdk';
import prisma from '../prisma';
import { fetchShareFile } from './webdav';
import { parseCommuniqueNumber } from './classify';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Zeitplan-PDF-Analyse ───────────────────────────────────────────────────
// Gemeinsam genutzt vom manuellen Import (ScheduleImport.tsx → POST
// .../schedule/analyze, mit anschließender Vorschau/Korrektur durch den
// Nutzer) UND vom automatischen Import neu entdeckter Zeitplan-Kommuniqués
// (siehe autoImportScheduleFromDocument unten, ohne Vorschau).

const ZEITPLAN_PROMPT = `Analysiere diesen Zeitplan einer Bahnrad-Veranstaltung (kann mehrere Tage umfassen).
Gib NUR JSON zurück (kein Markdown, kein Text davor/danach):

{"entries":[{"day":1,"dayLabel":"Mittwoch","time":"17:00","ak":"U17m","disciplineLabel":"Punktefahren","phase":"Vorläufe","type":"RACE","massStart":true}]}

Regeln:
- day: 1 = erster im Dokument vorkommender Veranstaltungstag, 2 = zweiter usw. (Reihenfolge im Dokument, nicht das Kalenderdatum selbst — manche Zeitplan-Dokumente haben fehlerhafte/inkonsistente Jahresangaben, das ist irrelevant, nur die Reihenfolge und Uhrzeit zählen)
- dayLabel: der Wochentag dieses Tages als Klartext (z.B. "Mittwoch"), so wie im Dokument angegeben (z.B. aus einer Überschrift wie "Mittwoch, 02.07.2025"). Alle Einträge desselben Tages bekommen denselben dayLabel-Wert. Falls kein Wochentag erkennbar ist, weglassen.
- time: Uhrzeit im Format "HH:MM", so wie im Dokument angegeben
- ak: Altersklasse normalisiert (z.B. "U17m", "U15w", "Elite m"); falls ein Eintrag mehrere Altersklassen gleichzeitig betrifft (z.B. kombinierte Teamsprint-Wertung über zwei Altersklassen), alle betroffenen Altersklassen durch ein Leerzeichen getrennt in aufsteigender Reihenfolge angeben (z.B. "U17w U19w"), NICHT "Mehrere" verwenden
- disciplineLabel: Disziplin als Klartext (z.B. "Punktefahren", "Madison", "Omnium Scratch", "3000m Mannschaftsverfolgung")
- phase: Phasen-Bezeichnung falls vorhanden (z.B. "1. Vorlauf", "Finale", "A-Lauf", "Qualifikation"), sonst weglassen
- type: "RACE" für Wettkämpfe, "CEREMONY" für Siegerehrungen, "INFO" für Warm-Up/Pausen/Ende-Hinweise
- massStart: true bei Massenstart-Formaten (Punktefahren, Madison, Scratch, Ausscheidungsfahren, Temporunden), false bei Einzelstart-Formaten (Zeitfahren, Verfolgung, Sprint)
- Reihenfolge der Einträge im JSON muss der zeitlichen Reihenfolge im Dokument entsprechen
- Nur JSON, sonst nichts`;

// Rohe, unvalidierte Einträge — für den manuellen Import 1:1 an die
// Vorschau-UI durchgereicht, wo der Nutzer noch korrigieren kann, bevor
// POST /schedule sie streng validiert (siehe ScheduleEntryInputSchema unten).
export async function analyzeZeitplanPdf(pdfBase64: string): Promise<any[]> {
  const message = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 8000,
    messages: [{
      role: 'user',
      content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } } as any,
        { type: 'text', text: ZEITPLAN_PROMPT },
      ],
    }],
  });

  const text = (message.content.find((c: any) => c.type === 'text') as any)?.text ?? '{}';
  const clean = text.replace(/```json\n?|```/g, '').trim();
  const parsed = JSON.parse(clean);
  return Array.isArray(parsed?.entries) ? parsed.entries : [];
}

export const ScheduleEntryInputSchema = z.object({
  day: z.number().int().min(1),
  dayLabel: z.string().nullable().optional(),
  time: z.string(),
  ak: z.string(),
  disciplineLabel: z.string(),
  phase: z.string().nullable().optional(),
  type: z.enum(['RACE', 'CEREMONY', 'INFO']).default('RACE'),
  massStart: z.boolean().default(false),
});

function normalizeLabel(s: string): string {
  return s.toLowerCase().trim();
}

const WEEKDAY_ORDER: Record<string, number> = {
  montag: 1, dienstag: 2, mittwoch: 3, donnerstag: 4, freitag: 5, samstag: 6, sonntag: 7,
};

function weekdaySortKey(label: string | null): number | null {
  if (!label) return null;
  return WEEKDAY_ORDER[normalizeLabel(label)] ?? null;
}

// Nummeriert alle Tage der Veranstaltung anhand des erkannten Wochentags neu
// durch — statt der Reihenfolge, in der die Dokumente zufällig importiert
// wurden. Behebt z.B. den Fall, dass "Sonntag" vor "Freitag" aus einem
// Kommuniqué importiert wurde und dadurch fälschlich eine niedrigere
// Tagesnummer (und damit auch eine falsche Gesamt-Reihenfolge, siehe
// order-Feld) bekommen hätte. Tage OHNE erkanntes dayLabel (z.B. alte, vor
// Einführung dieses Felds manuell importierte Tage) behalten ihre bisherige
// relative Reihenfolge zueinander und werden VOR den Tagen mit Wochentag-
// Label einsortiert, da sie in der Praxis die frühesten Tage einer
// Veranstaltung sind. Nutzt einen kollisionsfreien Zwischenwert (Offset),
// damit sich beim Ummappen keine zwei Tage kurzzeitig dieselbe Nummer teilen.
async function renumberDaysByWeekday(tx: any, eventId: string): Promise<void> {
  const rows: Array<{ day: number; dayLabel: string | null }> = await tx.scheduleEntry.findMany({
    where: { eventId },
    select: { day: true, dayLabel: true },
    distinct: ['day'],
  });

  const unlabeled = rows.filter(r => weekdaySortKey(r.dayLabel) == null).sort((a, b) => a.day - b.day);
  const labeled = rows
    .filter(r => weekdaySortKey(r.dayLabel) != null)
    .sort((a, b) => weekdaySortKey(a.dayLabel)! - weekdaySortKey(b.dayLabel)!);

  const finalOrder = [...unlabeled, ...labeled];
  const dayNumberMap = new Map<number, number>(); // alte Tagesnummer -> neue Tagesnummer
  finalOrder.forEach((r, i) => dayNumberMap.set(r.day, i + 1));

  const changed = [...dayNumberMap.entries()].filter(([oldDay, newDay]) => oldDay !== newDay);
  if (changed.length === 0) return;

  const OFFSET = 100000;
  for (const [oldDay] of changed) {
    await tx.scheduleEntry.updateMany({ where: { eventId, day: oldDay }, data: { day: oldDay + OFFSET } });
  }
  for (const [oldDay, newDay] of changed) {
    await tx.scheduleEntry.updateMany({ where: { eventId, day: oldDay + OFFSET }, data: { day: newDay } });
  }
}

// ─── Matching-Heuristik ─────────────────────────────────────────────────────
// Drei unabhängige Signale werden zu einem Score addiert. Bei Mehrdeutigkeit
// (zwei gleich gute Treffer) wird lieber gar nicht verknüpft als geraten.
//   1. Disziplin-Kürzel passt zum Klartext im Zeitplan               (+1)
//   2. Phase überschneidet sich als Teilstring                       (+2)
//   3. Rang-Übereinstimmung: innerhalb derselben AK+Disziplin steht
//      die Kommuniqué-Nummer in derselben Reihenfolge wie der         (+3)
//      Zeitplan-Eintrag — robust gegen neue/unbekannte Schreib-
//      varianten der Phase, da rein numerisch und textunabhängig.

const DISCIPLINE_HINTS: Record<string, string[]> = {
  MA: ['madison'],
  PR: ['punktefahren'],
  OM: ['omnium'],
  TR: ['temporunden'],
  VF: ['verfolgung'],
  MV: ['mannschaftsverfolgung'],
  EV: ['einzelverfolgung', 'ev'],
  AF: ['ausscheidungsfahren'],
  SC: ['scratch'],
  ZF: ['zeitfahren'],
  TS: ['teamsprint'],
  SP: ['sprint'],
  KE: ['keirin'],
};

// Kurze Hints (z.B. "ev", "sprint") können sonst versehentlich in einem
// längeren Wort anschlagen, das eine ANDERE Disziplin bezeichnet (z.B.
// "sprint" in "Teamsprint"). Mehrwortige Hints bleiben eine einfache
// Teilstring-Suche, einzelne Wörter werden per Wortgrenze geprüft.
function hasHint(disciplineNorm: string, hint: string): boolean {
  if (hint.includes(' ')) return disciplineNorm.includes(hint);
  return new RegExp(`\\b${hint}\\b`).test(disciplineNorm);
}

// Phasen-Kürzel aus Kommuniqué-Dateinamen auf die von der KI aus dem
// Zeitplan-PDF extrahierten Klartext-Bezeichnungen mappen. Muss VOR dem
// Entfernen der Satzzeichen laufen, da z.B. "1.VL" sonst zu "1vl" ohne
// Wortgrenze verschmilzt und die Regex nicht mehr greift.
const PHASE_ALIASES: Array<[RegExp, string]> = [
  [/\bvl\b/gi, 'vorlauf'],
  [/\bvf\b/gi, 'viertelfinale'],
  [/\bhf\b/gi, 'halbfinale'],
  [/\bquali\b/gi, 'qualifikation'],
];

function normalize(s: string): string {
  let n = s;
  for (const [re, full] of PHASE_ALIASES) n = n.replace(re, full);
  return n.toLowerCase().replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim();
}

// Ermittelt, welchem Disziplin-Kürzel ein Zeitplan-Eintrag (nur als Klartext
// vorhanden) entspricht — für das Rang-Matching, da Einträge selbst kein
// Kürzel haben. Bei Mehrdeutigkeit (mehrere Kürzel passen zufällig) wird
// null zurückgegeben, um keine falsche Gruppierung zu riskieren.
export function inferCodeForEntry(disciplineLabel: string): string | null {
  const norm = normalize(disciplineLabel);
  const matches = Object.entries(DISCIPLINE_HINTS).filter(([, hints]) => hints.some(h => hasHint(norm, h)));
  return matches.length === 1 ? matches[0][0] : null;
}

interface MatchableEntry {
  id: string;
  ak: string;
  disciplineLabel: string;
  phase: string | null;
  order: number;
}
interface MatchableDoc {
  id: string;
  ak: string;
  disciplineCode: string | null;
  phaseLabel: string | null;
  docType: string;
  fileName: string;
}

// Rang (0, 1, 2, …) jedes RACE-Eintrags innerhalb aller Einträge derselben
// Altersklasse+Disziplin, sortiert nach zeitlicher Reihenfolge (order).
function rankEntries(entries: MatchableEntry[]): Map<string, number> {
  const groups = new Map<string, MatchableEntry[]>();
  for (const e of entries) {
    const code = inferCodeForEntry(e.disciplineLabel);
    if (!code) continue;
    const key = `${e.ak}::${code}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(e);
  }
  const rank = new Map<string, number>();
  for (const group of groups.values()) {
    group.sort((a, b) => a.order - b.order);
    group.forEach((e, i) => rank.set(e.id, i));
  }
  return rank;
}

// Rang jedes Dokuments eines bestimmten Typs (STARTLISTE oder ERGEBNIS)
// innerhalb derselben Altersklasse+Disziplin, sortiert nach Kommuniqué-
// Nummer (K-Nummer folgt der Ablaufreihenfolge).
function rankDocs(docs: MatchableDoc[], docType: string): Map<string, number> {
  const groups = new Map<string, MatchableDoc[]>();
  for (const d of docs) {
    if (d.docType !== docType || !d.disciplineCode) continue;
    const key = `${d.ak}::${d.disciplineCode}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(d);
  }
  const rank = new Map<string, number>();
  for (const group of groups.values()) {
    group.sort((a, b) => parseCommuniqueNumber(a.fileName) - parseCommuniqueNumber(b.fileName));
    group.forEach((d, i) => rank.set(d.id, i));
  }
  return rank;
}

function findBestMatch(
  entry: MatchableEntry,
  docs: MatchableDoc[],
  entryRank: number | undefined,
  docRank: Map<string, number>,
  docType: string,
): MatchableDoc | null {
  const candidates = docs.filter(d => d.docType === docType && d.ak === entry.ak);
  if (candidates.length === 0) return null;

  const disciplineNorm = normalize(entry.disciplineLabel);
  const phaseNorm = entry.phase ? normalize(entry.phase) : null;
  const entryCode = inferCodeForEntry(entry.disciplineLabel);

  const scored = candidates
    .map(d => {
      let score = 0;
      if (d.disciplineCode) {
        const hints = DISCIPLINE_HINTS[d.disciplineCode] ?? [];
        if (hints.some(h => hasHint(disciplineNorm, h))) score += 1;
      }
      if (phaseNorm && d.phaseLabel) {
        const dPhaseNorm = normalize(d.phaseLabel);
        if (dPhaseNorm.includes(phaseNorm) || phaseNorm.includes(dPhaseNorm)) score += 2;
      }
      if (entryRank !== undefined && d.disciplineCode === entryCode && docRank.get(d.id) === entryRank) {
        score += 3;
      }
      return { doc: d, score };
    })
    .filter(s => s.score > 0);

  if (scored.length === 0) return null;
  scored.sort((a, b) => b.score - a.score);
  if (scored.length > 1 && scored[1].score === scored[0].score) return null; // uneindeutig — lieber nicht raten
  return scored[0].doc;
}

// Zwei unabhängige Durchläufe: Startliste/Ansetzung (wie bisher) und Ergebnis
// (neu). Jeder Durchlauf hat seinen eigenen Dokumenten-Pool und sein eigenes
// "bereits verknüpft"-Set, da ein Rennen z.B. schon eine Startliste, aber
// noch kein Ergebnis haben kann (oder umgekehrt bei einer Nachmeldung). Das
// Ergebnis wird bewusst NICHT anstelle der Startliste verknüpft, sondern
// zusätzlich (siehe linkedResultDocumentId im Schema) — die MEV-Namen kommen
// weiterhin von der Startliste.
export async function autoMatch(eventId: string) {
  const source = await prisma.communiqueSource.findUnique({ where: { eventId } });
  if (!source) return;

  const [allRaceEntries, docs] = await Promise.all([
    prisma.scheduleEntry.findMany({ where: { eventId, type: 'RACE' } }),
    prisma.communiqueDocument.findMany({ where: { sourceId: source.id } }),
  ]);

  // Ränge werden über ALLE Einträge berechnet (nicht nur die noch offenen),
  // damit die Reihenfolge stabil bleibt, unabhängig davon, was bereits
  // manuell oder in einem früheren Lauf verknüpft wurde.
  const entryRank = rankEntries(allRaceEntries);

  const passes: Array<{ docType: 'STARTLISTE' | 'ERGEBNIS'; field: 'linkedDocumentId' | 'linkedResultDocumentId' }> = [
    { docType: 'STARTLISTE', field: 'linkedDocumentId' },
    { docType: 'ERGEBNIS', field: 'linkedResultDocumentId' },
  ];

  for (const { docType, field } of passes) {
    const alreadyLinked = new Set(
      allRaceEntries.filter(e => e[field]).map(e => e[field] as string)
    );
    const openEntries = allRaceEntries.filter(e => !e[field]);
    const docRank = rankDocs(docs, docType);

    for (const entry of openEntries) {
      const available = docs.filter(d => !alreadyLinked.has(d.id));
      const match = findBestMatch(entry, available, entryRank.get(entry.id), docRank, docType);
      if (match) {
        await prisma.scheduleEntry.update({ where: { id: entry.id }, data: { [field]: match.id } as any });
        alreadyLinked.add(match.id);
      }
    }
  }
}

export function loadScheduleWithLinks(eventId: string) {
  return prisma.scheduleEntry.findMany({
    where: { eventId },
    orderBy: { order: 'asc' },
    include: {
      linkedDocument: {
        select: {
          id: true, fileName: true, mevNames: true, mevRiders: true,
          heatCount: true, roundCount: true, starterCount: true, mevAnalyzedAt: true,
        },
      },
      linkedResultDocument: { select: { id: true, fileName: true } },
    },
  });
}

// ─── Automatischer Import aus einem Zeitplan-Kommuniqué ────────────────────
// Reale Zeitpläne kommen häufig als EIN PDF PRO VERANSTALTUNGSTAG (z.B.
// "Zeitplan Mittwoch.pdf", "Zeitplan Donnerstag.pdf", ...). Im Unterschied
// zum manuellen Import (POST /schedule), der beim Speichern IMMER die
// komplette Liste ersetzt, ersetzt dieser automatische Import NUR die
// Einträge, die zuvor aus genau diesem einen Dokument stammen
// (sourceDocumentId) — andere Tage bleiben unangetastet.
//
// Tages-Auflösung pro lokalem Tag im Analyseergebnis (ein Dokument kann
// mehrere Tage enthalten):
//   1. Wurde dieser Tag schon einmal aus GENAU DIESEM Dokument importiert
//      (Korrektur, z.B. ein aktualisiertes PDF)? → dieselbe Tagesnummer
//      wie beim letzten Mal wiederverwenden.
//   2. Sonst: gibt es bereits einen Tag mit demselben Wochentag-Label
//      (dayLabel), egal woher (manueller Upload ODER ein anderes
//      Dokument)? → dorthin zusammenführen (dessen alte Einträge werden
//      ersetzt) statt einen Dubletten-Tag anzulegen. Das ist der Fix für
//      den Fall "Zeitplan wurde schon einmal per PDF-Upload UND später
//      nochmal aus dem Kommuniqué importiert".
//   3. Sonst: neuer Tag, hinten an die höchste bestehende Nummer angehängt.
export async function autoImportScheduleFromDocument(
  eventId: string,
  doc: { id: string; fileName: string },
  shareToken: string,
): Promise<void> {
  try {
    const file = await fetchShareFile(shareToken, doc.fileName);
    const base64 = file.data.toString('base64');
    const rawEntries = await analyzeZeitplanPdf(base64);

    const entries: z.infer<typeof ScheduleEntryInputSchema>[] = [];
    for (const raw of rawEntries) {
      const r = ScheduleEntryInputSchema.safeParse(raw);
      if (r.success) entries.push(r.data);
    }
    if (entries.length === 0) return;

    await prisma.$transaction(async (tx) => {
      // Welche Tagesnummer(n) hatte DIESES Dokument beim letzten Import?
      const previousByThisDoc = await tx.scheduleEntry.findMany({
        where: { sourceDocumentId: doc.id },
        select: { day: true },
      });
      const previousDayNumbers = [...new Set(previousByThisDoc.map(p => p.day))].sort((a, b) => a - b);
      if (previousByThisDoc.length > 0) {
        await tx.scheduleEntry.deleteMany({ where: { sourceDocumentId: doc.id } });
      }

      // Bestehende Tage der Veranstaltung (nach dem Löschen von oben, damit ein
      // erneuter Import desselben Dokuments sich nicht selbst als "Dublette" sieht).
      const existingDays = await tx.scheduleEntry.findMany({
        where: { eventId },
        select: { day: true, dayLabel: true },
        distinct: ['day'],
      });
      const dayByLabel = new Map<string, number>();
      for (const d of existingDays) {
        if (d.dayLabel) dayByLabel.set(normalizeLabel(d.dayLabel), d.day);
      }
      let nextNewDay = existingDays.length > 0 ? Math.max(...existingDays.map(d => d.day)) + 1 : 1;

      const localDays = [...new Set(entries.map(e => e.day))].sort((a, b) => a - b);
      const resolvedDayFor = new Map<number, number>(); // lokale Tagesnummer im Dokument -> globale Tagesnummer

      localDays.forEach((localDay, idx) => {
        const label = entries.find(e => e.day === localDay)?.dayLabel;
        const normLabel = label ? normalizeLabel(label) : null;

        if (previousDayNumbers[idx] !== undefined) {
          resolvedDayFor.set(localDay, previousDayNumbers[idx]); // Korrektur: alte Nummer behalten
        } else if (normLabel && dayByLabel.has(normLabel)) {
          resolvedDayFor.set(localDay, dayByLabel.get(normLabel)!); // Zusammenführen mit bestehendem Tag
        } else {
          resolvedDayFor.set(localDay, nextNewDay++); // neuer Tag
        }
      });

      // Bei Zusammenführung (Fall 2) die alten Einträge des übernommenen Tages
      // (z.B. aus einem manuellen Upload, sourceDocumentId=null) entfernen,
      // damit sie nicht neben den frischen bestehen bleiben.
      const mergedDayNumbers = [...new Set(resolvedDayFor.values())].filter(
        gday => !previousDayNumbers.includes(gday)
      );
      if (mergedDayNumbers.length > 0) {
        await tx.scheduleEntry.deleteMany({ where: { eventId, day: { in: mergedDayNumbers } } });
      }

      await tx.scheduleEntry.createMany({
        data: entries.map(e => ({
          eventId,
          day: resolvedDayFor.get(e.day)!,
          dayLabel: e.dayLabel ?? null,
          time: e.time,
          ak: e.ak,
          disciplineLabel: e.disciplineLabel,
          phase: e.phase ?? null,
          type: e.type,
          massStart: e.massStart,
          sourceDocumentId: doc.id,
          order: 0, // wird direkt im Anschluss über alle Einträge neu berechnet
        })),
      });

      // Tage können in beliebiger Reihenfolge importiert worden sein (z.B.
      // Sonntag vor Freitag) — hier auf die tatsächliche Wochentag-
      // Reihenfolge bringen, bevor die Gesamt-Reihenfolge (order) berechnet wird.
      await renumberDaysByWeekday(tx, eventId);

      const all = await tx.scheduleEntry.findMany({
        where: { eventId },
        orderBy: [{ day: 'asc' }, { time: 'asc' }],
        select: { id: true, order: true },
      });
      for (let i = 0; i < all.length; i++) {
        if (all[i].order !== i) {
          await tx.scheduleEntry.update({ where: { id: all[i].id }, data: { order: i } });
        }
      }
    });

    await autoMatch(eventId);
  } catch (err) {
    // Ein fehlgeschlagener Import darf den restlichen Poll-Zyklus nicht
    // abbrechen — beim nächsten Poll wird es erneut versucht (mevAnalyzedAt-
    // Pattern gibt es hier nicht, da ZEITPLAN-Dokumente sich meist per
    // remoteModifiedAt ändern und dann ohnehin neu durchlaufen).
    console.error(`Zeitplan-Auto-Import fehlgeschlagen für ${doc.fileName}:`, err);
  }
}
