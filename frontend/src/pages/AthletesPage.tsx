// Zielpfad im Repo: frontend/src/pages/AthletesPage.tsx  (ERSETZT die bestehende Datei)
// Änderungen ggü. Original: Name-Feld in Vorname/Nachname aufgeteilt (siehe
// schema.prisma), Liste zeigt vollen Namen (athleteFullName) zur Übersicht/
// Disambiguierung; in Renn-Kontexten (VerfolgungsplanungView) wird stattdessen
// athleteShortName (nur Vorname) verwendet.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { athletesApi, athleteFullName, type Athlete } from '../api/client';
import { useAdmin } from '../components/Layout';

export default function AthletesPage() {
  const { isAdmin } = useAdmin();
  const [athletes, setAthletes] = useState<Athlete[]>([]);
  const [loading, setLoading]   = useState(true);
  const [showNew, setShowNew]   = useState(false);
  const [vorname, setVorname]   = useState('');
  const [nachname, setNachname] = useState('');
  const [ak, setAk]             = useState('');
  const [saving, setSaving]     = useState(false);
  const [error, setError]       = useState('');

  function load() {
    setLoading(true);
    athletesApi.list().then(setAthletes).catch(e => setError(e.message)).finally(() => setLoading(false));
  }
  useEffect(load, []);

  async function createAthlete() {
    if (!vorname.trim() || !nachname.trim()) return;
    setSaving(true); setError('');
    try {
      await athletesApi.create({ vorname: vorname.trim(), nachname: nachname.trim(), ak: ak.trim() || null });
      setVorname(''); setNachname(''); setAk(''); setShowNew(false);
      load();
    } catch (e: any) { setError(e.message ?? 'Fehler'); }
    finally { setSaving(false); }
  }

  return (
    <div className="page container">
      <div className="breadcrumb">
        <Link to="/">Veranstaltungen</Link><span>›</span>Sportler
      </div>
      <div className="flex-between mb-4">
        <h1>Sportler</h1>
        {isAdmin && (
          <button className="btn btn-primary btn-sm" onClick={() => setShowNew(v => !v)}>
            {showNew ? '✕ Schließen' : '+ Neuer Sportler'}
          </button>
        )}
      </div>

      {error && <div className="alert alert-error mb-3">{error}</div>}

      {showNew && (
        <div className="card mb-3" style={{ borderColor: '#bfdbfe', background: '#f0f7ff' }}>
          <div className="grid-3">
            <div className="form-group" style={{ margin: 0 }}>
              <label className="form-label">Vorname</label>
              <input
                className="form-input"
                value={vorname}
                onChange={e => setVorname(e.target.value)}
                placeholder="z.B. Max"
                onKeyDown={e => e.key === 'Enter' && createAthlete()}
                autoFocus
              />
            </div>
            <div className="form-group" style={{ margin: 0 }}>
              <label className="form-label">Nachname</label>
              <input
                className="form-input"
                value={nachname}
                onChange={e => setNachname(e.target.value)}
                placeholder="z.B. Mustermann"
                onKeyDown={e => e.key === 'Enter' && createAthlete()}
              />
            </div>
            <div className="form-group" style={{ margin: 0 }}>
              <label className="form-label">Altersklasse</label>
              <input className="form-input" value={ak} onChange={e => setAk(e.target.value)} placeholder="z.B. U17 m" />
            </div>
          </div>
          <div className="flex-between mt-3">
            <button className="btn btn-ghost btn-sm" onClick={() => setShowNew(false)}>Abbrechen</button>
            <button className="btn btn-primary" onClick={createAthlete} disabled={saving || !vorname.trim() || !nachname.trim()}>
              {saving ? 'Speichert…' : 'Sportler anlegen'}
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="loading"><span className="spinner" /> Lädt…</div>
      ) : athletes.length === 0 ? (
        <div className="empty"><p>Noch keine Sportler angelegt.</p></div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {athletes.map(a => (
            <Link key={a.id} to={`/athletes/${a.id}`} className="card card-link" style={{ display: 'block' }}>
              <div className="flex-between">
                <div>
                  <span style={{ fontWeight: 600, fontSize: 14.5 }}>{athleteFullName(a)}</span>
                  {a.ak && <span className="badge badge-blue" style={{ marginLeft: 8 }}>{a.ak}</span>}
                  <div className="text-xs text-muted" style={{ marginTop: 4 }}>
                    {a.kettenblaetter.length} Kettenblätter · {a.ritzel.length} Ritzel · {a._count?.raceLinks ?? 0} Zeiten
                  </div>
                </div>
                <span className="text-muted">›</span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
