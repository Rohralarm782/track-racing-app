// Zielpfad im Repo: frontend/src/pages/AthleteDetail.tsx  (ERSETZT die bestehende Datei)
// Änderungen ggü. Original:
//  - Name-Feld in Vorname/Nachname aufgeteilt (siehe schema.prisma)
//  - Die alte Karte "Verfolgungszeiten" (RaceAthlete.timeMs, wurde nirgends
//    geschrieben und war deshalb immer leer) ist durch PursuitRunsCard ersetzt.
//  - 2.3.0: Zwei Reiter. "Übersicht" zeigt die neue Karte "Verfügbare Gänge"
//    (Matrix Kettenblätter × Ritzel) und die gefahrenen Zeiten; die Pflege der
//    Kettenblätter und Ritzel steckt im Reiter "Sportler Einstellungen".
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { athletesApi, athleteFullName, type AthleteDetail as AthleteDetailType } from '../api/client';
import { useAdmin } from '../components/Layout';
import PursuitRunsCard from '../components/PursuitRunsCard';

const GEAR_CHIP: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 6,
  background: 'var(--c-primary)', color: 'white', borderRadius: 7,
  padding: '6px 10px', fontWeight: 700, fontSize: 14, marginRight: 6, marginBottom: 6,
};

type GearKind = 'kettenblaetter' | 'ritzel';
type GearUnit = 'zoll' | 'meter' | 'beides';

/** Radumfang in mm für die Abrolllänge. Fester Wert wie in der
 *  Verfolgungsplanung. Ein je Sportler gemessener Umfang wäre für die
 *  Übersetzungskontrolle genauer, braucht aber ein Feld am Sportler
 *  (Schema) — bewusst ein späterer Ausbauschritt. */
const CIRC_MM = 2100;

/** Zoll-Angabe der gängigen Bahn-Übersetzungskarten: Zähne Kettenblatt durch
 *  Zähne Ritzel, mal 27 (nominelles 27"-Rad). Bewusst NICHT über den
 *  Radumfang gerechnet, sonst stehen hier andere Zahlen als auf der Karte,
 *  die trackside am Rad liegt. */
function gearInches(kb: number, rz: number): number {
  return (kb / rz) * 27;
}
/** Abrolllänge je Kurbelumdrehung in Metern — die Größe, die bei der
 *  Übersetzungskontrolle zählt. */
function rolloutM(kb: number, rz: number): number {
  return (kb / rz) * (CIRC_MM / 1000);
}
const fmtZoll  = (n: number) => n.toFixed(1).replace('.', ',');
const fmtMeter = (n: number) => n.toFixed(2).replace('.', ',');

/** Hintergrund der Matrixzelle: je größer der Gang, desto kräftiger das Blau.
 *  Nur zur Orientierung, die Zahl bleibt die Information. */
function cellShade(z: number, min: number, max: number): string {
  if (max <= min) return 'rgb(224,236,254)';
  const t = (z - min) / (max - min);
  const from = [241, 245, 249], to = [147, 197, 253];
  return `rgb(${from.map((v, i) => Math.round(v + (to[i] - v) * t)).join(',')})`;
}

const TAB_BAR: React.CSSProperties = {
  display: 'flex', gap: 2, background: '#f3f4f6', borderRadius: 9, padding: 3, marginBottom: 16,
};
const UNIT_BAR: React.CSSProperties = {
  display: 'flex', gap: 2, background: '#f3f4f6', borderRadius: 8, padding: 2,
};

/** Karte "Verfügbare Gänge": alle Kombinationen aus den hinterlegten
 *  Kettenblättern und Ritzeln als Matrix, umschaltbar zwischen Zoll,
 *  Abrolllänge in Metern und beidem. */
function GearOverviewCard({ kettenblaetter, ritzel, canEdit, onGoSettings }: {
  kettenblaetter: number[];
  ritzel: number[];
  canEdit: boolean;
  onGoSettings: () => void;
}) {
  const [unit, setUnit] = useState<GearUnit>('zoll');

  const kbs = [...kettenblaetter].sort((a, b) => a - b);
  const rzs = [...ritzel].sort((a, b) => a - b);

  if (kbs.length === 0 || rzs.length === 0) {
    const missing = kbs.length === 0 && rzs.length === 0
      ? 'Kettenblätter und Ritzel'
      : kbs.length === 0 ? 'Kettenblätter' : 'Ritzel';
    return (
      <div className="card mb-3">
        <h3 style={{ marginBottom: 10 }}>Verfügbare Gänge</h3>
        <p className="text-sm text-muted" style={{ marginTop: 0, marginBottom: canEdit ? 10 : 0 }}>
          Es sind noch keine {missing} hinterlegt, daher lassen sich keine Gänge berechnen.
        </p>
        {canEdit && (
          <button className="btn btn-secondary btn-sm" onClick={onGoSettings}>
            {missing} in Sportler Einstellungen eintragen
          </button>
        )}
      </div>
    );
  }

  const values = kbs.flatMap(kb => rzs.map(rz => gearInches(kb, rz)));
  const min = Math.min(...values), max = Math.max(...values);
  const showMeter = unit === 'meter' || unit === 'beides';

  const unitBtn = (v: GearUnit, label: string) => (
    <button key={v} onClick={() => setUnit(v)}
      style={{
        border: 'none', borderRadius: 6, padding: '5px 11px', fontSize: 12.5, fontWeight: 600,
        cursor: 'pointer', fontFamily: 'inherit',
        background: unit === v ? 'var(--c-white)' : 'transparent',
        color: unit === v ? 'var(--c-text)' : 'var(--c-text-muted)',
        boxShadow: unit === v ? '0 1px 2px rgba(0,0,0,0.08)' : 'none',
      }}>
      {label}
    </button>
  );

  return (
    <div className="card mb-3">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
        <h3>Verfügbare Gänge</h3>
        <div style={UNIT_BAR}>
          {unitBtn('zoll', 'Zoll')}
          {unitBtn('meter', 'Meter')}
          {unitBtn('beides', 'beides')}
        </div>
      </div>

      <div style={{ overflowX: 'auto', margin: '0 -4px', padding: '0 4px' }}>
        <table style={{ borderCollapse: 'separate', borderSpacing: 4, fontVariantNumeric: 'tabular-nums' }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left', fontSize: 10.5, lineHeight: 1.2, fontWeight: 600, color: 'var(--c-text-muted)', paddingRight: 10 }}>
                KB ↓<br />R →
              </th>
              {rzs.map(rz => (
                <th key={rz} scope="col" style={{ fontSize: 13, fontWeight: 700, padding: '0 4px 4px' }}>{rz}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {kbs.map(kb => (
              <tr key={kb}>
                <th scope="row" style={{ position: 'sticky', left: 0, background: 'var(--c-white)', textAlign: 'left', fontSize: 13, fontWeight: 700, paddingRight: 12 }}>
                  {kb}
                </th>
                {rzs.map(rz => {
                  const z = gearInches(kb, rz), m = rolloutM(kb, rz);
                  return (
                    <td key={rz} style={{
                      minWidth: 62, height: 44, borderRadius: 7, textAlign: 'center',
                      background: cellShade(z, min, max),
                    }}
                      title={`${kb}/${rz} — ${fmtZoll(z)}″ · ${fmtMeter(m)} m`}>
                      <span style={{ display: 'block', fontSize: 15, fontWeight: 600 }}>
                        {unit === 'meter' ? `${fmtMeter(m)} m` : `${fmtZoll(z)}″`}
                      </span>
                      {unit === 'beides' && (
                        <span style={{ display: 'block', fontSize: 11, color: 'var(--c-text-muted)', marginTop: 1 }}>
                          {fmtMeter(m)} m
                        </span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-muted" style={{ marginTop: 10, marginBottom: 0 }}>
        Zoll = Kettenblatt / Ritzel × 27
        {showMeter && ` · Meter = Abrolllänge je Kurbelumdrehung bei ${CIRC_MM} mm Radumfang`}
        {' · '}{kbs.length} Kettenblätter × {rzs.length} Ritzel
      </p>
    </div>
  );
}

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

  // ── Reiter ───────────────────────────────────────────────────────────────
  // Bewusst nur lokaler Zustand, keine Route und kein Query-Parameter: nach
  // einem Neuladen steht das Profil wieder auf "Übersicht".
  const [tab, setTab] = useState<'uebersicht' | 'einstellungen'>('uebersicht');

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

      <div style={TAB_BAR}>
        {([['uebersicht', 'Übersicht'], ['einstellungen', '⚙️ Sportler Einstellungen']] as const).map(([key, label]) => (
          <button key={key} onClick={() => setTab(key)}
            style={{
              flex: 1, padding: '7px', border: 'none', borderRadius: 7,
              background: tab === key ? 'var(--c-white)' : 'transparent',
              color: tab === key ? 'var(--c-text)' : 'var(--c-text-muted)',
              boxShadow: tab === key ? '0 1px 2px rgba(0,0,0,0.08)' : 'none',
              fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
            }}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'uebersicht' && (
        <GearOverviewCard
          kettenblaetter={athlete.kettenblaetter}
          ritzel={athlete.ritzel}
          canEdit={isAdmin}
          onGoSettings={() => setTab('einstellungen')}
        />
      )}

      {tab === 'einstellungen' && (
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
      )}

      {tab === 'uebersicht' && (
        <PursuitRunsCard
          athleteId={athlete.id}
          athlete={athlete}
          runs={athlete.runs ?? []}
          isAdmin={isAdmin}
          onChanged={load}
        />
      )}
    </div>
  );
}
