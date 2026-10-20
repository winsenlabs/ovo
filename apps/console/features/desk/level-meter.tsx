'use client';
import { useEffect, useRef } from 'react';

/**
 * A level bar driven by an animation frame reading `level()` (0 to 1): no React state per frame.
 * It is decoration for sighted operators, so assistive tech gets only the label.
 */
export function LevelMeter({
  label,
  level,
  active,
}: {
  label: string;
  level: () => number;
  active: boolean;
}) {
  const bar = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!active) {
      if (bar.current) bar.current.style.transform = 'scaleX(0)';
      return;
    }
    let frame = 0;
    const tick = () => {
      if (bar.current) bar.current.style.transform = `scaleX(${Math.min(1, level())})`;
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [active, level]);
  return (
    <div className="desk-meter" role="img" aria-label={label}>
      <span ref={bar} className="desk-meter-bar" />
    </div>
  );
}
