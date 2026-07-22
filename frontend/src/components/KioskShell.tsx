// Kiosk-Rahmen (Fahrerlager-Anzeige).
//
// Ersetzt im Kiosk-Modus den normalen App-Header durch eine schlanke, gesperrte
// Kopfleiste. Der eigentliche Seiteninhalt (Zeitplan bzw. Kommuniqués mit ALLEN
// Funktionen — Suche, Sortierung, „Aktueller Stand" aktualisieren) wird
// unverändert vom Layout darunter gerendert. So muss der Coach den Kiosk nicht
// verlassen, um etwas zu suchen oder zu aktualisieren.
//
// Zweck der Sperre: Der App-Header (Abmelden, andere Bereiche) ist ausgeblendet,
// verlassen geht nur über 🔒 + PIN (bzw. Admin-Passwort, falls PIN vergessen).
//
// Admin-Aktionen (Anheften, Ausblenden, Zuordnen, Import, Aktueller Stand …)
// sind im Kiosk zusätzlich gesperrt, bis über „🔓 Bearbeiten“ + PIN entsperrt
// wurde (editing). So kann die Anzeige unbeaufsichtigt im Fahrerlager stehen,
// ohne dass jemand versehentlich (oder absichtlich) etwas verändert. Die
// Entsperrung gilt nur für diese Sitzung, wird nie gespeichert (ein Reload
// startet also immer gesperrt) und fällt nach AUTO_RELOCK_MS automatisch zurück.
//
// Bewusste Grenze: Echtes Browser-Vollbild (Esc/F11) lässt sich technisch nicht
// erzwingen. Verlässt jemand das Vollbild, bleibt die Anzeige gesperrt; ein
// Banner bietet „Wieder Vollbild". Für einen unentkommbaren Kiosk zusätzlich den
// Browser im OS-Kiosk-Modus starten (Chrome/Edge --kiosk).
import { useEffect, useState } from 'react';
import { api } from '../api/client';
import PinPad, { getStoredPin, setStoredPin, clearStoredPin } from './PinPad';

// Bearbeitung fällt nach dieser Zeit ohne Zutun automatisch wieder in den
// gesperrten Zustand zurück — falls der Coach das Sperren vergisst.
const AUTO_RELOCK_MS = 5 * 60 * 1000;

// ── KioskShell ──────────────────────────────────────────────────────────────
export default function KioskShell({ editing, setEditing, onExit }: {
  eventId: string;
  editing: boolean;
  setEditing: (v: boolean) => void;
  onExit: () => void;
}) {
  const [now, setNow]       = useState(new Date());
  const [fsExited, setFsExited] = useState(!document.fullscreenElement);
  const [needsSetup, setNeedsSetup] = useState(!getStoredPin());
  const [exitAsk, setExitAsk]   = useState(false);
  const [editAsk, setEditAsk]   = useState(false);
  const [pinErr, setPinErr]     = useState<string>();

  // Uhr
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  // Vollbild-Status überwachen (Banner bei Verlassen)
  useEffect(() => {
    const onFs = () => setFsExited(!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);

  // Auto-Sperre: sobald entsperrt, nach AUTO_RELOCK_MS wieder sperren.
  useEffect(() => {
    if (!editing) return;
    const t = setTimeout(() => setEditing(false), AUTO_RELOCK_MS);
    return () => clearTimeout(t);
  }, [editing, setEditing]);

  const goFullscreen = () => { document.documentElement.requestFullscreen?.().catch(() => {}); };

  const submitSetup = (code: string) => { setStoredPin(code); setNeedsSetup(false); };

  const submitExit = (code: string) => {
    if (code === getStoredPin()) { setExitAsk(false); setPinErr(undefined); onExit(); }
    else setPinErr('Falscher PIN');
  };
  const adminExitReset = async () => {
    const pw = window.prompt('Admin-Passwort eingeben, um zu entsperren:');
    if (pw == null) return;
    if (await api.verifyAdmin(pw)) { clearStoredPin(); setExitAsk(false); setPinErr(undefined); onExit(); }
    else setPinErr('Admin-Passwort falsch');
  };

  const submitEdit = (code: string) => {
    if (code === getStoredPin()) { setEditAsk(false); setPinErr(undefined); setEditing(true); }
    else setPinErr('Falscher PIN');
  };
  const adminEditUnlock = async () => {
    const pw = window.prompt('Admin-Passwort eingeben, um die Bearbeitung freizugeben:');
    if (pw == null) return;
    if (await api.verifyAdmin(pw)) { setEditAsk(false); setPinErr(undefined); setEditing(true); }
    else setPinErr('Admin-Passwort falsch');
  };

  const clock = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

  return (
    <>
      {/* Kopfleiste — klebt oben wie der normale Header (Höhe 54, damit die
          sticky EventTabBar mit top:54 direkt darunter sitzt). */}
      <div style={{ position: 'sticky', top: 0, zIndex: 10 }}>
        {fsExited && (
          <div style={{ background: 'var(--c-warning)', color: '#fff', padding: '8px 16px',
            display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
            fontSize: 13.5, fontWeight: 500 }}>
            <span>⚠️ Vollbild wurde verlassen – die Anzeige bleibt gesperrt.</span>
            <button onClick={goFullscreen} style={{ background: '#fff', color: 'var(--c-warning)',
              border: 'none', padding: '5px 11px', borderRadius: 6, fontWeight: 700, fontSize: 12.5, cursor: 'pointer' }}>
              Wieder Vollbild
            </button>
          </div>
        )}
        {editing && (
          <div style={{ background: 'var(--c-primary)', color: '#fff', padding: '7px 16px',
            display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
            fontSize: 13, fontWeight: 500 }}>
            <span>🔓 Bearbeitung entsperrt – Admin-Aktionen sind sichtbar. Sperrt nach 5 Min automatisch.</span>
            <button onClick={() => setEditing(false)} style={{ background: '#fff', color: 'var(--c-primary)',
              border: 'none', padding: '5px 11px', borderRadius: 6, fontWeight: 700, fontSize: 12.5, cursor: 'pointer' }}>
              Jetzt sperren
            </button>
          </div>
        )}
        <div style={{ background: 'var(--c-white)', borderBottom: '1px solid var(--c-border)',
          height: 54, padding: '0 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontWeight: 700, fontSize: 15, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span>🖥️</span><span>Fahrerlager-Anzeige</span>
          </span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <span style={{ fontSize: 20, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{clock}</span>
            {editing ? (
              <button onClick={() => setEditing(false)}
                className="btn btn-secondary btn-sm" title="Bearbeitung sperren">
                <span>🔒</span><span className="nav-text">Sperren</span>
              </button>
            ) : (
              <button onClick={() => { setPinErr(undefined); setEditAsk(true); }}
                className="btn btn-ghost btn-sm" title="Bearbeitung entsperren">
                <span>🔓</span><span className="nav-text">Bearbeiten</span>
              </button>
            )}
            <button onClick={() => { setPinErr(undefined); setExitAsk(true); }}
              className="btn btn-secondary btn-sm" title="Kiosk-Modus beenden">
              <span>🚪</span><span className="nav-text">Beenden</span>
            </button>
          </div>
        </div>
      </div>

      {needsSetup && (
        <PinPad
          title="Kiosk-PIN festlegen"
          subtitle="Zum Beenden des Kiosk-Modus nötig. Nur auf diesem Laptop gespeichert."
          onSubmit={submitSetup}
          onCancel={onExit}
        />
      )}
      {editAsk && (
        <PinPad
          title="PIN eingeben"
          subtitle="Zum Freigeben der Bearbeitung im Kiosk-Modus."
          error={pinErr}
          onSubmit={submitEdit}
          onCancel={() => { setEditAsk(false); setPinErr(undefined); }}
          forgot={adminEditUnlock}
        />
      )}
      {exitAsk && (
        <PinPad
          title="PIN eingeben"
          subtitle="Zum Beenden des Kiosk-Modus."
          error={pinErr}
          onSubmit={submitExit}
          onCancel={() => { setExitAsk(false); setPinErr(undefined); }}
          forgot={adminExitReset}
        />
      )}
    </>
  );
}
