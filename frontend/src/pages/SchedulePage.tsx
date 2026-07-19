import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import PdfViewer from '../components/PdfViewer';
import EventTabBar from '../components/EventTabBar';
import SettingsGearButton from '../components/SettingsGearButton';
import KioskButton from '../components/KioskButton';
import ScheduleImport from '../components/ScheduleImport';
import { useAdmin } from '../components/Layout';
import {
  api, communiquesApi, scheduleApi,
  type Event as EventT, type ScheduleEntry, type EventStatus, type LiveStatusKey, type MevRider,
} from '../api/client';

const TYPE_ICON: Record<string, string> = { RACE: '🏁', CEREMONY: '🏅', INFO: 'ℹ️' };
const STATUS_LABEL: Record<LiveStatusKey, string> = {
  STARTING: 'startet gerade',
  RUNNING: 'läuft',
  FINISHED: 'im Ziel',
  STARTS_AT: 'startet um',
};

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}
function fromMinutes(min: number): string {
  const norm = ((Math.round(min) % 1440) + 1440) % 1440;
  const h = Math.floor(norm / 60);
  const m = norm % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
function agoLabel(iso: string): string {
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (min < 1) return 'gerade eben';
  if (min < 60) return `vor ${min} Min.`;
  const h = Math.floor(min / 60);
  return `vor ${h} Std. ${min % 60} Min.`;
}
// Namen zeigen solange sie in eine Zeile passen, sonst auf Anzahl umschalten —
// grober Zeichen-Schwellenwert statt fester Personenzahl (siehe Absprache).
// Nur Vorname (erstes Wort) — reicht für die Wiedererkennung am Start, spart
// Platz. Bindestrich-Vornamen (z.B. "Max-David") bleiben erhalten, da nur an
// Leerzeichen getrennt wird, nicht am Bindestrich. Lauf-Nummer (falls
// vorhanden) wird direkt am Namen angezeigt, da bei mehreren MEV-Fahrern im
// selben Rennen jeder in einem anderen Lauf stehen kann.
// Bei Mannschafts-Disziplinen (Teamsprint, Mannschaftsverfolgung, Madison)
// stehen mehrere Fahrer pro Lauf, gruppiert unter einem Team-Kürzel (z.B.
// "MEV 2"). In dem Fall ist der Team-Name aussagekräftiger als eine Liste
// einzelner Vornamen — deshalb Team-Namen bevorzugen, sobald mindestens ein
// Fahrer ein team-Feld hat. Pro (team, lauf) nur einmal anzeigen, auch wenn
// mehrere MEV-Fahrer im selben Team stehen.
// Lauf und Startposition (falls vorhanden) stehen zusammen in EINER Klammer
// hinter dem Namen: "Carlotta (Lauf 11, ZG)", bei Massenstart ohne Läufe nur
// "Dorothea (B 10)" (Zehnte an der Ballustrade), im Sprint-Finale
// "Finn-Liam (Platz 3/4)".
//   ZG/GG = Ziel-/Gegengerade (Einzelstart: Zeitfahren, Verfolgung)
//   B/M   = Ballustrade/Messlinie (Massenstart: Punktefahren, Madison, ...)
// Die Lauf-Spalte enthält nicht immer eine Zahl — bei Sprint-Finals steht dort
// "Platz 1/2" bzw. "Platz 3/4" (laufLabel). Der Text wird dann unverändert
// gezeigt, ohne "Lauf"-Präfix.
function riderDetail(r: MevRider): string {
  const bits: string[] = [];
  if (r.lauf != null) bits.push(`Lauf ${r.lauf}`);
  else if (r.laufLabel) bits.push(r.laufLabel);
  // Im Massenstart zusätzlich der Platz in der Reihe: "B 10" = Zehnter an der
  // Ballustrade. Im Einzelstart gibt es keinen Platz, dort bleibt es bei "ZG"/"GG".
  if (r.startPos) bits.push(r.startSlot != null ? `${r.startPos} ${r.startSlot}` : r.startPos);
  return bits.length > 0 ? ` (${bits.join(', ')})` : '';
}

function mevSummary(riders: MevRider[]): string | null {
  if (!riders || riders.length === 0) return null;

  const hasTeams = riders.some(r => r.team);
  let parts: string[];

  if (hasTeams) {
    const seen = new Set<string>();
    parts = [];
    for (const r of riders) {
      const label = r.team ?? r.name.trim().split(/\s+/)[0];
      const key = `${label}::${r.lauf ?? r.laufLabel ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      parts.push(`${label}${riderDetail(r)}`);
    }
  } else {
    parts = riders.map(r => `${r.name.trim().split(/\s+/)[0]}${riderDetail(r)}`);
  }

  const joined = parts.join(', ');
  if (joined.length <= 46) return joined;
  return `${riders.length} Fahrer`;
}

const CEREMONY_ESTIMATE_MIN = 5;
const ESTIMATE_DISPLAY_THRESHOLD_MIN = 5;
const PAUSE_BUFFER_MIN = 20; // Cool-down-Puffer nach dem letzten Rennen eines Blocks

// Errechnet pro Eintrag eines Tages eine geschätzte Uhrzeit, indem die
// geschätzte Dauer (estimatedMinutes, vom Backend kalibriert) ab einem Anker
// fortlaufend aufsummiert wird — statt der bisherigen Variante, die den
// ganzen Tag nur um einen einzigen fixen Versatz verschoben hat. Anker-Logik:
//   - Sobald der Eintrag mit dem aktuell gemeldeten "Aktueller Stand"
//     übereinstimmt: die ECHTE beobachtete Zeit (Zeitplan-Zeit + offsetMinutes)
//     als neuen, verlässlicheren Anker übernehmen.
//   - Bei INFO-Einträgen (Warm-up, Pausen, Ende) IMMER auf deren eigene
//     Zeitplan-Zeit zurücksetzen — die sind meist echte, fixe Eckpunkte.
//   - Wenn für einen Eintrag keine Schätzung vorliegt (z.B. Runden-/Laufzahl
//     noch unbekannt), NICHT weiter aufsummieren, sondern beim nächsten
//     Eintrag wieder bei dessen eigener Zeitplan-Zeit neu ansetzen — lieber
//     eine Lücke als eine unbegründete Zahl.
function computeEstimatedTimes(
  dayEntries: ScheduleEntry[],
  status: EventStatus | null,
  currentEntryDay: number | null | undefined,
): Map<string, string> {
  const result = new Map<string, string>();
  let cumulative: number | null = null;

  for (const entry of dayEntries) {
    if (status && currentEntryDay === entry.day && status.scheduleEntryId === entry.id) {
      cumulative = toMinutes(entry.time) + status.offsetMinutes;
    } else if (entry.type === 'INFO' || cumulative == null) {
      cumulative = toMinutes(entry.time);
    }

    result.set(entry.id, fromMinutes(cumulative));

    const dur = entry.estimatedMinutes ?? (entry.type === 'CEREMONY' ? CEREMONY_ESTIMATE_MIN : null);
    cumulative = dur != null ? cumulative + dur : null;
  }

  return result;
}

export default function SchedulePage() {
  const { id: eventId } = useParams<{ id: string }>();
  const { isAdmin } = useAdmin();

  const [event, setEvent]     = useState<EventT | null>(null);
  const [entries, setEntries] = useState<ScheduleEntry[]>([]);
  const [status, setStatus]   = useState<EventStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');

  const [activeDay, setActiveDay]   = useState(1);
  const [showImport, setShowImport] = useState(false);
  const [viewingDocId, setViewingDocId] = useState<string | null>(null);

  // Update-Dialog ("Aktueller Stand")
  const [showUpdate, setShowUpdate]         = useState(false);
  const [updateEntryId, setUpdateEntryId]   = useState('');
  const [updateStatusKey, setUpdateStatusKey] = useState<LiveStatusKey>('RUNNING');
  const [updateRounds, setUpdateRounds]     = useState(1);
  const [updateAnnouncedTime, setUpdateAnnouncedTime] = useState('');
  const [updateBusy, setUpdateBusy]         = useState(false);
  const [rematchBusy, setRematchBusy]       = useState(false);

  useEffect(() => { if (eventId) load(); }, [eventId]);

  // Offline-Vorabspeicherung: sobald ein Tag angezeigt wird (Erst-Laden ODER
  // Tageswechsel), dessen verlinkte Kommuniqués (Ansetzung + Ergebnis) an den
  // Service Worker zum Cachen geben. Rein additiv – andere, bereits gecachte
  // Tage bleiben erhalten. Läuft komplett im Hintergrund, ohne UI. Die URL trägt
  // remoteModifiedAt als ?v=, damit der SW Korrekturen als neue Version erkennt.
  useEffect(() => {
    if (!eventId || !('serviceWorker' in navigator)) return;
    const urls: string[] = [];
    for (const e of entries) {
      if (e.day !== activeDay) continue;
      if (e.linkedDocument) {
        urls.push(communiquesApi.fileUrl(eventId, e.linkedDocument.id, e.linkedDocument.remoteModifiedAt));
      }
      if (e.linkedResultDocument) {
        urls.push(communiquesApi.fileUrl(eventId, e.linkedResultDocument.id, e.linkedResultDocument.remoteModifiedAt));
      }
    }
    if (urls.length === 0) return;
    navigator.serviceWorker.ready
      .then(reg => reg.active?.postMessage({ type: 'PREFETCH', eventId, urls }))
      .catch(() => { /* SW noch nicht bereit – nächster Tageswechsel versucht es erneut */ });
  }, [eventId, activeDay, entries]);

  async function handleRematch() {
    if (!eventId) return;
    setRematchBusy(true); setError('');
    try {
      const list = await scheduleApi.rematch(eventId);
      setEntries(list);
    } catch (e: any) {
      setError(e.message ?? 'Abgleich fehlgeschlagen');
    } finally {
      setRematchBusy(false);
    }
  }

  async function handleDeleteDay(day: number) {
    if (!eventId) return;
    if (!window.confirm(`${dayLabelFor(day)} wirklich komplett löschen? Das entfernt alle Zeitplan-Einträge dieses Tages unwiderruflich.`)) return;
    setRematchBusy(true); setError('');
    try {
      const list = await scheduleApi.deleteDay(eventId, day);
      setEntries(list);
      const remainingDays = [...new Set(list.map(e => e.day))];
      if (!remainingDays.includes(activeDay)) {
        setActiveDay(remainingDays[0] ?? 1);
      }
    } catch (e: any) {
      setError(e.message ?? 'Löschen fehlgeschlagen');
    } finally {
      setRematchBusy(false);
    }
  }

  async function handleSetManualCount(entry: ScheduleEntry) {
    const label = entry.massStart ? 'Rundenzahl' : 'Laufzahl';
    const input = window.prompt(`${label} für "${entry.ak} · ${entry.disciplineLabel}${entry.phase ? ' · ' + entry.phase : ''}" eintragen (leer lassen zum Entfernen):`, entry.manualUnitCount != null ? String(entry.manualUnitCount) : '');
    if (input === null) return; // abgebrochen
    const trimmed = input.trim();
    const value = trimmed === '' ? null : Number(trimmed);
    if (value !== null && (!Number.isInteger(value) || value < 0)) {
      setError('Bitte eine ganze, nicht-negative Zahl eingeben.');
      return;
    }
    try {
      await scheduleApi.setManualUnitCount(entry.id, value);
      await load();
    } catch (e: any) {
      setError(e.message ?? 'Speichern fehlgeschlagen');
    }
  }

  async function load() {
    if (!eventId) return;
    setLoading(true); setError('');
    try {
      const [ev, list, st] = await Promise.all([
        api.get<EventT>(`/api/events/${eventId}`),
        scheduleApi.list(eventId),
        scheduleApi.getStatus(eventId),
      ]);
      setEvent(ev);
      setEntries(list);
      setStatus(st);
      if (list.length > 0 && !list.some(e => e.day === activeDay)) {
        setActiveDay(Math.min(...list.map(e => e.day)));
      }
    } catch (e: any) {
      setError(e.message ?? 'Fehler beim Laden');
    } finally {
      setLoading(false);
    }
  }

  const days = [...new Set(entries.map(e => e.day))].sort((a, b) => a - b);
  const dayLabelFor = (d: number) => entries.find(e => e.day === d && e.dayLabel)?.dayLabel ?? `Tag ${d}`;
  const dayEntries = entries.filter(e => e.day === activeDay).sort((a, b) => a.order - b.order);
  const raceOptions = entries.filter(e => e.type === 'RACE' && e.day === activeDay);
  const selectedUpdateEntry = entries.find(e => e.id === updateEntryId);

  function openUpdateModal() {
    const preselect = status?.scheduleEntryId && entries.some(e => e.id === status.scheduleEntryId)
      ? status.scheduleEntryId
      : (raceOptions[0]?.id ?? '');
    setUpdateEntryId(preselect);
    setUpdateStatusKey(status?.statusKey ?? 'RUNNING');
    setUpdateRounds(status?.roundsLeft ?? 1);
    const now = new Date();
    setUpdateAnnouncedTime(`${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`);
    setShowUpdate(true);
  }

  async function saveUpdate() {
    if (!eventId || !updateEntryId) return;
    setUpdateBusy(true); setError('');
    try {
      const st = await scheduleApi.setStatus(
        eventId, updateEntryId, updateStatusKey,
        updateStatusKey === 'RUNNING' ? updateRounds : null,
        updateStatusKey === 'STARTS_AT' ? updateAnnouncedTime : undefined,
      );
      setStatus(st);
      setShowUpdate(false);
    } catch (e: any) {
      setError(e.message ?? 'Speichern fehlgeschlagen');
    } finally {
      setUpdateBusy(false);
    }
  }

  if (loading) return (
    <div className="page container"><div className="loading"><span className="spinner" /> Lädt…</div></div>
  );

  const currentEntryOrder = status && entries.find(e => e.id === status.scheduleEntryId)?.order;
  const currentEntryDay = status && entries.find(e => e.id === status.scheduleEntryId)?.day;

  // Das gerade geöffnete Dokument (Ansetzung ODER Ergebnis) heraussuchen, um
  // seine remoteModifiedAt als Cache-Version an die PDF-URL zu hängen.
  const viewingDoc = viewingDocId
    ? entries
        .flatMap(e => [e.linkedDocument, e.linkedResultDocument])
        .find(d => d?.id === viewingDocId) ?? null
    : null;

  return (
    <>
    <div className="page container" style={{ maxWidth: 480 }}>
      <div className="breadcrumb">
        <Link to="/">Veranstaltungen</Link><span>›</span>
        <Link to={`/events/${eventId}`}>{event?.name ?? '…'}</Link><span>›</span>Zeitplan
      </div>

      <div className="flex-between mb-4" style={{ alignItems: 'flex-start' }}>
        <h1 style={{ margin: 0 }}>{event?.name ?? 'Zeitplan'}</h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {isAdmin && entries.length > 0 && (
            <button
              className="btn btn-ghost btn-sm"
              onClick={handleRematch}
              disabled={rematchBusy}
              title="Verknüpfung mit Kommuniqués neu berechnen"
              style={{ fontSize: 12 }}
            >
              {rematchBusy ? '…' : '🔄 Kommuniqués abgleichen'}
            </button>
          )}
          {eventId && <KioskButton eventId={eventId} />}
          {eventId && <SettingsGearButton eventId={eventId} />}
        </div>
      </div>

      {eventId && <EventTabBar eventId={eventId} active="zeitplan" />}

      {error && <div className="alert alert-error mb-3">{error}</div>}

      {entries.length === 0 ? (
        <div className="empty">
          <p>Noch kein Zeitplan importiert.</p>
          {isAdmin && (
            <button className="btn btn-primary" onClick={() => setShowImport(true)}>
              📄 Zeitplan importieren
            </button>
          )}
        </div>
      ) : (
        <>
          {/* Tages-Reiter */}
          {days.length > 1 && (
            <div style={{
              display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center',
              position: 'sticky', top: 90, zIndex: 8, background: 'var(--c-bg)', paddingTop: 6, paddingBottom: 6,
            }}>
              {days.map(d => (
                <button
                  key={d}
                  onClick={() => setActiveDay(d)}
                  style={{
                    padding: '4px 12px', borderRadius: 20, fontSize: 12.5, fontWeight: 500, cursor: 'pointer',
                    border: activeDay === d ? '1px solid #111' : '1px solid var(--c-border)',
                    background: activeDay === d ? '#111' : 'var(--c-white)',
                    color: activeDay === d ? '#fff' : 'var(--c-text)',
                  }}
                >
                  {dayLabelFor(d)}
                </button>
              ))}
              {isAdmin && (
                <button
                  onClick={() => handleDeleteDay(activeDay)}
                  title={`${dayLabelFor(activeDay)} löschen`}
                  className="btn btn-ghost btn-sm"
                  style={{ fontSize: 12, color: 'var(--c-danger, #dc2626)', padding: '4px 8px' }}
                >
                  🗑
                </button>
              )}
            </div>
          )}

          {/* Aktueller Stand */}
          <div
            className="card mb-3"
            style={{ borderColor: status ? '#bfdbfe' : undefined, background: status ? '#f8faff' : undefined }}
          >
            <div className="flex-between" style={{ alignItems: 'flex-start' }}>
              <div style={{ minWidth: 0 }}>
                <p className="text-xs" style={{ fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.03em', color: 'var(--c-primary)', margin: '0 0 4px' }}>
                  Aktueller Stand
                </p>
                {status ? (
                  <>
                    <p style={{ fontWeight: 500, fontSize: 14.5, margin: 0 }}>
                      {status.scheduleEntry.ak} · {status.scheduleEntry.disciplineLabel}
                      {status.scheduleEntry.phase ? ` · ${status.scheduleEntry.phase}` : ''}
                    </p>
                    <p className="text-sm text-muted" style={{ margin: '2px 0 0' }}>
                      {status.statusKey === 'STARTS_AT'
                        ? `startet um ${fromMinutes(toMinutes(status.scheduleEntry.time) + status.offsetMinutes)}`
                        : STATUS_LABEL[status.statusKey]}
                      {status.statusKey === 'RUNNING' && status.roundsLeft != null
                        ? status.scheduleEntry.massStart === false
                          ? ` · Lauf ${status.roundsLeft}${status.scheduleEntry.linkedDocument?.heatCount != null ? ` von ${status.scheduleEntry.linkedDocument.heatCount}` : ''}`
                          : ` · noch ${status.roundsLeft} Runden`
                        : ''}
                      {' · aktualisiert '}{agoLabel(status.updatedAt)}
                    </p>
                  </>
                ) : (
                  <p className="text-sm text-muted" style={{ margin: 0 }}>Noch kein Stand hinterlegt</p>
                )}
              </div>
              {isAdmin && (
                <button className="btn btn-primary btn-sm" style={{ flexShrink: 0 }} onClick={openUpdateModal}>
                  Aktualisieren
                </button>
              )}
            </div>
          </div>

          {/* Zeitplan-Liste (alle Rennen & Siegerehrungen des Tages) */}
          <div className="card" style={{ padding: '4px 14px' }}>
            {(() => {
              const estimatedTimes = computeEstimatedTimes(dayEntries, status, currentEntryDay);
              // Teilen sich mehrere Einträge exakt dieselbe PDF-Uhrzeit, ist das
              // keine echte Uhrzeit pro Rennen, sondern nur "diese Rennen folgen
              // im Anschluss" — dann lieber nur die Schätzung zeigen statt einer
              // zweiten, irreführenden Zeile mit der (nichtssagenden) PDF-Zeit.
              const timeCounts = new Map<string, number>();
              for (const e of dayEntries) timeCounts.set(e.time, (timeCounts.get(e.time) ?? 0) + 1);

              return dayEntries.map((entry, idx) => {
                const isCurrent = status?.scheduleEntryId === entry.id;
                const isPast = status != null && currentEntryDay === entry.day && currentEntryOrder != null && entry.order < currentEntryOrder;
                const estimatedTime = estimatedTimes.get(entry.id) ?? entry.time;
                const isBucketTime = (timeCounts.get(entry.time) ?? 0) > 1;
                const diffMin = Math.abs(toMinutes(estimatedTime) - toMinutes(entry.time));
                const showEstimateAsPrimary = isBucketTime || diffMin > ESTIMATE_DISPLAY_THRESHOLD_MIN;
                const displayTime = showEstimateAsPrimary ? estimatedTime : entry.time;
                const showNominalSecondary = showEstimateAsPrimary && !isBucketTime;
                const mev = entry.linkedDocument ? mevSummary(entry.linkedDocument.mevRiders) : null;
                const heatCount = entry.linkedDocument?.heatCount ?? null;

                const prevEntry = idx > 0 ? dayEntries[idx - 1] : null;
                const nextEntry = idx < dayEntries.length - 1 ? dayEntries[idx + 1] : null;
                const isLastOfBlock = (entry.type === 'RACE' || entry.type === 'CEREMONY') && nextEntry?.type === 'INFO';
                const isBlockTransition = entry.type === 'INFO' && prevEntry != null
                  && (prevEntry.type === 'RACE' || prevEntry.type === 'CEREMONY');

                // Pause-Zeile: Bahn ist zu zwischen "letztes Rennen + Cool-down-
                // Puffer" und dem Warm-up-Zeitpunkt (der markiert, wann die Bahn
                // für den nächsten Block wieder öffnet — NICHT wann sie schließt).
                if (isBlockTransition && prevEntry) {
                  const prevStartMin = toMinutes(estimatedTimes.get(prevEntry.id) ?? prevEntry.time);
                  const prevDuration = prevEntry.estimatedMinutes ?? (prevEntry.type === 'CEREMONY' ? CEREMONY_ESTIMATE_MIN : 0);
                  const pauseStartMin = prevStartMin + prevDuration + PAUSE_BUFFER_MIN;
                  const pauseEndMin = Math.max(toMinutes(estimatedTimes.get(entry.id) ?? entry.time), pauseStartMin);
                  return (
                    <div key={entry.id} style={{
                      margin: '6px 0', padding: '12px 10px', borderRadius: 8,
                      background: 'rgba(107, 114, 128, 0.12)', textAlign: 'center',
                    }}>
                      <span style={{ fontSize: 14, fontWeight: 500, color: 'var(--c-text-secondary, #4b5563)' }}>
                        ⏸ Pause · ca. {fromMinutes(pauseStartMin)} – {fromMinutes(pauseEndMin)}
                      </span>
                    </div>
                  );
                }

                // Warm-up ohne vorheriges Rennen (z.B. der allererste Block des
                // Tages) — schlichter, nur mittel betont statt als volle Pause.
                if (entry.type === 'INFO') {
                  return (
                    <div key={entry.id} style={{
                      margin: '6px 0', padding: '8px 10px', borderRadius: 6,
                      background: 'var(--c-bg-muted, #f3f4f6)',
                    }}>
                      <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--c-text-secondary, #4b5563)' }}>
                        ℹ️ {displayTime} · {entry.disciplineLabel}
                      </span>
                    </div>
                  );
                }

              return (
                <div
                  key={entry.id}
                  style={{
                    display: 'grid', gridTemplateColumns: '48px 1fr auto', gap: 10, alignItems: 'center',
                    padding: '8px 2px',
                    borderBottom: '1px solid var(--c-border)',
                    opacity: isPast ? 0.45 : 1,
                    borderLeft: isCurrent ? '3px solid var(--c-success, #16a34a)' : '3px solid transparent',
                    background: isCurrent ? '#f8faff' : isLastOfBlock ? 'rgba(107, 114, 128, 0.05)' : 'transparent',
                    borderRadius: isCurrent ? '0 8px 8px 0' : 0,
                  }}
                >
                  <div>
                    <div style={{ fontSize: 13, fontWeight: isCurrent ? 600 : 400 }}>{displayTime}</div>
                    {showNominalSecondary && (
                      <div style={{ fontSize: 10, color: 'var(--c-text-muted)' }}>{entry.time}</div>
                    )}
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <div style={{
                      fontSize: 13.5,
                      fontWeight: isCurrent ? 600 : 400,
                      fontStyle: entry.type === 'CEREMONY' ? 'italic' : 'normal',
                    }}>
                      {entry.type !== 'RACE' && <span style={{ marginRight: 5 }}>{TYPE_ICON[entry.type]}</span>}
                      <>{entry.ak} · {entry.disciplineLabel}{entry.phase ? ` · ${entry.phase}` : ''}</>
                      {entry.type === 'RACE' && heatCount != null && (
                        <span style={{
                          marginLeft: 6, fontSize: 11, fontWeight: 500, color: 'var(--c-text-muted)',
                          background: 'var(--c-bg-muted, #f3f4f6)', padding: '1px 7px', borderRadius: 10,
                          whiteSpace: 'nowrap',
                        }}>
                          {heatCount} {heatCount === 1 ? 'Lauf' : 'Läufe'}
                        </span>
                      )}
                      {entry.type === 'RACE' && isAdmin && entry.estimateIsFallback && (
                        <span
                          onClick={() => handleSetManualCount(entry)}
                          title={`${entry.massStart ? 'Rundenzahl' : 'Laufzahl'} manuell eintragen (Schätzung beruht auf einer Rückfallgröße)`}
                          style={{ marginLeft: 6, fontSize: 12, cursor: 'pointer', opacity: 0.6 }}
                        >
                          ✏️
                        </span>
                      )}
                    </div>
                    {entry.type === 'RACE' && (
                      <div
                        className="text-xs text-muted"
                        style={{ marginTop: 3, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px 10px' }}
                      >
                        {entry.linkedDocument ? (
                          <span
                            style={{ color: 'var(--c-primary)', cursor: 'pointer', whiteSpace: 'nowrap' }}
                            onClick={() => setViewingDocId(entry.linkedDocument!.id)}
                          >
                            📄 Kommuniqué öffnen
                          </span>
                        ) : (
                          <span style={{ whiteSpace: 'nowrap' }}>kein Kommuniqué zugeordnet</span>
                        )}
                        {entry.linkedResultDocument && (
                          <span
                            style={{ color: 'var(--c-success, #16a34a)', cursor: 'pointer', whiteSpace: 'nowrap' }}
                            onClick={() => setViewingDocId(entry.linkedResultDocument!.id)}
                          >
                            🏁 Ergebnis öffnen
                          </span>
                        )}
                        {mev && (
                          <span
                            title={`MEV: ${mev}`}
                            style={{
                              flexBasis: '100%', maxWidth: '100%',
                              fontSize: 11.5, fontWeight: 600, color: '#b45309',
                              background: '#fef3c7', padding: '2px 8px', borderRadius: 8,
                              lineHeight: 1.45, marginTop: 1,
                            }}
                          >
                            MEV: {mev}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                  <span style={{ fontSize: 14, color: isPast ? '#16a34a' : 'var(--c-text-muted)' }}>
                    {isPast ? '✓' : isCurrent ? '●' : ''}
                  </span>
                </div>
              );
              });
            })()}
          </div>

          {isAdmin && (
            <button
              className="btn btn-ghost btn-sm mt-3"
              onClick={() => setShowImport(true)}
            >
              📄 Zeitplan neu importieren
            </button>
          )}
        </>
      )}
    </div>

    {showImport && eventId && (
      <ScheduleImport
        eventId={eventId}
        onDone={() => { setShowImport(false); load(); }}
        onClose={() => setShowImport(false)}
      />
    )}

    {showUpdate && (
      <div className="modal-overlay" onClick={() => setShowUpdate(false)}>
        <div className="modal" style={{ maxWidth: 340 }} onClick={e => e.stopPropagation()}>
          <p className="modal-title">Stand aktualisieren</p>
          {error && <div className="alert alert-error mb-3">{error}</div>}

          <div className="form-group">
            <label className="form-label">Rennen</label>
            <select
              className="form-select"
              value={updateEntryId}
              onChange={e => setUpdateEntryId(e.target.value)}
            >
              {raceOptions.length === 0 && <option value="">Keine Rennen an diesem Tag</option>}
              {(() => {
                const items: JSX.Element[] = [];
                dayEntries.forEach((e, idx) => {
                  if (e.type !== 'RACE') return;
                  const prev = idx > 0 ? dayEntries[idx - 1] : null;
                  if (prev && prev.type === 'INFO') {
                    items.push(<option key={`sep-${e.id}`} disabled>──────────</option>);
                  }
                  items.push(
                    <option key={e.id} value={e.id}>
                      {e.ak} · {e.disciplineLabel}{e.phase ? ` · ${e.phase}` : ''}
                    </option>
                  );
                });
                return items;
              })()}
            </select>
          </div>

          <div className="form-group">
            <label className="form-label">Status</label>
            <div style={{ display: 'flex', gap: 6 }}>
              {(['STARTING', 'RUNNING', 'FINISHED', 'STARTS_AT'] as LiveStatusKey[]).map(key => (
                <button
                  key={key}
                  onClick={() => setUpdateStatusKey(key)}
                  style={{
                    flex: 1, padding: '8px 4px', borderRadius: 7, fontSize: 12, fontWeight: 500, cursor: 'pointer',
                    border: updateStatusKey === key ? '1px solid #16a34a' : '1px solid var(--c-border)',
                    background: updateStatusKey === key ? '#f0fdf4' : 'var(--c-white)',
                    color: updateStatusKey === key ? '#16a34a' : 'var(--c-text)',
                  }}
                >
                  {STATUS_LABEL[key]}
                </button>
              ))}
            </div>
          </div>

          {updateStatusKey === 'RUNNING' && (
            <div className="form-group">
              <label className="form-label">
                {selectedUpdateEntry?.massStart === false ? 'Aktueller Lauf' : 'Noch Runden'}
              </label>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, background: '#f8faff', borderRadius: 7, padding: '8px 10px' }}>
                <button
                  onClick={() => setUpdateRounds(r => Math.max(0, r - 1))}
                  style={{ width: 26, height: 26, borderRadius: 6, border: '1px solid var(--c-border)', background: 'var(--c-white)', fontSize: 14, cursor: 'pointer' }}
                >−</button>
                <span style={{ fontSize: 15, fontWeight: 500, minWidth: 20, textAlign: 'center' }}>{updateRounds}</span>
                <button
                  onClick={() => setUpdateRounds(r => r + 1)}
                  style={{ width: 26, height: 26, borderRadius: 6, border: '1px solid var(--c-border)', background: 'var(--c-white)', fontSize: 14, cursor: 'pointer' }}
                >+</button>
                {selectedUpdateEntry?.massStart === false && selectedUpdateEntry?.linkedDocument?.heatCount != null && (
                  <span style={{ fontSize: 13, color: 'var(--c-text-muted)' }}>
                    von {selectedUpdateEntry.linkedDocument.heatCount}
                  </span>
                )}
              </div>
            </div>
          )}

          {updateStatusKey === 'STARTS_AT' && (
            <div className="form-group">
              <label className="form-label">Angesagte Startzeit</label>
              <input
                type="time"
                className="form-input"
                value={updateAnnouncedTime}
                onChange={e => setUpdateAnnouncedTime(e.target.value)}
              />
            </div>
          )}

          <div className="flex-between mt-3">
            <button className="btn btn-ghost" onClick={() => setShowUpdate(false)} disabled={updateBusy}>Abbrechen</button>
            <button className="btn btn-primary" onClick={saveUpdate} disabled={updateBusy || !updateEntryId}>
              {updateBusy ? 'Speichert…' : 'Speichern'}
            </button>
          </div>
        </div>
      </div>
    )}

    {viewingDocId && eventId && (
      <div
        onClick={() => setViewingDocId(null)}
        style={{ position: 'fixed', inset: 0, background: 'rgba(17,17,17,0.75)', zIndex: 1000, display: 'flex', flexDirection: 'column' }}
      >
        <div onClick={e => e.stopPropagation()} style={{ display: 'flex', flexDirection: 'column', height: '100%', width: '100%', background: 'var(--c-white)' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', borderBottom: '1px solid var(--c-border)', flexShrink: 0 }}>
            <span style={{ fontSize: 13.5, fontWeight: 600 }}>Kommuniqué</span>
            <button onClick={() => setViewingDocId(null)} className="btn btn-ghost btn-sm" style={{ fontSize: 18, padding: '4px 10px' }}>✕</button>
          </div>
          <div style={{ flex: 1, minHeight: 0 }}>
            <PdfViewer url={communiquesApi.fileUrl(eventId, viewingDocId, viewingDoc?.remoteModifiedAt)} />
          </div>
        </div>
      </div>
    )}
    </>
  );
}
