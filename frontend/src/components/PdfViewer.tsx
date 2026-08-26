import { useEffect, useRef, useState } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
// Vite-Pattern: liefert die URL zur Worker-Datei, die Vite als Asset bündelt.
import pdfjsWorkerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorkerUrl;

interface PdfViewerProps {
  url: string;
  /**
   * Dateiname des Dokuments. Nur nötig, um Bilder von PDFs zu unterscheiden —
   * fehlt er, wird wie bisher ein PDF angenommen. Bilder kommen vor, seit
   * Kommuniqués auch aus einem eigenen Drive-Ordner stammen können: aus einer
   * WhatsApp-Gruppe kommt der Aushang oft abfotografiert.
   */
  fileName?: string;
}

/** True, wenn der Dateiname auf ein Bildformat hindeutet. */
function isImageFileName(name: string | undefined): boolean {
  return !!name && /\.(jpe?g|png|webp|hei[cf]|gif)$/i.test(name);
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
export default function PdfViewer({ url, fileName }: PdfViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [errorMsg, setErrorMsg] = useState('');
  // Bilder: eingepasst (Vorgabe) oder in voller Größe. Ein abfotografierter
  // Aushang ist eingepasst oft nicht lesbar — Antippen vergrößert, der
  // umgebende Container scrollt dann in beide Richtungen.
  const [imageZoomed, setImageZoomed] = useState(false);
  const isImage = isImageFileName(fileName);

  useEffect(() => { setImageZoomed(false); }, [url]);

  useEffect(() => {
    // pdf.js würde ein PNG nicht laden können; Bilder rendert der Browser selbst.
    if (isImage) return;
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
        // Pixeldichte des Geräts berücksichtigen (Handys haben oft 2-3x),
        // sonst wird das Canvas niedrig aufgelöst gerendert und dann vom
        // Browser hochskaliert -> unscharf. Cap bei 3, damit sehr hochauflösende
        // Geräte nicht unnötig riesige Canvases erzeugen.
        const outputScale = Math.min(window.devicePixelRatio || 1, 3);

        for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
          if (cancelled) return;
          const page = await pdf.getPage(pageNum);
          const baseViewport = page.getViewport({ scale: 1 });
          // Auf Container-Breite skalieren (mit Cap, damit es auf Desktop nicht riesig wird)
          const scale = Math.min(containerWidth / baseViewport.width, 2.5);
          const viewport = page.getViewport({ scale });

          const canvas = document.createElement('canvas');
          // Canvas-Auflösung (Backing Store) = CSS-Größe * Pixeldichte
          canvas.width = Math.floor(viewport.width * outputScale);
          canvas.height = Math.floor(viewport.height * outputScale);
          // Angezeigte Größe bleibt unverändert (nur die Auflösung steigt)
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

          const transform = outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : undefined;
          await page.render({ canvasContext: context, viewport, transform }).promise;
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
  }, [url, isImage]);

  if (isImage) {
    return (
      <div style={{ height: '100%', overflow: 'auto', background: '#525659', padding: '10px' }}>
        <div style={{ maxWidth: imageZoomed ? 'none' : 900, margin: '0 auto' }}>
          <img
            src={url}
            alt={fileName ?? 'Kommuniqué'}
            onClick={() => setImageZoomed(z => !z)}
            style={{
              display: 'block',
              width: imageZoomed ? 'auto' : '100%',
              maxWidth: imageZoomed ? 'none' : '100%',
              height: 'auto',
              cursor: imageZoomed ? 'zoom-out' : 'zoom-in',
              boxShadow: '0 1px 4px rgba(0,0,0,0.15)',
              background: 'white',
            }}
          />
        </div>
        <p style={{ color: 'rgba(255,255,255,0.7)', fontSize: 12, textAlign: 'center', marginTop: 8 }}>
          {imageZoomed ? 'Zum Verkleinern antippen' : 'Zum Vergrößern antippen'}
        </p>
      </div>
    );
  }

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
