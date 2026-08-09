import { useEffect, useState } from 'react';
import { communiquesApi, type CommuniqueSectionScan } from '../api/client';
import { normalizeSectionLabel } from '../lib/communiqueSource';

// Auswahl des Seiten-Abschnitts für HTML-Quellen.
//
// Viele Vereinsseiten sammeln jahrelang alle Veranstaltungen auf einer Seite
// (frc90.de: vier Sichtungen, ~158 PDFs). Ohne Einschränkung landet alles in
// einer Veranstaltung. Hier wird die Seite auf Wunsch gelesen, in ihre
// Überschriften-Blöcke zerlegt und der passende Block ausgewählt.
//
// Bewusst kein automatisches Prüfen beim Tippen und keine Vorauswahl: welcher
// Abschnitt gemeint ist, weiß nur der Mensch — eine geratene Vorauswahl würde
// man beim schnellen Durchklicken übersehen.

interface Props {
  /** Aktuell eingetragene Seiten-URLs (aus der Eingabe, noch nicht gespeichert). */
  pageUrls: string[];
  /** Gewählte Abschnitts-Labels; leer = ganze Seite. */
  value: string[];
  onChange: (sections: string[]) => void;
  /** Für den Scan-Endpunkt. */
  eventId: string;
}

export default function CommuniqueSectionPicker({ pageUrls, value, onChange, eventId }: Props) {
  const [scan, setScan]       = useState<CommuniqueSectionScan | null>(null);
  const [busy, setBusy]       = useState(false);
  const [error, setError]     = useState('');

  // Ändern sich die URLs, passt ein alter Scan nicht mehr dazu.
  const urlKey = pageUrls.join('\n');
  useEffect(() => { setScan(null); setError(''); }, [urlKey]);

  async function runScan() {
    if (pageUrls.length === 0) return;
    setBusy(true); setError('');
    try {
      setScan(await communiquesApi.scanSections(eventId, pageUrls));
    } catch (e: any) {
      setError(e.message ?? 'Seite konnte nicht gelesen werden.');
    } finally {
      setBusy(false);
    }
  }

  const selected = new Set(value.map(normalizeSectionLabel));

  function toggle(label: string) {
    const norm = normalizeSectionLabel(label);
    onChange(selected.has(norm)
      ? value.filter(v => normalizeSectionLabel(v) !== norm)
      : [...value, label]);
  }

  const allSections = scan ? scan.pages.flatMap(p => p.sections) : [];
  const chosen = allSections.filter(s => selected.has(normalizeSectionLabel(s.label)));
  const chosenCount = chosen.reduce((sum, s) => sum + s.count, 0);
  const pageErrors = scan ? scan.pages.filter(p => p.error) : [];

  return (
    <div style={{ borderTop: '1px solid var(--c-border)', paddingTop: 12, marginTop: 12 }}>
      <div className="flex-between" style={{ alignItems: 'center', marginBottom: 4 }}>
        <strong style={{ fontSize: 14 }}>Abschnitt der Seite</strong>
        <button className="btn btn-secondary btn-sm" type="button" onClick={runScan} disabled={busy || pageUrls.length === 0}>
          {busy ? 'Liest…' : scan ? 'Erneut prüfen' : 'Seite prüfen'}
        </button>
      </div>
      <p className="text-sm text-muted" style={{ marginTop: 0, marginBottom: 10 }}>
        Enthält die Seite mehrere Veranstaltungen, hier den passenden Abschnitt
        wählen. Ohne Auswahl werden alle Dokumente der Seite übernommen.
      </p>

      {error && <div className="alert alert-error" style={{ marginBottom: 10 }}>{error}</div>}

      {value.length > 0 && !scan && (
        <div className="text-sm" style={{ marginBottom: 10 }}>
          Gewählt: {value.join(' + ')}
        </div>
      )}

      {scan && (
        <>
          {pageErrors.map(p => (
            <div key={p.url} className="alert alert-error" style={{ marginBottom: 10 }}>
              {p.url}: {p.error}
            </div>
          ))}

          {allSections.length === 0 ? (
            <p className="text-sm text-muted" style={{ margin: 0 }}>
              Keine Abschnitte erkannt — die Seite gehört offenbar zu einer einzelnen
              Veranstaltung. Alle {scan.totalCount} gefundenen Dokumente werden übernommen.
            </p>
          ) : (
            <>
              <div style={{ border: '1px solid var(--c-border)', borderRadius: 7, overflow: 'hidden' }}>
                <Row
                  label="Ganze Seite (kein Filter)"
                  count={scan.totalCount}
                  checked={value.length === 0}
                  first
                  onClick={() => onChange([])}
                />
                {allSections.map(s => (
                  <Row
                    key={s.label}
                    label={s.label}
                    count={s.count}
                    checked={selected.has(normalizeSectionLabel(s.label))}
                    onClick={() => toggle(s.label)}
                  />
                ))}
              </div>

              <p className="text-xs" style={{ marginTop: 8, marginBottom: 0, color: 'var(--c-text-muted)' }}>
                {value.length === 0
                  ? `Alle ${scan.totalCount} Dokumente der Seite werden übernommen — auch die aus Vorjahren.`
                  : chosenCount === 0
                    ? 'In diesem Abschnitt stehen noch keine PDFs. Normal, solange der Ausrichter nichts veröffentlicht hat — neue Dateien tauchen von selbst auf.'
                    : `${chosenCount} Dokumente werden übernommen, ${scan.totalCount - chosenCount} aus anderen Abschnitten bleiben außen vor.`}
              </p>
            </>
          )}
        </>
      )}
    </div>
  );
}

function Row({ label, count, checked, onClick, first }: {
  label: string; count: number; checked: boolean; onClick: () => void; first?: boolean;
}) {
  return (
    <div
      role="checkbox"
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
      <input type="checkbox" checked={checked} readOnly tabIndex={-1} style={{ marginTop: 2, flexShrink: 0 }} />
      <span style={{ flex: 1, fontSize: 13.5, lineHeight: 1.4 }}>{label}</span>
      <span className="text-xs text-muted" style={{ whiteSpace: 'nowrap', marginTop: 2 }}>
        {count} PDF
      </span>
    </div>
  );
}
