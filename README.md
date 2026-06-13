# Bahnrad-Tracker

Echtzeit-Ergebnistool für Bahnradsport-Veranstaltungen.  
Unterstützt Punktefahren/Madison, Temporunden und Verfolgungsrennen.

---

## Lokale Entwicklung

### Voraussetzungen
- Node.js 20+
- PostgreSQL (lokal oder z.B. via Docker)

### 1. Backend

```bash
cd backend
npm install
cp .env.example .env        # Werte anpassen
npx prisma db push          # Datenbank-Schema anlegen
npm run dev                 # Startet auf Port 3001
```

**`.env` anpassen:**
```
DATABASE_URL="postgresql://postgres:password@localhost:5432/bahnrad"
ADMIN_PASSWORD="dein-passwort"
CORS_ORIGIN="http://localhost:5173"
```

### 2. Frontend

```bash
cd frontend
npm install
npm run dev                 # Startet auf Port 5173
```

Vite proxied `/api/*` automatisch zum Backend auf Port 3001.

---

## Deployment auf Railway

### Einmalige Einrichtung

1. Repo auf GitHub pushen
2. Auf [railway.app](https://railway.app) einloggen
3. **New Project → Deploy from GitHub repo**

### Backend-Service

- **Root Directory:** `backend`
- **Build Command:** `npm install && npx prisma generate && npm run build`
- **Start Command:** `node dist/index.js`
- **Add-on:** PostgreSQL hinzufügen (Railway setzt `DATABASE_URL` automatisch)

Umgebungsvariablen setzen:
```
ADMIN_PASSWORD=dein-sicheres-passwort
CORS_ORIGIN=https://DEINE-FRONTEND-URL.railway.app
```

### Frontend-Service

- **Root Directory:** `frontend`
- **Build Command:** `npm install && npm run build`
- **Start Command:** `npx serve dist -l $PORT`

Umgebungsvariable setzen:
```
VITE_API_URL=https://DEINE-BACKEND-URL.railway.app
```

> **Wichtig:** Die `VITE_API_URL` muss beim *Build* gesetzt sein (nicht nur zur Laufzeit),
> da Vite sie beim Kompilieren einbettet. In Railway unter Service → Variables → "Add Variable"
> vor dem ersten Deployment eintragen.

---

## Projektstruktur

```
/
├── backend/
│   ├── prisma/schema.prisma   # Datenbankmodell
│   ├── src/
│   │   ├── index.ts           # Express-Server
│   │   ├── middleware/auth.ts # Admin-Passwort-Check
│   │   └── routes/            # events, categories, teams
│   └── package.json
│
├── frontend/
│   ├── src/
│   │   ├── api/client.ts      # Fetch-Wrapper + Typen
│   │   ├── components/
│   │   │   ├── Layout.tsx     # Header + Admin-Context
│   │   │   └── TeamBulkEntry.tsx # Startlisten-Eingabe
│   │   └── pages/
│   │       ├── EventList.tsx
│   │       ├── CreateEvent.tsx
│   │       ├── EventDetail.tsx
│   │       └── CategoryDetail.tsx
│   └── package.json
│
└── README.md
```

---

## Startlisten-Format

**Einzelrennen (Punktefahren):**
```
1 Max Müller
2 Anna Schmidt
3 Peter Weber
```

**Madison / Mannschaft:**
```
1 MEV, Max Müller / Lisa Schmidt
2 RSV Frankfurt, Peter Koch / Jana Klein
3 BSG Köln, Tom Bauer / Maria Sauer
```

Format: `Startnummer Teamname, Fahrer 1 / Fahrer 2`

---

## Entwicklungsphasen

- [x] **Phase 1** — Grundgerüst: Events, Kategorien, Startliste
- [ ] **Phase 2** — Punktefahren: Sprint-Eingabe, Rundenerfassung, Live-Scoreboard
- [ ] **Phase 3** — Temporunden + Verfolgungsrennen
- [ ] **Phase 4** — QR-Code, CSV-Export, Mobile-Optimierung
