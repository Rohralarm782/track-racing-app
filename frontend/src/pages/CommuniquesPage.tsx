import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  api, communiquesApi,
  type CommuniqueSource, type Event as EventT,
} from '../api/client';

const AK_OPTIONS = ['U15m', 'U15w', 'U17m', 'U17w', 'U19m', 'U19w', 'Elite m', 'Elite w'];
const DISCIPLINE_LABELS: Record<string, string> = { Alle: 'Alle', SPRINT: 'Sprint', AUSDAUER: 'Ausdauer' };
const CAT_LABELS: Record<string, string> = { alle: 'Alle', STARTLISTE: 'Startlisten', ERGEBNIS: 'Ergebnisse', SONSTIGES: 'Sonstiges' };
const CAT_ICON: Record<string, string> = { STARTLISTE: '📋', ERGEBNIS: '🏁', SONSTIGES: '📄' };

// ── Helpers ────────────────────────────────────────────────────────────────
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map(c => c.charCodeAt(0)));
}

function extractShareToken(input: string): string | null {
  const match = input.match(/\/s\/([A-Za-z0-9]+)/);
  if (match) return match[1];
  if (/^[A-Za-z0-9]{8,}$/.test(input)) return input;
  return null;
}

function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diffMs / 60000);
  if (min < 1) return 'gerade eben';
  if (min < 60) return `vor ${min} Min.`;
  const h = Math.floor(min / 60);
  if (h < 24) return `vor ${h} Std.`;
  return `vor ${Math.floor(h / 24)} Tg.`;
}

function readIds(sourceId: string): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(`communique_read_${sourceId}`) ?? '[]'));
  } catch { return new Set(); }
}
function persistReadIds(sourceId: string, ids: Set<string>) {
  localStorage.setItem(`communique_read_${sourceId}`, JSON.stringify([...ids]));
}

// ── Komponente ─────────────────────────────────────────────────────────────
export default function CommuniquesPage() {
  const { id: eventId } = useParams<{ id: string }>();

  const [event, setEvent]   = useState<EventT | null>(null);
  const [source, setSource] = useState<CommuniqueSource | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');

  // Setup
  const [shareInput, setShareInput] = useState('');
  const [saving, setSaving]         = useState(false);

  // Filter
  const [catFilter, setCatFilter]     = useState('alle');
  const [selectedAKs, setSelectedAKs] = useState<Set<string>>(new Set(['Alle']));
  const [selectedDisciplines, setSelectedDisciplines] = useState<Set<string>>(new Set(['Alle']));

  // Push
  const [pushSupported, setPushSupported]   = useState(true);
  const [pushEnabled, setPushEnabled]       = useState(false);
  const [pushBusy, setPushBusy]             = useState(false);
  const [bannerDismissed, setBannerDismissed] = useState(false);

  // Gelesen-Status (lokal pro Browser)
  const [readIdsState, setReadIdsState] = useState<Set<string>>(new Set());

  const [lastChecked, setLastChecked] = useState<Date | null>(null);
  const [refreshing, setRefreshing]   = useState(false);

  const intervalRef = useRef<number | null>(null);

  useEffect(() => {
    if (!eventId) return;
    setPushSupported('serviceWorker' in navigator && 'PushManager' in window);
    load();
    intervalRef.current = window.setInterval(refreshSilently, 60_000);
    return () => { if (intervalRef.current) window.clearInterval(intervalRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId]);

  async function load() {
    if (!eventId) return;
    setLoading(true); setError('');
    try {
      const [ev, src] = await Promise.all([
        api.get<EventT>(`/api/events/${eventId}`),
        communiquesApi.get(eventId),
      ]);
      setEvent(ev);
      setSource(src);
      if (src) {
        setReadIdsState(readIds(src.id));
        checkPushSubscription();
      }
      setLastChecked(new Date());
    } catch (e: any) {
      setError(e.message ?? 'Fehler beim Laden');
    } finally {
      setLoading(false);
    }
  }

  async function refreshSilently() {
    if (!eventId) return;
    try {
      const src = await communiquesApi.get(eventId);
      setSource(src);
      setLastChecked(new Date());
    } catch { /* nächstes Intervall versucht es erneut */ }
  }

  async function handleManualRefresh() {
    if (!eventId) return;
    setRefreshing(true); setError('');
    try {
      await communiquesApi.poll(eventId);
      const src = await communiquesApi.get(eventId);
      setSource(src);
      setLastChecked(new Date());
    } catch (e: any) {
      setError(e.message ?? 'Aktualisierung fehlgeschlagen');
    } finally {
      setRefreshing(false);
    }
  }

  async function handleSetupSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!eventId || !shareInput.trim()) return;
    const token = extractShareToken(shareInput.trim());
    if (!token) { setError('Konnte keinen Share-Token aus dem Link erkennen.'); return; }
    setSaving(true); setError('');
    try {
      const src = await communiquesApi.setSource(eventId, token);
      setSource({ ...src, documents: [] });
      await handleManualRefresh();
    } catch (e: any) {
      setError(e.message ?? 'Fehler beim Speichern');
    } finally {
      setSaving(false);
    }
  }

  async function checkPushSubscription() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) { setPushSupported(false); return; }
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = await reg?.pushManager.getSubscription();
      setPushEnabled(!!sub);
    } catch { /* ignore */ }
  }

  async function enablePush() {
    if (!eventId) return;
    setPushBusy(true); setError('');
    try {
      const reg = await navigator.serviceWorker.register('/sw.js');
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        setError('Benachrichtigungen wurden nicht erlaubt.');
        setPushBusy(false);
        return;
      }
      const { key } = await communiquesApi.getVapidPublicKey();
      if (!key) {
        setError('Push ist serverseitig noch nicht konfiguriert (VAPID-Keys fehlen).');
        setPushBusy(false);
        return;
      }
      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(key) as BufferSource,
        });
      }
      await communiquesApi.subscribe(eventId, sub.toJSON() as PushSubscriptionJSON, [...selectedAKs], [...selectedDisciplines]);
      setPushEnabled(true);
      setBannerDismissed(true);
    } catch (e: any) {
      setError(e.message ?? 'Push-Aktivierung fehlgeschlagen');
    } finally {
      setPushBusy(false);
    }
  }

  async function disablePush() {
    setError('');
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = await reg?.pushManager.getSubscription();
      if (sub) {
        await communiquesApi.unsubscribe(sub.endpoint);
        await sub.unsubscribe();
      }
      setPushEnabled(false);
    } catch (e: any) {
      setError(e.message ?? 'Deaktivieren fehlgeschlagen');
    }
  }

  async function updatePushScope(nextAKs: Set<string>, nextDisciplines: Set<string>) {
    if (!eventId || !pushEnabled) return;
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = await reg?.pushManager.getSubscription();
      if (!sub) return;
      await communiquesApi.subscribe(eventId, sub.toJSON() as PushSubscriptionJSON, [...nextAKs], [...nextDisciplines]);
    } catch { /* nicht kritisch, nächste Änderung versucht es erneut */ }
  }

  function toggleAK(ak: string) {
    setSelectedAKs(prev => {
      let next: Set<string>;
      if (ak === 'Alle') {
        next = new Set(['Alle']);
      } else {
        next = new Set(prev);
        next.delete('Alle');
        if (next.has(ak)) next.delete(ak); else next.add(ak);
        if (next.size === 0) next = new Set(['Alle']);
      }
      updatePushScope(next, selectedDisciplines);
      return next;
    });
  }

  function toggleDiscipline(disc: string) {
    setSelectedDisciplines(prev => {
      let next: Set<string>;
      if (disc === 'Alle') {
        next = new Set(['Alle']);
      } else {
        next = new Set(prev);
        next.delete('Alle');
        if (next.has(disc)) next.delete(disc); else next.add(disc);
        if (next.size === 0) next = new Set(['Alle']);
      }
      updatePushScope(selectedAKs, next);
      return next;
    });
  }

  function markRead(docId: string) {
    if (!source) return;
    setReadIdsState(prev => {
      const next = new Set(prev);
      next.add(docId);
      persistReadIds(source.id, next);
      return next;
    });
  }

  function openDoc(fileName: string, docId: string) {
    markRead(docId);
    if (!source) return;
    const url = `https://share.spurtlinie.de/index.php/s/${source.shareToken}/download?path=%2F&files=${encodeURIComponent(fileName)}`;
    window.open(url, '_blank', 'noopener');
  }

  // ── Render ─────────────────────────────────────────────────────────────
  if (loading) {
    return <div className="loading"><span className="spinner" />Wird geladen…</div>;
  }

  const docs = source?.documents ?? [];
  const filtered = docs
    .filter(d => catFilter === 'alle' || d.docType === catFilter)
    .filter(d => selectedAKs.has('Alle') || d.ak === 'Alle' || selectedAKs.has(d.ak))
    .filter(d => selectedDisciplines.has('Alle') || d.discipline === 'ALLGEMEIN' || selectedDisciplines.has(d.discipline));

  const counts: Record<string, number> = {
    alle: docs.length,
    STARTLISTE: docs.filter(d => d.docType === 'STARTLISTE').length,
    ERGEBNIS: docs.filter(d => d.docType === 'ERGEBNIS').length,
    SONSTIGES: docs.filter(d => d.docType === 'SONSTIGES').length,
  };

  return (
    <div className="page container" style={{ maxWidth: 480 }}>
      <div className="breadcrumb">
        <Link to="/">Veranstaltungen</Link><span>›</span>
        <Link to={`/events/${eventId}`}>{event?.name ?? '…'}</Link><span>›</span>Kommuniqués
      </div>
      <h1 className="mb-4">Kommuniqués</h1>

      {error && <div className="alert alert-error">{error}</div>}

      {!source ? (
        <div className="card">
          <h3 style={{ marginBottom: 8 }}>Nextcloud-Link hinterlegen</h3>
          <p className="text-sm text-muted" style={{ marginTop: 0, marginBottom: 14 }}>
            Fügt den öffentlichen Share-Link ein, unter dem Startlisten und Ergebnisse
            für dieses Event veröffentlicht werden.
          </p>
          <form onSubmit={handleSetupSubmit}>
            <div className="form-group" style={{ marginBottom: 10 }}>
              <input
                className="form-input"
                type="text"
                placeholder="https://share.spurtlinie.de/index.php/s/…"
                value={shareInput}
                onChange={e => setShareInput(e.target.value)}
              />
            </div>
            <button className="btn btn-primary" type="submit" disabled={saving || !shareInput.trim()}>
              {saving ? 'Speichert…' : 'Verbinden'}
            </button>
          </form>
        </div>
      ) : (
        <>
          {/* Status-Leiste */}
          <div className="flex-between" style={{ fontSize: 12, color: 'var(--c-text-muted)', padding: '2px 2px 10px' }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--c-success)', flexShrink: 0 }} />
              {lastChecked ? `Zuletzt geprüft ${relativeTime(lastChecked.toISOString())}` : '—'}
            </span>
            <button className="btn btn-ghost btn-sm" onClick={handleManualRefresh} disabled={refreshing}>
              {refreshing ? 'Prüft…' : '↻ Aktualisieren'}
            </button>
          </div>

          {/* Push-Banner */}
          {pushSupported && !pushEnabled && !bannerDismissed && (
            <div className="alert alert-info flex-between" style={{ gap: 10 }}>
              <span>🔔 Benachrichtigungen aktivieren, um neue Dokumente sofort zu sehen.</span>
              <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                <button className="btn btn-primary btn-sm" onClick={enablePush} disabled={pushBusy}>
                  {pushBusy ? '…' : 'Aktivieren'}
                </button>
                <button className="btn btn-ghost btn-sm" onClick={() => setBannerDismissed(true)}>Später</button>
              </div>
            </div>
          )}
          {!pushSupported && (
            <div className="alert alert-info">Push wird von diesem Browser nicht unterstützt.</div>
          )}

          {/* Dokumenttyp-Filter */}
          <div className="text-xs text-muted" style={{ margin: '0 2px 6px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            Anzeigen
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 14 }}>
            {Object.entries(CAT_LABELS).map(([key, label]) => (
              <button
                key={key}
                onClick={() => setCatFilter(key)}
                style={{
                  padding: '5px 13px', borderRadius: 20, fontSize: 12.5, cursor: 'pointer',
                  border: 'none', fontWeight: 500,
                  background: catFilter === key ? '#111' : '#f3f4f6',
                  color: catFilter === key ? '#fff' : 'var(--c-text)',
                }}
              >
                {label} <span style={{ opacity: 0.6 }}>{counts[key]}</span>
              </button>
            ))}
          </div>

          {/* AK-Filter */}
          <div className="text-xs text-muted" style={{ margin: '0 2px 6px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            Altersklasse
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
            <button
              onClick={() => toggleAK('Alle')}
              style={{
                padding: '5px 12px', borderRadius: 20, fontSize: 12.5, cursor: 'pointer', fontWeight: 500,
                border: selectedAKs.has('Alle') ? '1px solid #111' : '1px solid var(--c-border)',
                background: selectedAKs.has('Alle') ? '#111' : 'var(--c-white)',
                color: selectedAKs.has('Alle') ? '#fff' : 'var(--c-text)',
              }}
            >
              Alle
            </button>
            {AK_OPTIONS.map(ak => {
              const active = !selectedAKs.has('Alle') && selectedAKs.has(ak);
              return (
                <button
                  key={ak}
                  onClick={() => toggleAK(ak)}
                  style={{
                    padding: '5px 12px', borderRadius: 20, fontSize: 12.5, cursor: 'pointer', fontWeight: 500,
                    border: active ? '1px solid var(--c-primary)' : '1px solid var(--c-border)',
                    background: active ? '#eff6ff' : 'var(--c-white)',
                    color: active ? 'var(--c-primary-hover)' : 'var(--c-text)',
                  }}
                >
                  {ak}
                </button>
              );
            })}
          </div>

          {/* Disziplin-Filter */}
          <div className="text-xs text-muted" style={{ margin: '0 2px 6px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            Disziplin
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
            {Object.entries(DISCIPLINE_LABELS).map(([key, label]) => {
              const active = key === 'Alle' ? selectedDisciplines.has('Alle') : !selectedDisciplines.has('Alle') && selectedDisciplines.has(key);
              return (
                <button
                  key={key}
                  onClick={() => toggleDiscipline(key)}
                  style={{
                    padding: '5px 12px', borderRadius: 20, fontSize: 12.5, cursor: 'pointer', fontWeight: 500,
                    border: key === 'Alle'
                      ? (active ? '1px solid #111' : '1px solid var(--c-border)')
                      : (active ? '1px solid var(--c-primary)' : '1px solid var(--c-border)'),
                    background: key === 'Alle' ? (active ? '#111' : 'var(--c-white)') : (active ? '#eff6ff' : 'var(--c-white)'),
                    color: key === 'Alle' ? (active ? '#fff' : 'var(--c-text)') : (active ? 'var(--c-primary-hover)' : 'var(--c-text)'),
                  }}
                >
                  {label}
                </button>
              );
            })}
          </div>

          {pushEnabled && (
            <div className="flex-between text-xs text-muted" style={{ padding: '6px 2px 14px' }}>
              <span>
                🔔 Benachrichtigungen für{' '}
                <strong>{selectedAKs.has('Alle') ? 'alle Klassen' : [...selectedAKs].join(', ')}</strong>
                {' · '}
                <strong>{selectedDisciplines.has('Alle') ? 'Sprint + Ausdauer' : [...selectedDisciplines].map(d => DISCIPLINE_LABELS[d]).join(', ')}</strong>
                {' '}(+ allgemeine Dokumente)
              </span>
              <button className="btn btn-ghost btn-sm" onClick={disablePush}>Deaktivieren</button>
            </div>
          )}

          {/* Dokumentenliste */}
          {filtered.length === 0 ? (
            <div className="empty">
              <p>{docs.length === 0 ? 'Noch keine Dokumente veröffentlicht.' : 'Keine Dokumente für diese Auswahl.'}</p>
            </div>
          ) : (
            <div>
              {filtered.map(d => {
                const unread = !readIdsState.has(d.id);
                return (
                  <div
                    key={d.id}
                    className="card card-link"
                    onClick={() => openDoc(d.fileName, d.id)}
                    style={{
                      display: 'flex', alignItems: 'flex-start', gap: 12, padding: '13px 14px',
                      background: unread ? '#f8fafd' : 'var(--c-white)',
                      borderColor: unread ? '#bfdbfe' : 'var(--c-border)',
                    }}
                  >
                    <div style={{
                      width: 34, height: 34, borderRadius: 8, display: 'flex',
                      alignItems: 'center', justifyContent: 'center', fontSize: 16, flexShrink: 0,
                      background: d.docType === 'STARTLISTE' ? '#dbeafe' : d.docType === 'ERGEBNIS' ? '#dcfce7' : '#f3f4f6',
                    }}>
                      {CAT_ICON[d.docType]}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 2 }}>
                        <span style={{
                          fontSize: 13.5, fontWeight: 600, overflow: 'hidden',
                          textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        }}>
                          {d.fileName}
                        </span>
                        {unread && <span className="badge badge-blue">NEU</span>}
                      </div>
                      <div className="text-xs text-muted">
                        {relativeTime(d.remoteModifiedAt)} · {d.ak}{d.discipline !== 'ALLGEMEIN' ? ` · ${DISCIPLINE_LABELS[d.discipline]}` : ''}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}
