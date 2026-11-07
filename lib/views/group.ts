/**
 * How the to-do navigation orders its groups.
 *
 * Kept out of the component so the ordering rules can be asserted directly:
 * declared groups first in their declared order, then any group a view named
 * without declaring, then the ungrouped views. A view belongs to exactly one
 * group, and its index in the flat list never changes (SSR-000087 ③⑥).
 */

export interface ViewGroupDecl {
  title: string;
  collapsed: boolean;
}

export interface GroupedViews {
  /** Group titles in draw order; does not include the ungrouped tail. */
  ordered: string[];
  /** Title → indices into the flat view list, in configuration order. */
  members: Map<string, number[]>;
  /** Indices of the views that named no group. */
  ungrouped: number[];
  /** Declarations by title, for labels and default folding. */
  declared: Map<string, ViewGroupDecl>;
}

export function groupViews(
  views: Array<{ group: string | null }>,
  groups: ViewGroupDecl[] = [],
): GroupedViews {
  const declared = new Map<string, ViewGroupDecl>();
  for (const group of groups) declared.set(group.title, group);

  const members = new Map<string, number[]>();
  const firstSeen: string[] = [];
  const ungrouped: number[] = [];

  views.forEach((view, index) => {
    const title = view.group;
    if (!title) {
      ungrouped.push(index);
      return;
    }
    let list = members.get(title);
    if (!list) {
      list = [];
      members.set(title, list);
      firstSeen.push(title);
    }
    list.push(index);
  });

  const ordered = [
    // A declaration with no views is not drawn: an empty header reads as a bug.
    ...[...declared.keys()].filter((title) => members.has(title)),
    ...firstSeen.filter((title) => !declared.has(title)),
  ];

  return { ordered, members, ungrouped, declared };
}
