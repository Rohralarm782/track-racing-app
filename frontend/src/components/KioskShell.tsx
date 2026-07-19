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
// Bewusste Grenze: Echtes Browser-Vollbild (Esc/F11) lässt sich technisch nicht
// erzwingen. Verlässt jemand das Vollbild, bleibt die Anzeige gesperrt; ein
// Banner bietet „Wieder Vollbild". Für einen unentkommbaren Kiosk zusätzlich den
// Browser im OS-Kiosk-Modus starten (Chrome/Edge --kiosk).
import { useEffect, useState } from 'react';
import { api } from '../api/client';

// ── PIN-Speicher (nur auf diesem Gerät) ─────────────────────────────────────
const PIN_KEY = 'kiosk_exit_pin';
const PIN_LEN = 4;
const getStoredPin = () => localStorage.getItem(PIN_KEY);
const setStoredPin = (pin: string) => localStorage.setItem(PIN_KEY, pin);
const clearStoredPin = () => localStorage.removeItem(PIN_KEY);

// ── PIN-Pad ─────────────────────────────────────────────────────────────────
function PinPad({ title, subtitle, error, onSubmit, onCancel, forgot }: {
  title: string; subtitle: string; error?: string;
  onSubmit: (code: string) => void; onCancel: () => void; forgot?: () => void;
}) {
  const [buf, setBuf] = useState('');
  useEffect(() => { if (error) setBuf(''); }, [error]);
  const press = (d: string) => {
    if (buf.length >= PIN_LEN) return;
    const next = buf + d;
    setBuf(next);
    if (next.length === PIN_LEN) setTimeout(() => onSubmit(next), 120);
  };
  const keyStyle: React.CSSProperties = {
    padding: '18px 0', fontSize: 24, fontWeight: 600, borderRadius: 12,
    border: '1px solid var(--c-border)', background: 'var(--c-white)', cursor: 'pointer', fontFamily: 'inherit',
  };
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(17,24,39,.6)', zIndex: 100,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div style={{ background: 'var(--c-white)', borderRadius: 16, padding: 28, width: 340, textAlign: 'center',
        boxShadow: '0 20px 50px rgba(0,0,0,.35)' }}>
        <h3 style={{ margin: '0 0 4px', fontSize: 19 }}>{title}</h3>
        <p style={{ margin: '0 0 16px', fontSize: 13.5, color: 'var(--c-text-muted)' }}>{subtitle}</p>
        <div style={{ color: 'var(--c-danger)', fontSize: 13, fontWeight: 600, height: 18, marginBottom: 6 }}>
          {error ?? ''}
        </div>
        <div style={{ display: 'flex', gap: 12, justifyContent: 'center', marginBottom: 20, height: 16 }}>
          {Array.from({ length: PIN_LEN }).map((_, i) => (
            <div key={i} style={{ width: 15, height: 15, borderRadius: '50%',
              border: '2px solid ' + (i < buf.length ? 'var(--c-primary)' : 'var(--c-border)'),
              background: i < buf.length ? 'var(--c-primary)' : 'transparent' }} />
          ))}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 10 }}>
          {['1','2','3','4','5','6','7','8','9'].map(d => (
            <button key={d} style={keyStyle} onClick={() => press(d)}>{d}</button>
          ))}
          <button style={{ ...keyStyle, fontSize: 16 }} onClick={onCancel}>✕</button>
          <button style={keyStyle} onClick={() => press('0')}>0</button>
          <button style={{ ...keyStyle, fontSize: 18 }} onClick={() => setBuf(buf.slice(0, -1))}>⌫</button>
        </div>
        {forgot && (
          <button onClick={forgot} style={{ marginTop: 14, fontSize: 13, color: 'var(--c-primary)',
            background: 'none', border: 'none', textDecoration: 'underline', cursor: 'pointer' }}>
            PIN vergessen? Mit Admin-Passwort entsperren
          </button>
        )}
      </div>
    </div>
  );
}

// ── KioskShell ──────────────────────────────────────────────────────────────
export default function KioskShell({ onExit }: { eventId: string; onExit: () => void }) {
  const [now, setNow]       = useState(new Date());
  const [fsExited, setFsExited] = useState(!document.fullscreenElement);
  const [needsSetup, setNeedsSetup] = useState(!getStoredPin());
  const [exitAsk, setExitAsk]   = useState(false);
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

  const goFullscreen = () => { document.documentElement.requestFullscreen?.().catch(() => {}); };

  const submitSetup = (code: string) => { setStoredPin(code); setNeedsSetup(false); };
  const submitExit = (code: string) => {
    if (code === getStoredPin()) { setExitAsk(false); setPinErr(undefined); onExit(); }
    else setPinErr('Falscher PIN');
  };
  const adminReset = async () => {
    const pw = window.prompt('Admin-Passwort eingeben, um zu entsperren:');
    if (pw == null) return;
    if (await api.verifyAdmin(pw)) { clearStoredPin(); setExitAsk(false); setPinErr(undefined); onExit(); }
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
        <div style={{ background: 'var(--c-white)', borderBottom: '1px solid var(--c-border)',
          height: 54, padding: '0 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontWeight: 700, fontSize: 15, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span>🖥️</span><span>Fahrerlager-Anzeige</span>
          </span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <span style={{ fontSize: 20, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{clock}</span>
            <button onClick={() => { setPinErr(undefined); setExitAsk(true); }}
              className="btn btn-secondary btn-sm" title="Kiosk-Modus beenden">
              <span>🔒</span><span className="nav-text">Beenden</span>
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
      {exitAsk && (
        <PinPad
          title="PIN eingeben"
          subtitle="Zum Beenden des Kiosk-Modus."
          error={pinErr}
          onSubmit={submitExit}
          onCancel={() => { setExitAsk(false); setPinErr(undefined); }}
          forgot={adminReset}
        />
      )}
    </>
  );
}
