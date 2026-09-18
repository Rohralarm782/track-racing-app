import { useEffect, useState } from 'react';
import { communiquesApi, type SpinsEventOption } from '../api/client';

// Auswahl der Veranstaltung bei SPINS Live Timing.
//
// Der Link, den Ausrichter herumreichen, ist für ALLE Veranstaltungen derselbe
// (https://www.spins-live.de/SpinsWebLiveTiming.html) — welche gemeint ist,
// wird dort erst in der Anwendung ausgewählt und steht nirgends in der Adresse.
// Ohne diese Auswahl müsste die Kennung von Hand angehängt werden.
//
// Wie beim Abschnitts-Wähler: kein automatisches Laden beim Tippen und keine
// stille Vorauswahl. Passende Veranstaltungen (Datum stimmt mit der
// Veranstaltung in der App überein) stehen oben und sind markiert, gewählt wird
// von Hand — eine geratene Zuordnung würde man beim schnellen Durchklicken
// übersehen und erst trackside merken.

interface Props {
  /** Aktueller Inhalt des Eingabefelds (eine Adresse je Zeile). */
  input: string;
  onChange: (next: string) => void;
  eventId: string;
}

/** True für Adressen auf spins-live.de. */
export function isSpinsLine(line: string): boolean {
  try {
    const host = new URL(line.trim()).hostname.toLowerCase();
    return host === 'spins-live.de' || host.endsWith('.spins-live.de');
  } catch {
    return false;
  }
}

/** Bereits eingetragene Kennung aus einer SPINS-Adresse, sonst null. */
function eventIdOf(line: string): number | null {
  try {
    const params = new URL(line.trim()).searchParams;
    for (const [key, value] of params.entries()) {
      const k = key.toLowerCase();
      if (k !== 'eventid' && k !== 'event') continue;
      const n = Number.parseInt(value, 10);
      if (Number.isFinite(n) && n > 0) return n;
    }
  } catch { /* keine gültige Adresse */ }
  return null;
}

/** Setzt ?eventid= in einer Adresse, vorhandene Kennung wird ersetzt. */
function withEventId(line: string, id: number | null): string {
  try {
    const url = new URL(line.trim());
    for (const key of [...url.searchParams.keys()]) {
      if (key.toLowerCase() === 'eventid' || key.toLowerCase() === 'event') url.searchParams.delete(key);
    }
    if (id !== null) url.searchParams.set('eventid', String(id));
    return url.toString();
  } catch {
    return line;
  }
}

function formatDate(iso: string | null): string {
  if (!iso) return 'ohne Datum';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? 'ohne Datum' : d.toLocaleDateString('de-DE');
}

export default function SpinsEventPicker({ input, onChange, eventId }: Props) {
  const [events, setEvents] = useState<SpinsEventOption[] | null>(null);
  const [busy, setBusy]     = useState(false);
  const [error, setError]   = useState('');
  const [showAll, setShowAll] = useState(false);

  const lines = input.split('\n');
  const spinsIndex = lines.findIndex(isSpinsLine);
  const spinsLine = spinsIndex >= 0 ? lines[spinsIndex] : null;
  const chosenId = spinsLine ? eventIdOf(spinsLine) : null;

  // Verschwindet die SPINS-Adresse aus der Eingabe, passt eine geladene Liste
  // nicht mehr dazu.
  useEffect(() => { if (!spinsLine) { setEvents(null); setError(''); } }, [spinsLine]);

  if (!spinsLine) return null;

  async function load() {
    setBusy(true); setError('');
    try {
      const res = await communiquesApi.spinsEvents(eventId);
      setEvents(res.events);
      if (res.events.some(e => e.matchesDate)) setShowAll(false);
      else setShowAll(true);
    } catch (e: any) {
      setError(e.message ?? 'Die Veranstaltungen konnten nicht geladen werden.');
    } finally {
      setBusy(false);
    }
  }

  function choose(id: number | null) {
    const next = [...lines];
    next[spinsIndex] = withEventId(next[spinsIndex], id);
    onChange(next.join('\n'));
  }

  const suggested = events ? events.filter(e => e.matchesDate) : [];
  const rest      = events ? events.filter(e => !e.matchesDate) : [];
  const chosen    = events?.find(e => e.id === chosenId) ?? null;

  return (
    <div style={{ borderTop: '1px solid var(--c-border)', paddingTop: 12, marginTop: 12 }}>
      <div className="flex-between" style={{ alignItems: 'center', marginBottom: 4 }}>
        <strong style={{ fontSize: 14 }}>Veranstaltung bei SPINS</strong>
        <button className="btn btn-secondary btn-sm" type="button" onClick={load} disabled={busy}>
          {busy ? 'Lädt…' : events ? 'Erneut laden' : 'Veranstaltungen laden'}
        </button>
      </div>
      <p className="text-sm text-muted" style={{ marginTop: 0, marginBottom: 10 }}>
        Der Link ist für alle Veranstaltungen derselbe. Ohne Auswahl sucht die App
        selbst über Datum und Name — steht dort schon etwas Falsches oder findet
        sie nichts, hier von Hand wählen.
      </p>

      {error && <div className="alert alert-error" style={{ marginBottom: 10 }}>{error}</div>}

      {chosenId !== null && (
        <div className="text-sm" style={{ marginBottom: 10 }}>
          Gewählt: <strong>{chosen ? `${chosen.name} (${formatDate(chosen.date)})` : `Kennung ${chosenId}`}</strong>
          {' · '}
          <button
            type="button"
            className="btn-link"
            onClick={() => choose(null)}
            style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--c-primary)', font: 'inherit' }}
          >
            Auswahl aufheben
          </button>
        </div>
      )}

      {events && (
        events.length === 0 ? (
          <p className="text-sm text-muted" style={{ margin: 0 }}>
            Bei SPINS ist noch keine Veranstaltung angelegt.
          </p>
        ) : (
          <>
            <div style={{ border: '1px solid var(--c-border)', borderRadius: 7, overflow: 'hidden' }}>
              {(showAll ? [...suggested, ...rest] : suggested).map((e, i) => (
                <Row
                  key={e.id}
                  label={e.name || `Veranstaltung ${e.id}`}
                  date={formatDate(e.date)}
                  matches={e.matchesDate}
                  checked={chosenId === e.id}
                  first={i === 0}
                  onClick={() => choose(e.id)}
                />
              ))}
            </div>
            {!showAll && rest.length > 0 && (
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                style={{ marginTop: 8 }}
                onClick={() => setShowAll(true)}
              >
                Alle {events.length} Veranstaltungen zeigen
              </button>
            )}
            {suggested.length === 0 && (
              <p className="text-xs" style={{ marginTop: 8, marginBottom: 0, color: 'var(--c-text-muted)' }}>
                Keine Veranstaltung passt zum Datum dieser Veranstaltung. Vor dem Renntag
                ist das normal — der Ausrichter legt sie dort oft erst am Morgen an.
              </p>
            )}
          </>
        )
      )}
    </div>
  );
}

function Row({ label, date, matches, checked, onClick, first }: {
  label: string; date: string; matches: boolean; checked: boolean; onClick: () => void; first?: boolean;
}) {
  return (
    <div
      role="radio"
      aria-checked={checked}
      tabIndex={0}
      onClick={onClick}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } }}
      style={{
        display: 'flex', alignItems: 'flex-start', gap: 9, padding: '9px 11px', cursor: 'pointer',
        borderTop: first ? 'none' : '1px solid var(--c-border)',
        background: checked ? '#eff6ff' : 'transparent',
      }}
    >
      <input type="radio" checked={checked} readOnly tabIndex={-1} style={{ marginTop: 2, flexShrink: 0 }} />
      <span style={{ flex: 1, fontSize: 13.5, lineHeight: 1.4 }}>
        {label}
        {matches && (
          <span className="text-xs" style={{ marginLeft: 6, color: 'var(--c-primary)' }}>passt zum Datum</span>
        )}
      </span>
      <span className="text-xs text-muted" style={{ whiteSpace: 'nowrap', marginTop: 2 }}>{date}</span>
    </div>
  );
}
