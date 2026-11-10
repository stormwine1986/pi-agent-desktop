"use client";

import { staleDependencyLine, type StaleDependency } from "@/lib/entity-dependencies";

/**
 * 「依赖已失效」— one line per broken dependency, computed at read time.
 *
 * A notice, not a lock: editing and transitions stay available, because the
 * base is the one that refuses a transition whose guard does not hold
 * (`SSR-000094` AC-11). Rendering this changes nothing — no `suspect` write, no
 * entity write, no request.
 *
 * Nothing is rendered when every dependency is acceptable: a permanent "无问题"
 * row would be noise, and would also make "checked and fine" look the same as
 * "not checked".
 */
export function StaleDependencyNotice({ items }: { items: readonly StaleDependency[] }) {
  if (items.length === 0) return null;
  return (
    <div
      role="status"
      style={{
        margin: "8px 10px 0",
        padding: "6px 8px",
        border: "1px solid color-mix(in srgb, var(--warning) 45%, transparent)",
        borderRadius: 6,
        background: "color-mix(in srgb, var(--warning) 10%, transparent)",
        color: "var(--warning)",
        fontSize: "var(--fs-caption)",
        lineHeight: 1.5,
        whiteSpace: "pre-wrap",
        overflowWrap: "anywhere",
      }}
    >
      {items.map((item) => (
        <div key={`${item.relation}:${item.key}`} title={[item.type, item.name].filter(Boolean).join(" · ")}>
          {staleDependencyLine(item)}
        </div>
      ))}
    </div>
  );
}
