// Fahrerlager-Anzeige (Kiosk-Modus).
//
// Eigene Vollbild-Route (/events/:id/kiosk), BEWUSST außerhalb des <Layout>
// im Router registriert — so gibt es keinen App-Header, die Seite füllt den
// ganzen Bildschirm. Zweck: Der Coach stellt einen Laptop ins Fahrerlager, die
// Sportler sehen groß und aus der Ferne lesbar Zeitplan + Kommuniqués DIESER
// Veranstaltung. Die Bedienung ist gesperrt: verlassen nur mit einem lokal
// gespeicherten PIN (oder, falls vergessen, mit dem Admin-Passwort).
//
// WICHTIG (bewusste Grenze): Ein Browser lässt das Verlassen des echten
// Vollbilds (Esc/F11) technisch immer zu — das kann keine Web-Seite verhindern.
// Deshalb ist die Sperre auf App-Ebene: verlässt jemand das Vollbild, bleibt
// die Kiosk-Anzeige aktiv und gesperrt, es erscheint nur ein Hinweisbanner mit
// „Wieder Vollbild". Für einen wirklich unentkommbaren Kiosk zusätzlich den
// Browser im OS-Kiosk-Modus starten (Chrome/Edge --kiosk).
//
// Rein additiv & read-only: nutzt dieselben API-Endpunkte wie die normalen
// Zeitplan-/Kommuniqués-Seiten, ändert keine Wertungs-/Scoring-Logik, braucht
// kein Backend/Schema. Die Zeitschätz- und MEV-Anzeige-Helfer sind bewusst aus
// SchedulePage dupliziert, um jene (während Wettkämpfen kritische) Datei nicht
// anzufassen.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import PdfViewer from '../components/PdfViewer';
import {
  api, communiquesApi, scheduleApi,
  type Event as EventT, type ScheduleEntry, type EventStatus,
  type LiveStatusKey, type MevRider, type CommuniqueSource,
  type CommuniqueDocument, type DocType,
} from '../api/client';

// ── PIN-Speicher (nur auf diesem Gerät) ─────────────────────────────────────
const PIN_KEY = 'kiosk_exit_pin';
const PIN_LEN = 4;
const getStoredPin = () => localStorage.getItem(PIN_KEY);
const setStoredPin = (pin: string) => localStorage.setItem(PIN_KEY, pin);
const clearStoredPin = () => localStorage.removeItem(PIN_KEY);

// ── Zeitplan-Helfer (dupliziert aus SchedulePage, s. Kopfkommentar) ──────────
const CEREMONY_ESTIMATE_MIN = 5;
const ESTIMATE_DISPLAY_THRESHOLD_MIN = 5;
const PAUSE_BUFFER_MIN = 20;
const STATUS_LABEL: Record<LiveStatusKey, string> = {
  STARTING: 'startet gerade', RUNNING: 'läuft', FINISHED: 'im Ziel', STARTS_AT: 'startet um',
};
const TYPE_ICON: Record<string, string> = { RACE: '🏁', CEREMONY: '🏅', INFO: 'ℹ️' };

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}
function fromMinutes(min: number): string {
  const norm = ((Math.round(min) % 1440) + 1440) % 1440;
  return `${String(Math.floor(norm / 60)).padStart(2, '0')}:${String(norm % 60).padStart(2, '0')}`;
}
function riderDetail(r: MevRider): string {
  const bits: string[] = [];
  if (r.lauf != null) bits.push(`Lauf ${r.lauf}`);
  else if (r.laufLabel) bits.push(r.laufLabel);
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
  return joined.length <= 60 ? joined : `${riders.length} Fahrer`;
}
function computeEstimatedTimes(
  dayEntries: ScheduleEntry[], status: EventStatus | null, currentEntryDay: number | null | undefined,
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

// ── Kommuniqué-Helfer ───────────────────────────────────────────────────────
const DOC_ICON: Record<DocType, string> = {
  STARTLISTE: '📋', ERGEBNIS: '🏁', ZEITPLAN: '🗓️', SONSTIGES: '📄',
};
const DOC_TAG: Record<DocType, { label: string; bg: string; fg: string }> = {
  STARTLISTE: { label: 'Startliste', bg: '#dbeafe', fg: '#1e40af' },
  ERGEBNIS:   { label: 'Ergebnis',   bg: '#dcfce7', fg: '#166534' },
  ZEITPLAN:   { label: 'Zeitplan',   bg: '#f3e8ff', fg: '#6b21a8' },
  SONSTIGES:  { label: 'Sonstiges',  bg: '#f3f4f6', fg: '#374151' },
};
const DISCIPLINE_LABELS: Record<string, string> = { SPRINT: 'Sprint', AUSDAUER: 'Ausdauer', ALLGEMEIN: '' };
function agoLabel(iso: string): string {
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (min < 1) return 'gerade eben';
  if (min < 60) return `vor ${min} Min.`;
  const h = Math.floor(min / 60);
  return `vor ${h} Std. ${min % 60} Min.`;
}

// ── PIN-Pad ─────────────────────────────────────────────────────────────────
function PinPad({ title, subtitle, error, onSubmit, onCancel, forgot }: {
  title: string; subtitle: string; error?: string;
  onSubmit: (code: string) => void; onCancel: () => void;
  forgot?: () => void;
}) {
  const [buf, setBuf] = useState('');
  useEffect(() => { if (error) setBuf(''); }, [error]);
  const press = (d: string) => {
    if (buf.length >= PIN_LEN) return;
    const next = buf + d;
    setBuf(next);
    if (next.length === PIN_LEN) setTimeout(() => { onSubmit(next); }, 120);
  };
  const keyStyle: React.CSSProperties = {
    padding: '18px 0', fontSize: 24, fontWeight: 600, borderRadius: 12,
    border: '1px solid var(--c-border)', background: 'var(--c-white)', cursor: 'pointer',
  };
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(17,24,39,.6)', zIndex: 60,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div style={{ background: 'var(--c-white)', borderRadius: 16, padding: 28, width: 340, textAlign: 'center',
        boxShadow: '0 20px 50px rgba(0,0,0,.35)' }}>
        <h3 style={{ margin: '0 0 4px', fontSize: 19 }}>{title}</h3>
        <p style={{ margin: '0 0 16px', fontSize: 13.5, color: 'var(--c-text-muted)' }}>{subtitle}</p>
        <div style={{ color: 'var(--c-danger)', fontSize: 13, fontWeight: 600, height: 18, marginBottom: 6 }}>
          {error ?? ''}
        </div>
        <div style={{ display: 'flex', gap: 12, justifyContent: 'center', marginBottom: 20, height: 16 }}>
          {Array.from({ length: PIN_LEN }).map((_, i) => (
            <div key={i} style={{ width: 15, height: 15, borderRadius: '50%',
              border: '2px solid ' + (i < buf.length ? 'var(--c-primary)' : 'var(--c-border)'),
              background: i < buf.length ? 'var(--c-primary)' : 'transparent' }} />
          ))}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 10 }}>
          {['1','2','3','4','5','6','7','8','9'].map(d => (
            <button key={d} style={keyStyle} onClick={() => press(d)}>{d}</button>
          ))}
          <button style={{ ...keyStyle, fontSize: 16 }} onClick={onCancel}>✕</button>
          <button style={keyStyle} onClick={() => press('0')}>0</button>
          <button style={{ ...keyStyle, fontSize: 18 }} onClick={() => setBuf(buf.slice(0, -1))}>⌫</button>
        </div>
        {forgot && (
          <button onClick={forgot} style={{ marginTop: 14, fontSize: 13, color: 'var(--c-primary)',
            background: 'none', border: 'none', textDecoration: 'underline', cursor: 'pointer' }}>
            PIN vergessen? Mit Admin-Passwort entsperren
          </button>
        )}
      </div>
    </div>
  );
}

// ── KioskPage ───────────────────────────────────────────────────────────────
export default function KioskPage() {
  const { id: eventId } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [started, setStarted]   = useState(false);
  const [tab, setTab]           = useState<'zeitplan' | 'kommuniques'>('zeitplan');
  const [event, setEvent]       = useState<EventT | null>(null);
  const [entries, setEntries]   = useState<ScheduleEntry[]>([]);
  const [status, setStatus]     = useState<EventStatus | null>(null);
  const [source, setSource]     = useState<CommuniqueSource | null>(null);
  const [activeDay, setActiveDay] = useState<number | null>(null);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState('');
  const [viewingDoc, setViewingDoc] = useState<CommuniqueDocument | null>(null);

  const [now, setNow]           = useState(new Date());
  const [fsExited, setFsExited] = useState(false);

  // PIN-Overlays
  const [setupPin, setSetupPin] = useState(false); // beim Start, wenn kein PIN gesetzt
  const [exitAsk, setExitAsk]   = useState(false); // Beenden-Dialog
  const [pinErr, setPinErr]     = useState<string>();

  const dayInitialized = useRef(false);

  // ── Daten laden (parallel; still, ohne Spinner beim Auto-Refresh) ──────────
  const load = useCallback(async (silent = false) => {
    if (!eventId) return;
    if (!silent) setLoading(true);
    try {
      const [ev, list, st, src] = await Promise.all([
        api.get<EventT>(`/api/events/${eventId}`),
        scheduleApi.list(eventId),
        scheduleApi.getStatus(eventId),
        communiquesApi.get(eventId).catch(() => null),
      ]);
      setEvent(ev); setEntries(list); setStatus(st); setSource(src);
      setError('');
      // Aktiven Tag einmalig sinnvoll vorbelegen: Tag des Live-Status, sonst
      // erster Tag. Danach respektieren wir die manuelle Tageswahl der Sportler.
      if (!dayInitialized.current && list.length > 0) {
        const statusDay = st ? list.find(e => e.id === st.scheduleEntryId)?.day : undefined;
        setActiveDay(statusDay ?? [...list].sort((a, b) => a.day - b.day)[0].day);
        dayInitialized.current = true;
      }
    } catch {
      if (!silent) setError('Daten konnten nicht geladen werden. Netzverbindung prüfen.');
    } finally {
      if (!silent) setLoading(false);
    }
  }, [eventId]);

  useEffect(() => { load(); }, [load]);

  // Auto-Refresh alle 60 s (still), damit die Anzeige im Fahrerlager aktuell
  // bleibt (neuer Live-Stand, frische Kommuniqués), ohne dass jemand tippt.
  useEffect(() => {
    const t = setInterval(() => load(true), 60_000);
    return () => clearInterval(t);
  }, [load]);

  // Uhr
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  // Vollbild-Status überwachen: Verlässt jemand das echte Vollbild, bleibt der
  // Kiosk aktiv — wir zeigen nur ein Banner mit „Wieder Vollbild".
  useEffect(() => {
    const onFsChange = () => setFsExited(started && !document.fullscreenElement);
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, [started]);

  const enterFullscreen = useCallback(async () => {
    try { await document.documentElement.requestFullscreen(); } catch { /* vom Browser abgelehnt – ok */ }
  }, []);

  // Kiosk starten (User-Geste → Vollbild darf angefordert werden).
  const handleStart = useCallback(() => {
    if (!getStoredPin()) { setSetupPin(true); return; } // erst PIN festlegen
    setStarted(true);
    enterFullscreen();
  }, [enterFullscreen]);

  const leaveKiosk = useCallback(() => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    navigate(`/events/${eventId}/schedule`);
  }, [navigate, eventId]);

  // ── abgeleitete Zeitplan-Daten ─────────────────────────────────────────────
  const days = useMemo(
    () => [...new Set(entries.map(e => e.day))].sort((a, b) => a - b), [entries]);
  const dayLabelFor = useCallback(
    (d: number) => entries.find(e => e.day === d && e.dayLabel)?.dayLabel ?? `Tag ${d}`, [entries]);
  const dayEntries = useMemo(
    () => entries.filter(e => e.day === activeDay).sort((a, b) => a.order - b.order),
    [entries, activeDay]);
  const currentEntryOrder = status ? entries.find(e => e.id === status.scheduleEntryId)?.order : undefined;
  const currentEntryDay   = status ? entries.find(e => e.id === status.scheduleEntryId)?.day : undefined;
  const estimatedTimes = useMemo(
    () => computeEstimatedTimes(dayEntries, status, currentEntryDay),
    [dayEntries, status, currentEntryDay]);

  // ── abgeleitete Kommuniqué-Daten (gepinnt zuerst, dann neueste zuerst) ─────
  const docs = useMemo(() => {
    const list = source?.documents ?? [];
    return [...list].sort((a, b) => {
      const pin = (b.isPinned ? 1 : 0) - (a.isPinned ? 1 : 0);
      if (pin !== 0) return pin;
      return new Date(b.remoteModifiedAt).getTime() - new Date(a.remoteModifiedAt).getTime();
    });
  }, [source]);

  const clock = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

  // ── PIN-Handler ────────────────────────────────────────────────────────────
  const submitSetupPin = (code: string) => {
    setStoredPin(code);
    setSetupPin(false);
    setStarted(true);
    enterFullscreen();
  };
  const submitExitPin = (code: string) => {
    if (code === getStoredPin()) {
      setExitAsk(false); setPinErr(undefined);
      leaveKiosk();
    } else {
      setPinErr('Falscher PIN');
    }
  };
  const handleAdminReset = async () => {
    const pw = window.prompt('Admin-Passwort eingeben, um zu entsperren:');
    if (pw == null) return;
    const ok = await api.verifyAdmin(pw);
    if (ok) {
      clearStoredPin();
      setExitAsk(false); setPinErr(undefined);
      leaveKiosk();
    } else {
      setPinErr('Admin-Passwort falsch');
    }
  };

  // ── Startbildschirm (vor Kiosk-Aktivierung) ────────────────────────────────
  if (!started) {
    return (
      <div style={{ position: 'fixed', inset: 0, background: 'var(--c-bg)',
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 22, padding: 24 }}>
        <div style={{ fontSize: 48 }}>🖥️</div>
        <div style={{ textAlign: 'center' }}>
          <h1 style={{ fontSize: 26, margin: '0 0 6px' }}>Fahrerlager-Anzeige</h1>
          <p style={{ margin: 0, color: 'var(--c-text-muted)', fontSize: 15, maxWidth: 420 }}>
            {event?.name ?? 'Veranstaltung wird geladen…'}<br />
            Startet die App im Vollbild für die Sportler – gesperrt, verlassen nur mit PIN.
          </p>
        </div>
        {error && <div style={{ color: 'var(--c-danger)', fontSize: 14 }}>{error}</div>}
        <div style={{ display: 'flex', gap: 12 }}>
          <button onClick={() => navigate(`/events/${eventId}/schedule`)}
            style={{ padding: '13px 20px', borderRadius: 10, border: '1px solid var(--c-border)',
              background: 'var(--c-white)', fontSize: 15, fontWeight: 500, cursor: 'pointer' }}>
            Abbrechen
          </button>
          <button onClick={handleStart} disabled={loading}
            style={{ padding: '13px 24px', borderRadius: 10, border: 'none',
              background: 'var(--c-primary)', color: '#fff', fontSize: 16, fontWeight: 600,
              cursor: loading ? 'default' : 'pointer', opacity: loading ? 0.6 : 1 }}>
            🖥️ Vollbild-Anzeige starten
          </button>
        </div>
        {!getStoredPin() && (
          <p style={{ fontSize: 13, color: 'var(--c-text-muted)', margin: 0 }}>
            Beim ersten Start legst du einen 4-stelligen PIN fest.
          </p>
        )}
        {setupPin && (
          <PinPad
            title="Kiosk-PIN festlegen"
            subtitle="Zum Beenden des Kiosk-Modus nötig. Nur auf diesem Laptop gespeichert."
            onSubmit={submitSetupPin}
            onCancel={() => setSetupPin(false)}
          />
        )}
      </div>
    );
  }

  // ── Kiosk-Ansicht ──────────────────────────────────────────────────────────
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 50, background: 'var(--c-bg)',
      display: 'flex', flexDirection: 'column' }}>

      {fsExited && (
        <div style={{ background: 'var(--c-warning)', color: '#fff', padding: '10px 20px',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, fontSize: 14, fontWeight: 500 }}>
          <span>⚠️ Vollbild wurde verlassen – die Anzeige bleibt gesperrt.</span>
          <button onClick={enterFullscreen}
            style={{ background: '#fff', color: 'var(--c-warning)', border: 'none',
              padding: '6px 12px', borderRadius: 6, fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>
            Wieder Vollbild
          </button>
        </div>
      )}

      {/* Kopf: Event + Uhr */}
      <div style={{ background: 'var(--c-white)', borderBottom: '2px solid var(--c-border)',
        padding: '16px 26px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 20 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 24, fontWeight: 700, lineHeight: 1.15, overflow: 'hidden',
            textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{event?.name ?? 'Veranstaltung'}</div>
          <div style={{ fontSize: 14, color: 'var(--c-text-muted)', marginTop: 2 }}>
            {activeDay != null ? dayLabelFor(activeDay) : ''}
          </div>
        </div>
        <div style={{ fontSize: 38, fontWeight: 700, fontVariantNumeric: 'tabular-nums', letterSpacing: -1 }}>{clock}</div>
      </div>

      {/* Umschalter Zeitplan / Kommuniqués */}
      <div style={{ display: 'flex', gap: 10, padding: '14px 26px 2px' }}>
        {(['zeitplan', 'kommuniques'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
            style={{ flex: 1, padding: 15, fontSize: 19, fontWeight: 600, borderRadius: 12,
              border: '2px solid ' + (tab === t ? 'var(--c-primary)' : 'var(--c-border)'),
              background: tab === t ? 'var(--c-primary)' : 'var(--c-white)',
              color: tab === t ? '#fff' : 'var(--c-text-muted)', cursor: 'pointer' }}>
            {t === 'zeitplan' ? '🗓️ Zeitplan' : '🔔 Kommuniqués'}
          </button>
        ))}
      </div>

      {/* Tageswahl (nur bei mehreren Tagen) */}
      {tab === 'zeitplan' && days.length > 1 && (
        <div style={{ display: 'flex', gap: 8, padding: '10px 26px 0', flexWrap: 'wrap' }}>
          {days.map(d => (
            <button key={d} onClick={() => setActiveDay(d)}
              style={{ padding: '7px 14px', borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: 'pointer',
                border: '1px solid ' + (activeDay === d ? '#111' : 'var(--c-border)'),
                background: activeDay === d ? '#111' : 'var(--c-white)',
                color: activeDay === d ? '#fff' : 'var(--c-text)' }}>
              {dayLabelFor(d)}
            </button>
          ))}
        </div>
      )}

      {/* Inhalt */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '14px 26px 24px' }}>
        {loading ? (
          <div style={{ color: 'var(--c-text-muted)', padding: 40, textAlign: 'center' }}>Wird geladen…</div>
        ) : error ? (
          <div style={{ color: 'var(--c-danger)', padding: 40, textAlign: 'center' }}>{error}</div>
        ) : tab === 'zeitplan' ? (
          <KioskSchedule
            dayEntries={dayEntries} status={status} estimatedTimes={estimatedTimes}
            currentEntryOrder={currentEntryOrder} currentEntryDay={currentEntryDay} />
        ) : (
          <KioskCommuniques docs={docs} onOpen={setViewingDoc} />
        )}
      </div>

      {/* Fuß: Schloss + Refresh-Hinweis */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '10px 26px', borderTop: '1px solid var(--c-border)', background: 'var(--c-white)',
        fontSize: 12.5, color: 'var(--c-text-muted)' }}>
        <span>Aktualisiert sich automatisch</span>
        <button onClick={() => { setPinErr(undefined); setExitAsk(true); }}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '8px 14px',
            borderRadius: 8, border: '1px solid var(--c-border)', background: 'var(--c-white)',
            color: 'var(--c-text-muted)', fontSize: 13.5, cursor: 'pointer' }}>
          🔒 Kiosk beenden
        </button>
      </div>

      {/* PDF-Vollbild-Overlay */}
      {viewingDoc && eventId && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 70, background: 'var(--c-bg)',
          display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 20px',
            background: 'var(--c-white)', borderBottom: '1px solid var(--c-border)' }}>
            <button onClick={() => setViewingDoc(null)}
              style={{ padding: '10px 18px', borderRadius: 8, border: 'none', background: 'var(--c-primary)',
                color: '#fff', fontSize: 15, fontWeight: 600, cursor: 'pointer' }}>
              ← Zurück
            </button>
            <span style={{ fontSize: 15, fontWeight: 600, overflow: 'hidden',
              textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{viewingDoc.fileName}</span>
          </div>
          <div style={{ flex: 1, overflowY: 'auto' }}>
            <PdfViewer url={communiquesApi.fileUrl(eventId, viewingDoc.id)} />
          </div>
        </div>
      )}

      {/* Beenden-PIN */}
      {exitAsk && (
        <PinPad
          title="PIN eingeben"
          subtitle="Zum Beenden des Kiosk-Modus."
          error={pinErr}
          onSubmit={submitExitPin}
          onCancel={() => { setExitAsk(false); setPinErr(undefined); }}
          forgot={handleAdminReset}
        />
      )}
    </div>
  );
}

// ── Teil-Ansicht: Zeitplan ──────────────────────────────────────────────────
function KioskSchedule({ dayEntries, status, estimatedTimes, currentEntryOrder, currentEntryDay }: {
  dayEntries: ScheduleEntry[]; status: EventStatus | null;
  estimatedTimes: Map<string, string>;
  currentEntryOrder: number | undefined; currentEntryDay: number | undefined;
}) {
  if (dayEntries.length === 0) {
    return <div style={{ color: 'var(--c-text-muted)', padding: 40, textAlign: 'center' }}>
      Für diesen Tag liegt noch kein Zeitplan vor.
    </div>;
  }
  const timeCounts = new Map<string, number>();
  for (const e of dayEntries) timeCounts.set(e.time, (timeCounts.get(e.time) ?? 0) + 1);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {dayEntries.map(entry => {
        const isCurrent = status?.scheduleEntryId === entry.id;
        const isPast = status != null && currentEntryDay === entry.day
          && currentEntryOrder != null && entry.order < currentEntryOrder;
        const estimatedTime = estimatedTimes.get(entry.id) ?? entry.time;
        const isBucketTime = (timeCounts.get(entry.time) ?? 0) > 1;
        const diffMin = Math.abs(toMinutes(estimatedTime) - toMinutes(entry.time));
        const showEstimate = isBucketTime || diffMin > ESTIMATE_DISPLAY_THRESHOLD_MIN;
        const displayTime = showEstimate ? estimatedTime : entry.time;

        // Info-/Warm-up-/Pause-Zeilen: schlicht grau.
        if (entry.type === 'INFO') {
          return (
            <div key={entry.id} style={{ padding: '12px 16px', borderRadius: 10,
              background: '#f3f4f6', border: '1px dashed var(--c-border)' }}>
              <span style={{ fontSize: 16, fontWeight: 500, color: '#4b5563' }}>
                ℹ️ {displayTime} · {entry.disciplineLabel}
              </span>
            </div>
          );
        }

        const mev = entry.linkedDocument ? mevSummary(entry.linkedDocument.mevRiders) : null;
        const heatCount = entry.linkedDocument?.heatCount ?? null;

        return (
          <div key={entry.id} style={{ display: 'flex', alignItems: 'center', gap: 18,
            background: 'var(--c-white)', borderRadius: 12, padding: '15px 20px',
            border: '2px solid ' + (isCurrent ? 'var(--c-success)' : 'var(--c-border)'),
            boxShadow: isCurrent ? '0 0 0 3px rgba(22,163,74,.12)' : 'none',
            opacity: isPast ? 0.5 : 1 }}>
            <div style={{ fontSize: 28, fontWeight: 700, fontVariantNumeric: 'tabular-nums', minWidth: 92 }}>
              {showEstimate && <span style={{ fontSize: 15, color: 'var(--c-text-muted)', fontWeight: 500 }}>~ </span>}
              {displayTime}
              {showEstimate && !isBucketTime && (
                <div style={{ fontSize: 12, color: 'var(--c-text-muted)', fontWeight: 500 }}>Plan {entry.time}</div>
              )}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 19, fontWeight: 600,
                fontStyle: entry.type === 'CEREMONY' ? 'italic' : 'normal' }}>
                {entry.type !== 'RACE' && <span style={{ marginRight: 6 }}>{TYPE_ICON[entry.type]}</span>}
                {entry.ak} · {entry.disciplineLabel}{entry.phase ? ` · ${entry.phase}` : ''}
                {heatCount != null && (
                  <span style={{ marginLeft: 8, fontSize: 13, fontWeight: 500, color: 'var(--c-text-muted)',
                    background: '#f3f4f6', padding: '2px 9px', borderRadius: 10, whiteSpace: 'nowrap' }}>
                    {heatCount} {heatCount === 1 ? 'Lauf' : 'Läufe'}
                  </span>
                )}
              </div>
              {mev && (
                <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--c-primary)', marginTop: 3 }}>
                  🚩 {mev}
                </div>
              )}
            </div>
            {isCurrent && status && (
              <span style={{ padding: '5px 14px', borderRadius: 20, fontSize: 15, fontWeight: 700,
                background: 'var(--c-success)', color: '#fff', whiteSpace: 'nowrap' }}>
                {STATUS_LABEL[status.statusKey]}
                {status.statusKey === 'RUNNING' && status.roundsLeft != null ? ` · ${status.roundsLeft} Rd.` : ''}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Teil-Ansicht: Kommuniqués ───────────────────────────────────────────────
function KioskCommuniques({ docs, onOpen }: {
  docs: CommuniqueDocument[]; onOpen: (d: CommuniqueDocument) => void;
}) {
  if (docs.length === 0) {
    return <div style={{ color: 'var(--c-text-muted)', padding: 40, textAlign: 'center' }}>
      Noch keine Kommuniqués veröffentlicht.
    </div>;
  }
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 12 }}>
      {docs.map(d => {
        const tag = DOC_TAG[d.docType];
        const disc = DISCIPLINE_LABELS[d.discipline] ?? '';
        return (
          <button key={d.id} onClick={() => onOpen(d)}
            style={{ display: 'flex', alignItems: 'center', gap: 16, textAlign: 'left', width: '100%',
              background: 'var(--c-white)', border: '2px solid ' + (d.isPinned ? '#fcd34d' : 'var(--c-border)'),
              borderRadius: 12, padding: '16px 18px', cursor: 'pointer', color: 'var(--c-text)' }}>
            <span style={{ fontSize: 28 }}>{DOC_ICON[d.docType]}</span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: 'block', fontSize: 16.5, fontWeight: 600, overflow: 'hidden',
                textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {d.isPinned && <span title="angeheftet">📌 </span>}{d.fileName}
              </span>
              <span style={{ display: 'block', fontSize: 13.5, color: 'var(--c-text-muted)', marginTop: 2 }}>
                {agoLabel(d.remoteModifiedAt)} · {d.ak}{disc ? ` · ${disc}` : ''}
              </span>
            </span>
            <span style={{ padding: '3px 10px', borderRadius: 6, fontSize: 12.5, fontWeight: 700,
              background: tag.bg, color: tag.fg, whiteSpace: 'nowrap' }}>{tag.label}</span>
          </button>
        );
      })}
    </div>
  );
}
