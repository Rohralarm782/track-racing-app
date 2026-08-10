import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Build-Zeitpunkt fest ins Bundle backen. Wird unten in der App als
  // "Stand …" angezeigt und dient dazu, auf einem fremden Gerät zu erkennen,
  // ob dort noch eine alte, gecachte Fassung läuft.
  define: {
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  server: {
    proxy: {
      '/api': 'http://localhost:3001',
    },
  },
});
