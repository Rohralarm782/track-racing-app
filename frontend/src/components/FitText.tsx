import { useLayoutEffect, useRef, useState } from 'react';

// Skaliert einen kurzen Text (die große Zeit der Vollbild-Athletenanzeige) so,
// dass er die Breite seines Containers ausfüllt — nur über font-size, ohne
// Verzerrung der Glyphen. Reagiert auf Fenstergröße und Textwechsel. Die
// Höhe wird auf maxVh der Viewporthöhe begrenzt, damit die Zahl auf breiten,
// niedrigen Bildschirmen nicht zu hoch wird.
export default function FitText({ text, color, maxVh = 46, weight = 600 }: {
  text: string; color: string; maxVh?: number; weight?: number;
}) {
  const boxRef  = useRef<HTMLDivElement>(null);
  const spanRef = useRef<HTMLSpanElement>(null);
  const [size, setSize] = useState(120);

  useLayoutEffect(() => {
    const fit = () => {
      const box = boxRef.current, span = spanRef.current;
      if (!box || !span) return;
      const avail = box.clientWidth;
      if (avail <= 0) return;
      const curSize  = parseFloat(getComputedStyle(span).fontSize) || 1;
      const curWidth = span.scrollWidth || 1;
      let next = curSize * (avail / curWidth);
      const maxPx = (maxVh / 100) * window.innerHeight;
      next = Math.min(next, maxPx);
      if (Math.abs(next - curSize) > 0.5) setSize(next); // Guard gegen Mini-Loops
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [text, maxVh]);

  return (
    <div ref={boxRef} style={{ width: '100%', display: 'flex', justifyContent: 'center' }}>
      <span ref={spanRef} style={{
        fontSize: size, fontWeight: weight, lineHeight: 1,
        fontVariantNumeric: 'tabular-nums', letterSpacing: '-0.02em',
        color, whiteSpace: 'nowrap',
      }}>
        {text}
      </span>
    </div>
  );
}
