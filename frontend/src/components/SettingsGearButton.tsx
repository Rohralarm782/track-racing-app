import { useNavigate } from 'react-router-dom';

interface Props {
  eventId: string;
  active?: boolean;
  // Wenn gesetzt (nur auf EventDetail selbst), wechselt der Klick lokal den
  // Tab ohne Routenwechsel. Auf Kommuniqués/Zeitplan-Seiten gibt es diesen
  // Handler nicht — dort wird zu EventDetail mit ?tab=einstellungen navigiert.
  onLocalClick?: () => void;
}

/**
 * Kompaktes Zahnrad-Icon neben dem Veranstaltungstitel. Ersetzt den früheren
 * "⚙️ Einstellungen"-Tab in der EventTabBar, damit dort mehr Platz für
 * gleichrangige Inhalts-Tabs (Übersicht/Kommuniqués/Zeitplan) bleibt.
 */
export default function SettingsGearButton({ eventId, active, onLocalClick }: Props) {
  const navigate = useNavigate();

  function handleClick() {
    if (onLocalClick) {
      onLocalClick();
    } else {
      navigate(`/events/${eventId}?tab=einstellungen`);
    }
  }

  return (
    <button
      onClick={handleClick}
      title="Einstellungen"
      aria-label="Einstellungen"
      style={{
        width: 32, height: 32, flexShrink: 0, border: 'none', borderRadius: 8,
        background: active ? '#f3f4f6' : 'transparent',
        color: 'var(--c-text-muted)',
        fontSize: 16, cursor: 'pointer', display: 'flex',
        alignItems: 'center', justifyContent: 'center',
      }}
    >
      ⚙️
    </button>
  );
}
