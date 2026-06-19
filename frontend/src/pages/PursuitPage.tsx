import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { useAdmin } from '../components/Layout';
import VerfolgungsplanungView, { PlanSaveData, fmtTime } from '../components/VerfolgungsplanungView';

// ── Typen ──────────────────────────────────────────────────────────────────────
interface SavedPlan {
  id: string;
  trackM: number;
  numRounds: number;
  anfahrtSec: number;
  lapSec: number;
  totalSec: number;
  selectedKb: number | null;
  selectedRz: number | null;
  notes: string | null;
  createdAt: string;
}

const DEFAULT_CIRC_MM = 2100;

function rollout(kb: number, rz: number): number {
  return (kb / rz) * (DEFAULT_CIRC_MM / 1000);
}
function cadenceFromPlan(plan: SavedPlan): number {
  const speedMs = plan.trackM / plan.lapSec;
  const dev = (plan.selectedKb! / plan.selectedRz!) * (DEFAULT_CIRC_MM / 1000);
  return (speedMs / dev) * 60;
}
function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('de-DE', {
    weekday: 'short', day: '2-digit', month: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
}

// ── Kompakte Plan-Karte ────────────────────────────────────────────────────────
function SavedPlanCard({ plan, isAdmin, onDelete }: {
  plan: SavedPlan;
  isAdmin: boolean;
  onDelete: () => void;
}) {
  const hasGear    = plan.selectedKb !== null && plan.selectedRz !== null;
  const ro         = hasGear ? rollout(plan.selectedKb!, plan.selectedRz!) : null;
  const cad        = hasGear ? cadenceFromPlan(plan) : null;
  const totalDistM = Math.round(plan.numRounds * plan.trackM);

  return (
    <div className="card mb-3" style={{ border: '1.5px solid var(--c-primary)', background: '#f8fbff', padding: '12px 16px' }}>
      {/* Header */}
      <div className="flex-between" style={{ marginBottom: 8 }}>
        <div>
          {plan.notes && <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 1 }}>{plan.notes}</div>}
          <div style={{ fontSize: 11, color: 'var(--c-text-muted)' }}>{formatDate(plan.createdAt)}</div>
        </div>
        {isAdmin && (
          <button className="btn btn-ghost btn-sm" style={{ color: 'var(--c-danger)', fontSize: 11 }} onClick={onDelete}>
            Löschen
          </button>
        )}
      </div>

      {/* Metriken */}
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'baseline', marginBottom: hasGear ? 10 : 0 }}>
        <span style={{ fontSize: 13, color: 'var(--c-text-muted)' }}>
          Zielzeit <strong style={{ color: 'var(--c-text)', fontSize: 14 }}>{fmtTime(plan.totalSec)}</strong>
        </span>
        <span style={{ fontSize: 13, color: 'var(--c-text-muted)' }}>
          Rundenzeit <strong style={{ color: 'var(--c-text)', fontSize: 14 }}>{plan.lapSec.toFixed(2)}s</strong>
        </span>
        <span style={{ fontSize: 13, color: 'var(--c-text-muted)' }}>
          {plan.numRounds} Runden · <strong style={{ color: 'var(--c-text)' }}>{totalDistM}m</strong>
        </span>
      </div>

      {/* Gang */}
      {hasGear && (
        <div style={{
          background: 'var(--c-primary)', borderRadius: 7, padding: '8px 14px',
          display: 'flex', alignItems: 'center', gap: 16,
        }}>
          <div style={{ fontWeight: 900, fontSize: 24, color: 'white', letterSpacing: '-1px', lineHeight: 1 }}>
            {plan.selectedKb} / {plan.selectedRz}
          </div>
          <div style={{ borderLeft: '1px solid rgba(255,255,255,0.3)', paddingLeft: 14, fontSize: 12 }}>
            <div style={{ color: 'rgba(255,255,255,0.85)' }}>
              Rollout <strong style={{ color: 'white' }}>{ro!.toFixed(2)} m</strong>
            </div>
            <div style={{ color: 'rgba(255,255,255,0.85)', marginTop: 2 }}>
              <strong style={{ color: 'white' }}>{cad!.toFixed(0)} rpm</strong>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Hauptseite ────────────────────────────────────────────────────────────────
export default function PursuitPage() {
  const { isAdmin } = useAdmin();
  const [plans, setPlans]             = useState<SavedPlan[]>([]);
  const [loadingPlans, setLoadingPlans] = useState(true);
  const [error, setError]             = useState('');

  useEffect(() => { loadPlans(); }, []);

  async function loadPlans() {
    try {
      const data = await api.get<SavedPlan[]>('/api/pursuit-plans');
      setPlans(data ?? []);
    } catch {
      // Keine Pläne – kein Fehler für den User
    } finally {
      setLoadingPlans(false);
    }
  }

  async function handleSave(data: PlanSaveData) {
    setError('');
    try {
      const plan = await api.post<SavedPlan>('/api/pursuit-plans', data);
      setPlans(prev => [plan, ...prev]);
    } catch (e: any) {
      setError(e.message);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm('Plan löschen?')) return;
    try {
      await api.delete(`/api/pursuit-plans/${id}`);
      setPlans(prev => prev.filter(p => p.id !== id));
    } catch (e: any) {
      setError(e.message);
    }
  }

  return (
    <div className="page container">
      <div className="flex-between mb-4">
        <div>
          <h1>Verfolgungsplanung</h1>
          <p className="text-sm text-muted" style={{ margin: '2px 0 0' }}>Gangplanung und Schrittmacherrechner</p>
        </div>
      </div>

      {error && <div className="alert alert-error mb-3">{error}</div>}

      {/* Gespeicherte Pläne — für alle sichtbar */}
      {!loadingPlans && plans.length > 0 && (
        <div className="mb-4">
          {plans.map(plan => (
            <SavedPlanCard
              key={plan.id}
              plan={plan}
              isAdmin={isAdmin}
              onDelete={() => handleDelete(plan.id)}
            />
          ))}
        </div>
      )}

      {!loadingPlans && plans.length === 0 && !isAdmin && (
        <div className="alert alert-info mb-4" style={{ fontSize: 13 }}>
          Noch kein Plan gespeichert – der Trainer kann den Rechner unten verwenden und einen Plan speichern.
        </div>
      )}

      {/* Trennlinie */}
      {plans.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
          <div style={{ flex: 1, height: 1, background: 'var(--c-border)' }} />
          <span style={{ fontSize: 12, color: 'var(--c-text-muted)', whiteSpace: 'nowrap' }}>
            {isAdmin ? 'Neuen Plan erstellen' : 'Rechner (lokal, ohne Speichern)'}
          </span>
          <div style={{ flex: 1, height: 1, background: 'var(--c-border)' }} />
        </div>
      )}

      {/* Rechner */}
      <VerfolgungsplanungView isAdmin={isAdmin} onSave={isAdmin ? handleSave : undefined} />
    </div>
  );
}
