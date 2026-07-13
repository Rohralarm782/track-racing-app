// Zielpfad im Repo: frontend/src/pages/AthleteDetail.tsx  (ERSETZT die bestehende Datei)
// Änderungen ggü. Original: Name-Feld in Vorname/Nachname aufgeteilt (siehe
// schema.prisma) — Anzeige nutzt athleteFullName, Bearbeiten hat zwei Felder.
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { athletesApi, athleteFullName, type AthleteDetail as AthleteDetailType } from '../api/client';
import { useAdmin } from '../components/Layout';

function fmtRough(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

const GEAR_CHIP: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 6,
  background: 'var(--c-primary)', color: 'white', borderRadius: 7,
  padding: '6px 10px', fontWeight: 700, fontSize: 14, marginRight: 6, marginBottom: 6,
};

type GearKind = 'kettenblaetter' | 'ritzel';

export default function AthleteDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { isAdmin } = useAdmin();
  const [athlete, setAthlete] = useState<AthleteDetailType | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');

  // ── Bearbeiten Vorname/Nachname/AK ────────────────────────────────────────
  const [editing, setEditing]   = useState(false);
  const [vorname, setVorname]   = useState('');
  const [nachname, setNachname] = useState('');
  const [ak, setAk]             = useState('');
  const [saving, setSaving]     = useState(false);

  // ── Gear-Eingabe ─────────────────────────────────────────────────────────
  const [newKb, setNewKb] = useState('');
  const [newRz, setNewRz] = useState('');

  function load() {
    if (!id) return;
    setLoading(true);
    athletesApi.get(id).then(setAthlete).catch(e => setError(e.message)).finally(() => setLoading(false));
  }
  useEffect(load, [id]);

  function startEdit() {
    if (!athlete) return;
    setVorname(athlete.vorname); setNachname(athlete.nachname); setAk(athlete.ak ?? ''); setEditing(true);
  }

  async function saveEdit() {
    if (!id || !vorname.trim() || !nachname.trim()) return;
    setSaving(true); setError('');
    try {
      await athletesApi.update(id, { vorname: vorname.trim(), nachname: nachname.trim(), ak: ak.trim() || null });
      setEditing(false);
      load();
    } catch (e: any) { setError(e.message ?? 'Fehler'); }
    finally { setSaving(false); }
  }

  async function deleteAthlete() {
    if (!id || !athlete) return;
    if (!confirm(`Sportlerprofil "${athleteFullName(athlete)}" wirklich löschen?`)) return;
    try {
      await athletesApi.delete(id);
      navigate('/athletes');
    } catch (e: any) { alert(e.message ?? 'Fehler beim Löschen'); }
  }

  async function addGear(kind: GearKind) {
    if (!id || !athlete) return;
    const raw = kind === 'kettenblaetter' ? newKb : newRz;
    const val = parseInt(raw, 10);
    if (!val || val <= 0) return;
    const current = athlete[kind];
    if (current.includes(val)) { kind === 'kettenblaetter' ? setNewKb('') : setNewRz(''); return; }
    const updated = [...current, val].sort((a, b) => a - b);
    try {
      await athletesApi.update(id, { [kind]: updated } as any);
      kind === 'kettenblaetter' ? setNewKb('') : setNewRz('');
      load();
    } catch (e: any) { setError(e.message ?? 'Fehler'); }
  }

  async function removeGear(kind: GearKind, val: number) {
    if (!id || !athlete) return;
    const updated = athlete[kind].filter(v => v !== val);
    try {
      await athletesApi.update(id, { [kind]: updated } as any);
      load();
    } catch (e: any) { setError(e.message ?? 'Fehler'); }
  }

  if (loading) return <div className="page container"><div className="loading"><span className="spinner" /> Lädt…</div></div>;
  if (!athlete) return <div className="page container"><div className="alert alert-error">{error || 'Nicht gefunden'}</div></div>;

  return (
    <div className="page container">
      <div className="breadcrumb">
        <Link to="/athletes">Sportler</Link><span>›</span>{athleteFullName(athlete)}
      </div>

      {error && <div className="alert alert-error mb-3">{error}</div>}

      <div className="flex-between mb-4">
        {editing ? (
          <div className="grid-3" style={{ gap: 10, flex: 1, marginRight: 12 }}>
            <input className="form-input" value={vorname} onChange={e => setVorname(e.target.value)} placeholder="Vorname" autoFocus />
            <input className="form-input" value={nachname} onChange={e => setNachname(e.target.value)} placeholder="Nachname" />
            <input className="form-input" value={ak} onChange={e => setAk(e.target.value)} placeholder="AK" />
          </div>
        ) : (
          <h1>
            {athleteFullName(athlete)}{' '}
            {athlete.ak && <span className="badge badge-blue" style={{ verticalAlign: 2 }}>{athlete.ak}</span>}
          </h1>
        )}
        {isAdmin && (
          <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
            {editing ? (
              <>
                <button className="btn btn-ghost btn-sm" onClick={() => setEditing(false)}>Abbrechen</button>
                <button className="btn btn-primary btn-sm" onClick={saveEdit} disabled={saving || !vorname.trim() || !nachname.trim()}>
                  {saving ? '…' : 'Speichern'}
                </button>
              </>
            ) : (
              <>
                <button className="btn btn-secondary btn-sm" onClick={startEdit}>Bearbeiten</button>
                <button className="btn btn-ghost btn-sm" style={{ color: 'var(--c-danger)' }} onClick={deleteAthlete}>Löschen</button>
              </>
            )}
          </div>
        )}
      </div>

      <div className="card mb-3">
        <h3 style={{ marginBottom: 14 }}>Verfügbare Ausstattung</h3>

        <div style={{ marginBottom: 16 }}>
          <span className="text-xs text-muted" style={{ textTransform: 'uppercase', fontWeight: 600, letterSpacing: '.03em' }}>
            Kettenblätter
          </span>
          <div style={{ marginTop: 8 }}>
            {athlete.kettenblaetter.map(kb => (
              <span key={kb} style={GEAR_CHIP}>
                {kb} Z
                {isAdmin && (
                  <button onClick={() => removeGear('kettenblaetter', kb)}
                    style={{ background: 'none', border: 'none', color: 'white', cursor: 'pointer', opacity: 0.75, fontSize: 13, padding: 0 }}>
                    ✕
                  </button>
                )}
              </span>
            ))}
            {athlete.kettenblaetter.length === 0 && <span className="text-sm text-muted">Keine hinterlegt</span>}
          </div>
          {isAdmin && (
            <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
              <input className="form-input" style={{ width: 90 }} type="number" placeholder="z.B. 52" value={newKb}
                onChange={e => setNewKb(e.target.value)} onKeyDown={e => e.key === 'Enter' && addGear('kettenblaetter')} />
              <button className="btn btn-secondary btn-sm" onClick={() => addGear('kettenblaetter')}>+ hinzufügen</button>
            </div>
          )}
        </div>

        <div>
          <span className="text-xs text-muted" style={{ textTransform: 'uppercase', fontWeight: 600, letterSpacing: '.03em' }}>
            Ritzel
          </span>
          <div style={{ marginTop: 8 }}>
            {athlete.ritzel.map(rz => (
              <span key={rz} style={GEAR_CHIP}>
                {rz} Z
                {isAdmin && (
                  <button onClick={() => removeGear('ritzel', rz)}
                    style={{ background: 'none', border: 'none', color: 'white', cursor: 'pointer', opacity: 0.75, fontSize: 13, padding: 0 }}>
                    ✕
                  </button>
                )}
              </span>
            ))}
            {athlete.ritzel.length === 0 && <span className="text-sm text-muted">Keine hinterlegt</span>}
          </div>
          {isAdmin && (
            <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
              <input className="form-input" style={{ width: 90 }} type="number" placeholder="z.B. 14" value={newRz}
                onChange={e => setNewRz(e.target.value)} onKeyDown={e => e.key === 'Enter' && addGear('ritzel')} />
              <button className="btn btn-secondary btn-sm" onClick={() => addGear('ritzel')}>+ hinzufügen</button>
            </div>
          )}
        </div>

        <p className="text-xs text-muted" style={{ marginTop: 12, marginBottom: 0 }}>
          Frei kombinierbar — kein fester Satz, sondern was am Rad verfügbar ist.
        </p>
      </div>

      <div className="card">
        <h3 style={{ marginBottom: 10 }}>Verfolgungszeiten</h3>
        {athlete.times.length === 0 ? (
          <p className="text-sm text-muted" style={{ margin: 0 }}>
            Noch keine Zeiten hinterlegt — werden ergänzt, sobald ein Ergebnis aus einem Verfolgungsrennen übernommen wird.
          </p>
        ) : (
          <>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr><th>Rennen</th><th>Distanz</th><th style={{ textAlign: 'right' }}>Zeit</th></tr>
                </thead>
                <tbody>
                  {athlete.times.map(t => (
                    <tr key={t.raceId}>
                      <td>
                        {t.raceName}
                        {t.eventName && <span className="text-xs text-muted"> · {t.eventName}</span>}
                      </td>
                      <td className="text-muted text-sm">{t.distanceM ? `${t.distanceM}m` : '—'}</td>
                      <td style={{ textAlign: 'right', fontWeight: 600 }}>{fmtRough(t.timeMs)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-muted" style={{ marginTop: 8, marginBottom: 0 }}>
              Grobe Orientierung, keine Hundertstel.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
