const STORAGE_KEY = 'mozzie.recentRepos';
const MAX_RECENT_REPOS = 6;

function canUseStorage() {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

export function getRecentRepos(): string[] {
  if (!canUseStorage()) return [];

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];

    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    return parsed.filter((value): value is string => typeof value === 'string');
  } catch {
    return [];
  }
}

export function saveRecentRepo(repoPath: string): string[] {
  const trimmed = repoPath.trim();
  if (!trimmed || !canUseStorage()) {
    return getRecentRepos();
  }

  const next = [
    trimmed,
    ...getRecentRepos().filter((existing) => existing !== trimmed),
  ].slice(0, MAX_RECENT_REPOS);

  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Ignore storage failures and just return the in-memory result.
  }

  return next;
}

export function getRepoDisplayName(repoPath: string): string {
  const normalized = repoPath.replace(/\\/g, '/').replace(/\/+$/, '');
  const parts = normalized.split('/');
  return parts[parts.length - 1] || repoPath;
}
