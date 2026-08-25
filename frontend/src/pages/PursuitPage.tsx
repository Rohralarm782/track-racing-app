// Zielpfad im Repo: frontend/src/pages/PursuitPage.tsx  (ERSETZT die bestehende Datei)
//
// Änderungen in 1.0.0:
//  - Der seiteneigene Renntimer ist ersatzlos entfernt. Er war eine zweite Kopie
//    des Timers aus VerfolgungsplanungView, nur ohne Speicherpfad — deshalb
//    landeten hier gestoppte Läufe nie im Sportlerprofil, obwohl der CSV-Export
//    funktionierte. Beide Wege benutzen jetzt components/RenntimerView.tsx.
//  - Wird ein Plan mit zugeordneten Sportlern gestartet, bekommt der Timer einen
//    Speicher-Kontext (raceId = null, der Lauf hängt allein am Sportler).
//  - fmtSec/diffStyle/TOLERANCE/DISPLAY_SEC/TEvent liegen jetzt in
//    components/pursuitFormat.ts; die lokalen Duplikate sind weg.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, athletesApi, athleteShortName, type Athlete, type FuehrungsplanData } from '../api/client';
import { useAdmin } from '../components/Layout';
import VerfolgungsplanungView, { PlanSaveData } from '../components/VerfolgungsplanungView';
import RenntimerView, { type RunSaveContext } from '../components/RenntimerView';
import { fmtTime } from '../components/pursuitFormat';

// ── Typen ──────────────────────────────────────────────────────────────────────
interface SavedPlan {
  id: string; notes: string | null; trackM: number;
  numRounds: number; anfahrtSec: number; lapSec: number;
  totalSec: number; selectedKb: number | null; selectedRz: number | null;
  athleteMode: 'einzel' | 'mannschaft' | null;
  athleteIds: string[];
  fuehrungsplan: FuehrungsplanData | null;
  createdAt: string;
}

// ── Konstanten ─────────────────────────────────────────────────────────────────
/** Rundenzahl für "Ohne Plan starten" — ohne Plan gibt es nichts, woraus sich
 *  eine Distanz ableiten ließe; 12 Runden auf 250m sind der Normalfall (3000m). */
const NO_PLAN_ROUNDS = 12;

// ── Hilfsfunktionen ────────────────────────────────────────────────────────────
const planName = (p: SavedPlan | null) => p?.notes ?? 'Verfolgungsrennen';

const DEFAULT_CIRC_MM = 2100;
function rollout(kb: number, rz: number) { return (kb / rz) * (DEFAULT_CIRC_MM / 1000); }
function cadenceFromPlan(p: SavedPlan) {
  if (!p.selectedKb || !p.selectedRz) return null;
  return (p.trackM / p.lapSec / rollout(p.selectedKb, p.selectedRz)) * 60;
}
function formatDate(iso: string) {
  return new Date(iso).toLocaleString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

// ── Führungsplan-Vorschau (read-only, für die Plan-Karte) ───────────────────
const FUEHRUNG_COLORS = ['#1d4ed8', '#16a34a', '#d97706', '#7c3aed', '#db2777', '#0891b2'];
function fmtLaps(n: number): string {
  const rounded = Math.round(n * 4) / 4;
  const whole = Math.floor(rounded + 1e-9);
  const frac = rounded - whole;
  let fracStr = '';
  if (Math.abs(frac - 0.25) < 0.01) fracStr = '¼';
  else if (Math.abs(frac - 0.5) < 0.01) fracStr = '½';
  else if (Math.abs(frac - 0.75) < 0.01) fracStr = '¾';
  if (!fracStr) return `${whole}`;
  return whole > 0 ? `${whole}${fracStr}` : fracStr;
}

type View = 'plans' | 'timer';

// ── Hauptkomponente ────────────────────────────────────────────────────────────
export default function PursuitPage() {
  const { isAdmin } = useAdmin();
  const [view, setView] = useState<View>('plans');

  // ── Pläne ──────────────────────────────────────────────────────────────────
  const [plans, setPlans]       = useState<SavedPlan[]>([]);
  const [loadingP, setLoadingP] = useState(true);
  const [error, setError]       = useState('');
  // Aktuell zum Bearbeiten geöffneter Plan (null = Rechner erstellt einen neuen).
  // key={editingPlan?.id ?? 'new'} weiter unten sorgt dafür, dass der Rechner
  // beim Wechsel zwischen "neu" und "bearbeiten" komplett neu mountet und damit
  // seine Vorbefüllung (initialPlan) frisch übernimmt.
  const [editingPlan, setEditingPlan] = useState<SavedPlan | null>(null);
  const [expandedPlanIds, setExpandedPlanIds] = useState<Set<string>>(new Set());
  function togglePlanExpanded(id: string) {
    setExpandedPlanIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  useEffect(() => {
    api.get<SavedPlan[]>('/api/pursuit-plans')
      .then(setPlans)
      .catch(() => {})
      .finally(() => setLoadingP(false));
  }, []);

  async function handleSave(data: PlanSaveData) {
    setError('');
    try {
      if (editingPlan) {
        const p = await api.patch<SavedPlan>(`/api/pursuit-plans/${editingPlan.id}`, data);
        setPlans(prev => prev.map(x => x.id === p.id ? p : x));
        setEditingPlan(null);
      } else {
        const p = await api.post<SavedPlan>('/api/pursuit-plans', data);
        setPlans(prev => [p, ...prev]);
      }
    } catch (e: any) { setError(e.message); }
  }

  async function deletePlan(id: string) {
    if (!confirm('Plan löschen?')) return;
    await api.delete(`/api/pursuit-plans/${id}`);
    setPlans(p => p.filter(x => x.id !== id));
    if (editingPlan?.id === id) cancelEdit();
  }

  function startEdit(plan: SavedPlan) {
    setEditingPlan(plan);
    setPursuitMode(plan.athleteMode ?? 'einzel');
    setSelectedAthletes(allAthletes.filter(a => plan.athleteIds.includes(a.id)));
    document.getElementById('rechner-anchor')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  function cancelEdit() {
    setEditingPlan(null);
    setPursuitMode('einzel');
    setSelectedAthletes([]);
  }

  // ── Sportlerauswahl (Einzel/Mannschaft) ───────────────────────────────────
  // Rein lokal — die eigenständige /pursuit-Seite hängt an keinem Rennen, es
  // gibt also nichts, woran die Auswahl im Backend hängen könnte. Dient der
  // Gang-Vorauswahl aus dem Sportlerprofil (wie im Renndetail), wird beim
  // Speichern als Teil von PlanSaveData mitgesichert und liefert dem Timer die
  // Sportler, unter deren Profil ein gefahrener Lauf abgelegt wird.
  const [allAthletes, setAllAthletes] = useState<Athlete[]>([]);
  useEffect(() => { athletesApi.list().then(setAllAthletes).catch(() => {}); }, []);
  const [pursuitMode, setPursuitMode]         = useState<'einzel' | 'mannschaft'>('einzel');
  const [selectedAthletes, setSelectedAthletes] = useState<Athlete[]>([]);
  function switchPursuitMode(m: 'einzel' | 'mannschaft') {
    setPursuitMode(m);
    setSelectedAthletes([]);
  }
  function handleAthletesChange(ids: string[]) {
    setSelectedAthletes(allAthletes.filter(a => ids.includes(a.id)));
  }

  // ── Timer ──────────────────────────────────────────────────────────────────
  // Die gesamte Timer-Logik steckt in RenntimerView. Hier wird nur noch
  // festgelegt, MIT WELCHEM Plan gestartet wird und WOHIN der Lauf gespeichert
  // werden darf.
  const [activePlan, setActivePlan] = useState<SavedPlan | null>(null);

  function startWith(plan: SavedPlan | null) {
    setActivePlan(plan);
    setView('timer');
  }

  function endTimer() {
    setActivePlan(null);
    setView('plans');
  }

  /** Anzeigename im Timer: Sportler bzw. Team, sonst der Planname. Kurzform,
   *  weil das während des Rennens auf einen Blick lesbar sein muss. */
  function timerLabelFor(plan: SavedPlan | null): string {
    if (!plan) return 'Verfolgungsrennen';
    const names = plan.athleteIds
      .map(id => allAthletes.find(a => a.id === id))
      .filter((a): a is Athlete => !!a)
      .map(a => athleteShortName(a));
    return names.length > 0 ? names.join(' & ') : planName(plan);
  }

  /** Speicher-Kontext für den Timer. Ohne zugeordnete Sportler gibt es keinen —
   *  ein Lauf ohne Rennen UND ohne Sportler wäre hinterher nirgends auffindbar.
   *  Der Timer weist in dem Fall sichtbar darauf hin. */
  function saveContextFor(plan: SavedPlan | null): RunSaveContext | null {
    if (!plan || plan.athleteIds.length === 0) return null;
    const isTeam = plan.athleteMode === 'mannschaft';
    const riderGears = plan.fuehrungsplan?.riderGears ?? null;
    return {
      raceId: null,
      label: planName(plan),
      eventName: null,
      athleteIds: plan.athleteIds,
      trackM: plan.trackM,
      numRounds: plan.numRounds,
      planAnfahrtSec: plan.anfahrtSec,
      planLapSec: plan.lapSec,
      planTotalSec: plan.totalSec,
      kb: isTeam ? null : plan.selectedKb,
      rz: isTeam ? null : plan.selectedRz,
      gears: isTeam && riderGears
        ? Object.fromEntries(
            Object.entries(riderGears).filter(([, g]) => !!g) as [string, { kb: number; rz: number }][]
          )
        : null,
    };
  }

  // ════════════════════════════════════════════════════════════════════════════
  // VIEW: RENNTIMER
  // ════════════════════════════════════════════════════════════════════════════
  if (view === 'timer') {
    const saveCtx = saveContextFor(activePlan);
    return (
      <div className="page container">
        <div className="breadcrumb">
          <Link to="/">Veranstaltungen</Link><span>›</span>
          <button className="btn btn-ghost btn-sm" style={{ padding: '0 4px', fontSize: 13 }}
            onClick={endTimer}>
            Verfolgung
          </button>
          <span>›</span>{planName(activePlan)}
        </div>

        <RenntimerView
          key={activePlan?.id ?? 'ohne-plan'}
          anfahrtSec={activePlan?.anfahrtSec ?? null}
          lapSec={activePlan?.lapSec ?? null}
          numRounds={activePlan?.numRounds ?? NO_PLAN_ROUNDS}
          planLabel={timerLabelFor(activePlan)}
          save={saveCtx}
          onBack={endTimer}
          backLabel="← Zurück zur Planliste"
        />
      </div>
    );
  }

  // ════════════════════════════════════════════════════════════════════════════
  // VIEW: PLANLISTE + RECHNER
  // ════════════════════════════════════════════════════════════════════════════
  return (
    <div className="page container">
      <div className="breadcrumb">
        <Link to="/">Veranstaltungen</Link><span>›</span>Verfolgung
      </div>
      <div className="flex-between mb-4">
        <h1>Verfolgungsplanung</h1>
        <button className="btn btn-secondary btn-sm" onClick={() => startWith(null)}>
          Ohne Plan starten
        </button>
      </div>

      {error && <div className="alert alert-error mb-3">{error}</div>}

      {/* Gespeicherte Pläne */}
      {loadingP ? (
        <div className="loading"><span className="spinner" /> Lädt…</div>
      ) : plans.length > 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 24 }}>
          {plans.map(plan => {
            const hasGear = plan.selectedKb !== null && plan.selectedRz !== null;
            const ro  = hasGear ? rollout(plan.selectedKb!, plan.selectedRz!) : null;
            const cad = hasGear ? cadenceFromPlan(plan) : null;
            const planAthletes = plan.athleteIds
              .map(id => allAthletes.find(a => a.id === id))
              .filter((a): a is Athlete => !!a);
            const fp = plan.fuehrungsplan;
            const isExpanded = expandedPlanIds.has(plan.id);
            const riderColorFor = (athleteId: string) => {
              const i = fp?.riderOrder.indexOf(athleteId) ?? -1;
              return FUEHRUNG_COLORS[(i < 0 ? 0 : i) % FUEHRUNG_COLORS.length];
            };
            return (
              <div key={plan.id} className="card" style={{ padding: '12px 14px', borderColor: editingPlan?.id === plan.id ? 'var(--c-primary)' : undefined }}>
                <div style={{ fontWeight: 600, fontSize: 14.5 }}>{planName(plan)}</div>
                <div className="text-sm text-muted" style={{ marginTop: 2 }}>
                  {plan.numRounds} Runden · {Math.round(plan.numRounds * plan.trackM)}m ·
                  {' '}{fmtTime(plan.totalSec)} · Rd. 2+ {plan.lapSec.toFixed(2)}s
                </div>

                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 9 }}>
                  <button className="btn btn-secondary btn-sm" onClick={() => togglePlanExpanded(plan.id)}>
                    👁 {isExpanded ? 'Ausblenden' : 'Anzeigen'}
                  </button>
                  <button className="btn btn-primary btn-sm" onClick={() => startWith(plan)}>
                    ⏱ Timer
                  </button>
                  {isAdmin && (
                    <>
                      <button className="btn btn-secondary btn-sm" onClick={() => startEdit(plan)}>
                        ✏️ Bearbeiten
                      </button>
                      <button className="btn btn-ghost btn-sm" style={{ color: 'var(--c-danger)' }} onClick={() => deletePlan(plan.id)}>
                        🗑
                      </button>
                    </>
                  )}
                </div>

                {/* Ohne zugeordnete Sportler kann der Timer den Lauf nirgends
                    ablegen. Der Hinweis gehört vor den Start, nicht ins Ziel. */}
                {plan.athleteIds.length === 0 && (
                  <div className="text-xs" style={{ marginTop: 7, color: 'var(--c-danger)' }}>
                    Kein Sportler zugeordnet — gefahrene Läufe lassen sich nicht speichern.
                  </div>
                )}

                {hasGear && (
                  <div style={{ display: 'inline-flex', alignItems: 'center', gap: 12, background: 'var(--c-primary)', borderRadius: 6, padding: '5px 12px', marginTop: 8 }}>
                    <span style={{ fontWeight: 800, fontSize: 18, color: 'white', letterSpacing: '-0.5px' }}>{plan.selectedKb} / {plan.selectedRz}</span>
                    <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.85)', borderLeft: '1px solid rgba(255,255,255,0.3)', paddingLeft: 10 }}>
                      Rollout {ro!.toFixed(2)} m · {cad!.toFixed(0)} rpm
                    </span>
                  </div>
                )}

                {isExpanded && (
                  <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px dashed var(--c-border)' }}>
                    {planAthletes.length > 0 && (
                      <div className="text-xs text-muted">
                        {plan.athleteMode === 'mannschaft' ? 'Team: ' : 'Sportler: '}
                        {planAthletes.map(a => athleteShortName(a)).join(', ')}
                      </div>
                    )}
                    <div className="text-xs text-muted" style={{ marginTop: 3 }}>{formatDate(plan.createdAt)}</div>

                    {fp && fp.segments.length > 0 && (
                      <>
                        <div style={{ display: 'flex', height: 42, borderRadius: 6, overflow: 'hidden', boxShadow: 'inset 0 0 0 1px var(--c-border)', marginTop: 10, marginBottom: 8 }}>
                          {fp.segments.map((seg, i) => {
                            const segRider = planAthletes.find(a => a.id === seg.athleteId);
                            return (
                              <div key={i} style={{
                                flex: seg.laps, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                                background: riderColorFor(seg.athleteId), color: 'white', padding: '0 2px', minWidth: 0,
                              }}>
                                <span style={{ fontSize: 9, fontWeight: 500, opacity: 0.9, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100%' }}>
                                  {segRider ? athleteShortName(segRider) : ''}
                                </span>
                                <span style={{ fontWeight: 700, fontSize: 11, fontVariantNumeric: 'tabular-nums' }}>{fmtLaps(seg.laps)}</span>
                              </div>
                            );
                          })}
                        </div>
                        <div>
                          {(() => {
                            let cum = 0;
                            return fp.segments.map((seg, i) => {
                              const rider = planAthletes.find(a => a.id === seg.athleteId);
                              const start = cum; cum += seg.laps;
                              return (
                                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0', borderBottom: i < fp.segments.length - 1 ? '1px solid var(--c-border)' : 'none' }}>
                                  <div style={{ width: 17, height: 17, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 9, fontWeight: 700, color: 'white', flexShrink: 0, background: riderColorFor(seg.athleteId) }}>{i + 1}</div>
                                  <span style={{ fontSize: 12.5, fontWeight: 500, flex: 1 }}>{rider ? athleteShortName(rider) : '–'}</span>
                                  <span style={{ fontSize: 10.5, color: 'var(--c-text-muted)' }}>Rd. {fmtLaps(start)}–{fmtLaps(cum)}</span>
                                  <span style={{ fontSize: 12.5, fontWeight: 600, minWidth: 30, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmtLaps(seg.laps)}</span>
                                </div>
                              );
                            });
                          })()}
                        </div>

                        <div style={{ marginTop: 10, paddingTop: 8, borderTop: '1px dashed var(--c-border)' }}>
                          {planAthletes.filter(a => fp.riderModes[a.id] !== 'back').map(a => {
                            const lapSum = fp.segments.filter(s => s.athleteId === a.id).reduce((s, x) => s + x.laps, 0);
                            const segCount = fp.segments.filter(s => s.athleteId === a.id).length;
                            const gear = fp.riderGears?.[a.id] ?? null;
                            return (
                              <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '4px 0', fontSize: 12.5 }}>
                                <span style={{ width: 9, height: 9, borderRadius: '50%', flexShrink: 0, background: riderColorFor(a.id) }} />
                                <span style={{ flex: 1 }}>{athleteShortName(a)}</span>
                                <span style={{ color: 'var(--c-text-muted)', fontSize: 11.5 }}>{fmtLaps(lapSum)} Rd. · {segCount}× vorne</span>
                                <span style={{
                                  fontSize: 11, fontWeight: gear ? 700 : 500, borderRadius: 5, padding: '2px 7px', marginLeft: 8, whiteSpace: 'nowrap',
                                  background: gear ? 'var(--c-primary)' : '#f3f4f6', color: gear ? 'white' : 'var(--c-text-muted)',
                                }}>
                                  {gear ? `${gear.kb}/${gear.rz}` : 'kein Gang'}
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ) : !loadingP && (
        <div className="alert alert-info mb-4" style={{ fontSize: 13 }}>
          Noch kein Plan gespeichert – Rechner unten verwenden und Plan speichern.
        </div>
      )}

      {/* Trennlinie */}
      <div id="rechner-anchor" style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: editingPlan ? 12 : 20, scrollMarginTop: 70 }}>
        <div style={{ flex: 1, height: 1, background: 'var(--c-border)' }} />
        <span style={{ fontSize: 12, color: 'var(--c-text-muted)', whiteSpace: 'nowrap' }}>
          {editingPlan ? 'Plan bearbeiten' : isAdmin ? 'Neuen Plan erstellen' : 'Rechner (lokal, ohne Speichern)'}
        </span>
        <div style={{ flex: 1, height: 1, background: 'var(--c-border)' }} />
      </div>

      {editingPlan && (
        <div className="alert alert-info" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
          <span>Du bearbeitest <strong>{planName(editingPlan)}</strong> — „Änderungen speichern" überschreibt diesen Plan.</span>
          <button className="btn btn-ghost btn-sm" onClick={cancelEdit}>Abbrechen</button>
        </div>
      )}

      {/* Einzel/Mannschaft-Umschalter */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <button
          className={`btn btn-sm ${pursuitMode === 'einzel' ? 'btn-primary' : 'btn-secondary'}`}
          onClick={() => switchPursuitMode('einzel')}
        >
          Einzelverfolgung
        </button>
        <button
          className={`btn btn-sm ${pursuitMode === 'mannschaft' ? 'btn-primary' : 'btn-secondary'}`}
          onClick={() => switchPursuitMode('mannschaft')}
        >
          Mannschaftsverfolgung
        </button>
      </div>

      {/* Rechner */}
      <VerfolgungsplanungView
        key={editingPlan?.id ?? 'new'}
        isAdmin={isAdmin}
        onSave={isAdmin ? handleSave : undefined}
        initialPlan={editingPlan}
        athleteMode={pursuitMode}
        allAthletes={allAthletes}
        selectedAthletes={selectedAthletes}
        onAthletesChange={handleAthletesChange}
        fuehrungsplan={editingPlan?.fuehrungsplan}
      />
    </div>
  );
}
