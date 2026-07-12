import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles/globals.css';

// Service Worker früh und zentral registrieren – nicht erst beim Aktivieren von
// Push (das passiert weiterhin zusätzlich in CommuniquesPage; register() ist
// idempotent, gleiche URL/Scope ⇒ gleiche Registrierung). Nötig, damit der
// Offline-PDF-Cache (siehe public/sw.js) auf allen Geräten läuft, nicht nur auf
// solchen mit aktivierten Benachrichtigungen. Fehler bleiben ohne Folgen:
// scheitert die Registrierung, verhält sich die App wie zuvor (nur online).
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => { /* SW optional */ });
  });
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
