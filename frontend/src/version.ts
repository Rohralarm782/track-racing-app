// Zielpfad im Repo: frontend/src/version.ts  (NEUE Datei)
//
// Die Versionsnummer der App. Schema: GROSS.KLEIN.PATCH
//   GROSS  — größere Strukturänderungen (Datenmodell, Navigation, Umbauten,
//            die man beim Benutzen merkt)
//   KLEIN  — neue Funktionen ohne Umbau
//   PATCH  — Fehlerbehebungen
//
// Beim Ändern IMMER auch ein Änderungsprotokoll unter CHANGELOG/<version>.md
// anlegen. Die Nummer wird unten in der App neben dem Build-Zeitstempel
// angezeigt: der Zeitstempel sagt, WANN dieses Gerät zuletzt geladen hat, die
// Versionsnummer sagt, WAS drin ist. Trackside sind beide Angaben nötig, um zu
// klären, ob ein fremdes Handy auf einem alten Stand hängt.
export const APP_VERSION = '1.1.0';
