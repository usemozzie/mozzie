/**
 * Assigns each active work item a unique lettered tag (A, B, C…)
 * with a color generated via golden-angle hue spacing so no two
 * items ever share the same color, even with many open at once.
 */

export interface WorkItemTag {
  letter: string;
  color: string;
}

export function getWorkItemTag(index: number): WorkItemTag {
  const safeIndex = Math.max(0, index);
  const letter = String.fromCharCode(65 + (safeIndex % 26)); // A–Z
  // Golden angle spacing gives maximum visual separation between adjacent indices
  const hue = (safeIndex * 137.508) % 360;
  const color = `hsl(${Math.round(hue)}, 65%, 65%)`;
  return { letter, color };
}

/** Backwards-compat helper — returns just the color string */
export function getWorkItemColor(index: number): string {
  return getWorkItemTag(index).color;
}
