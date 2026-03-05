const TICKET_COLORS = [
  '#2AEAB3',
  '#60A5FA',
  '#F59E0B',
  '#F472B6',
  '#A78BFA',
  '#34D399',
];

export function getTicketColor(index: number): string {
  const safeIndex = Math.max(0, index);
  return TICKET_COLORS[safeIndex % TICKET_COLORS.length];
}
