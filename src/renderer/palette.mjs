const fold = (text) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
// frugal: every word by substring, in index order; fuzzy ranking if titles prove hard to hit.
export function matchSessions(sessions, query) {
  const words = fold(query).split(/\s+/).filter(Boolean);
  return sessions.filter((session) => {
    const text = fold(`${session.title} ${session.cwd} ${session.space ?? ''} ${session.tags.map((tag) => `#${tag}`).join(' ')}`);
    return words.every((word) => text.includes(word));
  });
}
