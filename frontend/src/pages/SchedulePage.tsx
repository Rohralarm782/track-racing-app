import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import PdfViewer from '../components/PdfViewer';
import EventTabBar from '../components/EventTabBar';
import SettingsGearButton from '../components/SettingsGearButton';
import ScheduleImport from '../components/ScheduleImport';
import { useAdmin } from '../components/Layout';
import {
  api, communiquesApi, scheduleApi,
  type Event as EventT, type ScheduleEntry, type EventStatus, type LiveStatusKey,
} from '../api/client';

const TYPE_ICON: Record<string, string> = { RACE: '🏁', CEREMONY: '🏅', INFO: 'ℹ️' };
const STATUS_LABEL: Record<LiveStatusKey, string> = {
  STARTING: 'startet gerade',
  RUNNING: 'läuft',
  FINISHED: 'im Ziel',
};

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}
function fromMinutes(min: number): string {
  const norm = ((min % 1440) + 1440) % 1440;
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
// Leerzeichen getrennt wird, nicht am Bindestrich.
function mevSummary(names: string[]): string | null {
  if (!names || names.length === 0) return null;
  const firstNames = names.map(n => n.trim().split(/\s+/)[0]);
  const joined = firstNames.join(', ');
  if (joined.length <= 38) return joined;
  return `${names.length} Fahrer`;
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
  const [updateBusy, setUpdateBusy]         = useState(false);
  const [rematchBusy, setRematchBusy]       = useState(false);

  useEffect(() => { if (eventId) load(); }, [eventId]);

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

  function openUpdateModal() {
    const preselect = status?.scheduleEntryId && entries.some(e => e.id === status.scheduleEntryId)
      ? status.scheduleEntryId
      : (raceOptions[0]?.id ?? '');
    setUpdateEntryId(preselect);
    setUpdateStatusKey(status?.statusKey ?? 'RUNNING');
    setUpdateRounds(status?.roundsLeft ?? 1);
    setShowUpdate(true);
  }

  async function saveUpdate() {
    if (!eventId || !updateEntryId) return;
    setUpdateBusy(true); setError('');
    try {
      const st = await scheduleApi.setStatus(
        eventId, updateEntryId, updateStatusKey,
        updateStatusKey === 'RUNNING' ? updateRounds : null,
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
            <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
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
                      {STATUS_LABEL[status.statusKey]}
                      {status.statusKey === 'RUNNING' && status.roundsLeft != null ? ` · noch ${status.roundsLeft} Runden` : ''}
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
            {dayEntries.map(entry => {
              const isCurrent = status?.scheduleEntryId === entry.id;
              const isPast = status != null && currentEntryDay === entry.day && currentEntryOrder != null && entry.order < currentEntryOrder;
              const adjustedTime = status && currentEntryDay === entry.day
                ? fromMinutes(toMinutes(entry.time) + status.offsetMinutes)
                : entry.time;
              const mev = entry.linkedDocument ? mevSummary(entry.linkedDocument.mevNames) : null;

              return (
                <div
                  key={entry.id}
                  style={{
                    display: 'grid', gridTemplateColumns: '48px 1fr auto', gap: 10, alignItems: 'center',
                    padding: '8px 2px', borderBottom: '1px solid var(--c-border)',
                    opacity: entry.type === 'INFO' ? 0.55 : isPast ? 0.45 : 1,
                    borderLeft: isCurrent ? '3px solid var(--c-success, #16a34a)' : '3px solid transparent',
                    background: isCurrent ? '#f8faff' : 'transparent',
                    borderRadius: isCurrent ? '0 8px 8px 0' : 0,
                  }}
                >
                  <div>
                    <div style={{ fontSize: 13, fontWeight: isCurrent ? 600 : 400 }}>{adjustedTime}</div>
                    {adjustedTime !== entry.time && (
                      <div style={{ fontSize: 10, color: 'var(--c-text-muted)' }}>{entry.time}</div>
                    )}
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 13.5, fontWeight: isCurrent ? 600 : 400, fontStyle: entry.type === 'CEREMONY' ? 'italic' : 'normal' }}>
                      {entry.type !== 'RACE' && <span style={{ marginRight: 5 }}>{TYPE_ICON[entry.type]}</span>}
                      {entry.type === 'INFO' ? entry.disciplineLabel : (
                        <>{entry.ak} · {entry.disciplineLabel}{entry.phase ? ` · ${entry.phase}` : ''}</>
                      )}
                    </div>
                    {entry.type === 'RACE' && (
                      <div className="text-xs text-muted" style={{ marginTop: 2 }}>
                        {entry.linkedDocument ? (
                          <span
                            style={{ color: 'var(--c-primary)', cursor: 'pointer' }}
                            onClick={() => setViewingDocId(entry.linkedDocument!.id)}
                          >
                            📄 Kommuniqué öffnen
                          </span>
                        ) : (
                          <span>kein Kommuniqué zugeordnet</span>
                        )}
                        {mev && <span> · MEV: {mev}</span>}
                        {entry.linkedResultDocument && (
                          <>
                            {' · '}
                            <span
                              style={{ color: 'var(--c-success, #16a34a)', cursor: 'pointer' }}
                              onClick={() => setViewingDocId(entry.linkedResultDocument!.id)}
                            >
                              🏁 Ergebnis öffnen
                            </span>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                  <span style={{ fontSize: 14, color: isPast ? '#16a34a' : 'var(--c-text-muted)' }}>
                    {isPast ? '✓' : isCurrent ? '●' : ''}
                  </span>
                </div>
              );
            })}
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
              {raceOptions.map(r => (
                <option key={r.id} value={r.id}>
                  {r.ak} · {r.disciplineLabel}{r.phase ? ` · ${r.phase}` : ''}
                </option>
              ))}
            </select>
          </div>

          <div className="form-group">
            <label className="form-label">Status</label>
            <div style={{ display: 'flex', gap: 6 }}>
              {(['STARTING', 'RUNNING', 'FINISHED'] as LiveStatusKey[]).map(key => (
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
              <label className="form-label">Noch Runden</label>
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
              </div>
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
            <PdfViewer url={communiquesApi.fileUrl(eventId, viewingDocId)} />
          </div>
        </div>
      </div>
    )}
    </>
  );
}
