// Neue Datei — Karte in den Veranstaltungs­einstellungen (⚙️-Tab), analog zu
// CommuniqueSourceSettings.tsx. Verwaltet die manuelle MEV-Startnummern-Liste
// je Altersklasse (Modell MevStartNumber). Reiterleiste über den sechs festen
// AKs (Variante B aus dem Mockup), darunter nur die gerade aktive AK.
//
// Ergänzt lediglich die automatische MEV-Erkennung aus mevDetect.ts —
// ersetzt sie nicht. Siehe dortige Kommentare für den vollen Zusammenhang.
import { useEffect, useState } from 'react';
import { mevStartNumbersApi, MEV_STARTNUMBER_AKS, type MevStartNumber, type MevStartNumberAk } from '../api/client';

export default function MevStartNumbersSettings({ eventId }: { eventId: string }) {
  const [rows, setRows]         = useState<MevStartNumber[]>([]);
  const [loading, setLoading]   = useState(true);
  const [activeAk, setActiveAk] = useState<MevStartNumberAk>('U17m');
  const [no, setNo]             = useState('');
  const [label, setLabel]       = useState('');
  const [saving, setSaving]     = useState(false);
  const [error, setError]       = useState('');

  useEffect(() => {
    let alive = true;
    mevStartNumbersApi.list(eventId)
      .then(list => { if (alive) setRows(list); })
      .catch(() => { /* Liste bleibt leer, Karte zeigt "noch keine hinterlegt" */ })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [eventId]);

  const rowsForAk = rows.filter(r => r.ak === activeAk).sort((a, b) => a.startNo - b.startNo);

  async function add() {
    const startNo = parseInt(no, 10);
    if (!startNo || startNo <= 0) { setError('Bitte eine gültige Startnummer eingeben.'); return; }
    setSaving(true); setError('');
    try {
      const row = await mevStartNumbersApi.add(eventId, { ak: activeAk, startNo, label: label.trim() || undefined });
      setRows(prev => [...prev, row]);
      setNo(''); setLabel('');
    } catch (e: any) {
      setError(e.message ?? 'Speichern fehlgeschlagen');
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: string) {
    const prev = rows;
    setRows(rows.filter(r => r.id !== id)); // optimistisch
    try {
      await mevStartNumbersApi.remove(id);
    } catch (e: any) {
      setRows(prev); // Fehlschlag: alten Stand wiederherstellen
      setError(e.message ?? 'Entfernen fehlgeschlagen');
    }
  }

  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <div style={{ marginBottom: 10 }}>
        <h3 style={{ margin: 0 }}>🔢 MEV-Startnummern</h3>
        <p className="text-xs text-muted" style={{ margin: '4px 0 0' }}>
          Ergänzt die automatische Erkennung aus der LV-Spalte — hilft bei Kommuniqués ohne LV-Spalte weiter,
          wenn dort noch kein anderes Dokument dieser Altersklasse den Fahrer bekannt gemacht hat.
        </p>
      </div>

      {loading ? (
        <p className="text-sm text-muted" style={{ margin: 0 }}>Wird geladen…</p>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 4, overflowX: 'auto', paddingBottom: 4, marginBottom: 12 }}>
            {MEV_STARTNUMBER_AKS.map(ak => {
              const count = rows.filter(r => r.ak === ak).length;
              const active = ak === activeAk;
              return (
                <button
                  key={ak}
                  className={`btn btn-sm ${active ? 'btn-primary' : 'btn-ghost'}`}
                  style={{ flexShrink: 0, borderRadius: 999 }}
                  onClick={() => { setActiveAk(ak); setError(''); }}
                >
                  {ak}{count > 0 ? ` (${count})` : ''}
                </button>
              );
            })}
          </div>

          {rowsForAk.length === 0 ? (
            <p className="text-sm text-muted" style={{ margin: '0 0 10px', fontStyle: 'italic' }}>
              Noch keine Startnummern für {activeAk} hinterlegt.
            </p>
          ) : (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
              {rowsForAk.map(r => (
                <span
                  key={r.id}
                  className="badge badge-yellow"
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 6px 5px 10px' }}
                >
                  #{r.startNo}{r.label ? ` · ${r.label}` : ''}
                  <button
                    onClick={() => remove(r.id)}
                    aria-label="Entfernen"
                    style={{
                      border: 'none', background: 'rgba(0,0,0,.08)', color: 'inherit',
                      width: 16, height: 16, borderRadius: '50%', fontSize: 11, lineHeight: 1,
                      cursor: 'pointer', padding: 0,
                    }}
                  >
                    ✕
                  </button>
                </span>
              ))}
            </div>
          )}

          {error && <div className="alert alert-error">{error}</div>}

          <div style={{ display: 'flex', gap: 6 }}>
            <input
              className="form-input" type="number" inputMode="numeric" placeholder="Nr."
              style={{ width: 84 }}
              value={no}
              onChange={e => setNo(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') add(); }}
            />
            <input
              className="form-input" type="text" placeholder="Name (optional, nur zur Orientierung)"
              style={{ flex: 1, minWidth: 0 }}
              value={label}
              onChange={e => setLabel(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') add(); }}
            />
            <button className="btn btn-primary btn-sm" onClick={add} disabled={saving || !no.trim()}>
              {saving ? '…' : '+ Hinzufügen'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
