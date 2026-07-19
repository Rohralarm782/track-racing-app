import { useKiosk } from './Layout';

/**
 * Kompakter Monitor-Button neben dem Zahnrad (Zeitplan-/Kommuniqués-Seite).
 * Startet die Fahrerlager-Anzeige (Vollbild-Kiosk) für die aktuelle
 * Veranstaltung — bewusst KEIN Tab in der EventTabBar, damit die drei
 * gleichrangigen Inhalts-Tabs unberührt bleiben.
 */
export default function KioskButton({ eventId }: { eventId: string }) {
  const { startKiosk } = useKiosk();
  return (
    <button
      onClick={() => startKiosk(eventId)}
      title="Fahrerlager-Anzeige im Vollbild starten"
      aria-label="Kiosk-Modus starten"
      style={{
        width: 32, height: 32, flexShrink: 0, border: 'none', borderRadius: 8,
        background: 'transparent', color: 'var(--c-text-muted)',
        fontSize: 16, cursor: 'pointer', display: 'flex',
        alignItems: 'center', justifyContent: 'center',
      }}
    >
      🖥️
    </button>
  );
}
