'use client';
// The Configure tab's sticky in-page jump nav, split out of `studio.tsx` to stay under the
// module-size gate. Highlights whichever group's section is currently nearest the top of the
// viewport (verifier: "the section nav has no active state"), tracked with one
// `IntersectionObserver` rather than a scroll listener.
import { useEffect } from 'react';

export type NavGroup = { id: string; label: string };

export function StudioNav({
  groups,
  active,
  onActivate,
}: {
  groups: readonly NavGroup[];
  active: string;
  onActivate: (id: string) => void;
}) {
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const sections = groups
      .map((group) => document.getElementById(`group-${group.id}`))
      .filter((element): element is HTMLElement => element != null);
    if (!sections.length) return;
    const visible = new Map<string, number>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          visible.set(entry.target.id, entry.intersectionRatio);
        }
        const topMost = [...visible.entries()]
          .filter(([, ratio]) => ratio > 0)
          .sort((a, b) => b[1] - a[1])[0];
        if (topMost) onActivate(topMost[0].replace(/^group-/, ''));
      },
      { rootMargin: '-96px 0px -70% 0px', threshold: [0, 0.25, 0.5, 1] },
    );
    for (const section of sections) observer.observe(section);
    return () => observer.disconnect();
  }, [groups, onActivate]);
  return (
    <nav className="ds-studio-nav" aria-label="Jump to section">
      {groups.map((group) => (
        <a
          key={group.id}
          href={`#group-${group.id}`}
          className={group.id === active ? 'active' : undefined}
          aria-current={group.id === active ? 'true' : undefined}
        >
          {group.label}
        </a>
      ))}
    </nav>
  );
}
