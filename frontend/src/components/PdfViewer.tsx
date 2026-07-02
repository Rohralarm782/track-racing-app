import { useEffect, useRef, useState } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
// Vite-Pattern: liefert die URL zur Worker-Datei, die Vite als Asset bündelt.
import pdfjsWorkerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorkerUrl;

interface PdfViewerProps {
  url: string;
}

/**
 * Rendert eine PDF-Datei Seite für Seite auf <canvas>-Elemente, statt sie dem
 * Browser per <iframe>/<embed> zu überlassen. Grund: mobile Browser (v.a.
 * Samsung Internet) handhaben eingebettete PDFs inkonsistent und zeigen teils
 * einen Download-Screen statt die Datei anzuzeigen, egal welche HTTP-Header
 * gesetzt sind. Mit pdf.js (derselben Bibliothek, die auch Firefox intern
 * nutzt) rendern wir die Seiten selbst — das Ergebnis sieht auf jedem Gerät
 * gleich aus.
 */
export default function PdfViewer({ url }: PdfViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [errorMsg, setErrorMsg] = useState('');

  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    setErrorMsg('');

    async function render() {
      try {
        const loadingTask = pdfjsLib.getDocument({ url });
        const pdf = await loadingTask.promise;
        if (cancelled || !containerRef.current) return;

        containerRef.current.innerHTML = '';
        const containerWidth = containerRef.current.clientWidth || 800;

        for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
          if (cancelled) return;
          const page = await pdf.getPage(pageNum);
          const baseViewport = page.getViewport({ scale: 1 });
          // Auf Container-Breite skalieren (mit Cap, damit es auf Desktop nicht riesig wird)
          const scale = Math.min(containerWidth / baseViewport.width, 2.5);
          const viewport = page.getViewport({ scale });

          const canvas = document.createElement('canvas');
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          canvas.style.width = '100%';
          canvas.style.height = 'auto';
          canvas.style.display = 'block';
          canvas.style.marginBottom = '8px';
          canvas.style.boxShadow = '0 1px 4px rgba(0,0,0,0.15)';

          const context = canvas.getContext('2d');
          if (!context) continue;

          if (!cancelled && containerRef.current) {
            containerRef.current.appendChild(canvas);
          }

          await page.render({ canvasContext: context, viewport }).promise;
        }

        if (!cancelled) setStatus('ready');
      } catch (err: any) {
        if (!cancelled) {
          setStatus('error');
          setErrorMsg(err?.message ?? 'PDF konnte nicht geladen werden');
        }
      }
    }

    render();
    return () => { cancelled = true; };
  }, [url]);

  return (
    <div style={{ height: '100%', overflow: 'auto', background: '#525659', padding: '10px' }}>
      {status === 'loading' && (
        <div className="loading" style={{ color: 'white' }}>
          <span className="spinner" />Wird geladen…
        </div>
      )}
      {status === 'error' && (
        <div className="alert alert-error" style={{ margin: '20px' }}>
          Fehler beim Laden: {errorMsg}
        </div>
      )}
      <div ref={containerRef} style={{ maxWidth: 900, margin: '0 auto' }} />
    </div>
  );
}
