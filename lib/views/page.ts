/**
 * Where a page sits inside a view's result set (SSR-000067 ③).
 *
 * Kept apart from the route and the panel because this is the part that can be
 * wrong without anyone noticing: an offset past the end looks exactly like "no
 * rows", and an offset that never moves looks like "this view has one page".
 */

export interface PageWindow {
  /** Where this page starts, clamped into range. */
  offset: number;
  /** Rows on this page. */
  count: number;
  /** Matching rows in total, or null when the base did not say. */
  total: number | null;
  hasPrev: boolean;
  hasNext: boolean;
}

/**
 * Pulls an offset back into range.
 *
 * Rows disappear between refreshes — a state change takes an entity out of the
 * view — so the page the user sits on can stop existing. Answering that with an
 * empty page reads as "this view became empty"; stepping back to the last real
 * page is what is true.
 */
export function clampOffset(offset: number, total: number | null, pageSize: number): number {
  const start = Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0;
  const size = Math.max(1, Math.floor(pageSize) || 1);
  if (total === null) return start;
  if (total <= 0) return 0;
  return Math.min(start, Math.floor((total - 1) / size) * size);
}

export function pageWindow(
  offset: number,
  count: number,
  total: number | null,
  pageSize: number,
): PageWindow {
  const start = Math.max(0, offset);
  const size = Math.max(1, Math.floor(pageSize) || 1);
  return {
    offset: start,
    count,
    total,
    hasPrev: start > 0,
    // With a total, "there is more" is arithmetic. Without one, a full page is
    // the only evidence available — and guessing "no more" there would hide
    // rows the view actually has.
    hasNext: total === null ? count >= size : start + count < total,
  };
}
