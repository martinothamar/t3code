export interface ComposerPullRequestMatch {
  /** Keeps the same repository on two hosts apart; entries without one share a key. */
  readonly host?: string;
  readonly number: number;
  readonly projectId: string;
  readonly repository: string;
  readonly updatedAt: string;
}

/**
 * Pull requests matching the numeric fragment typed after `#`, de-duplicated. An exact number
 * match always outranks a substring match so the result limit can never drop the pull request
 * the user typed in full; the rest stay newest first. `repositories` are the project's own: one
 * for a project rooted in a repository, or the checkouts of a workspace folder.
 */
export function filterComposerPullRequestMatches<Entry extends ComposerPullRequestMatch>(input: {
  readonly entries: ReadonlyArray<Entry>;
  readonly projectId: string;
  readonly repositories: ReadonlyArray<string>;
  readonly query: string;
  readonly limit: number;
}): ReadonlyArray<Entry> {
  const repositories = new Set(
    input.repositories.map((repository) => repository.trim().toLowerCase()),
  );
  const matchingEntries = input.entries.filter(
    (entry) =>
      entry.projectId === input.projectId &&
      repositories.has(entry.repository.trim().toLowerCase()) &&
      String(entry.number).includes(input.query),
  );
  // Two repositories can each have the same number, so they stay apart.
  const uniqueEntries = new Map<string, Entry>();
  for (const entry of matchingEntries) {
    const key = composerPullRequestKey(entry);
    if (!uniqueEntries.has(key)) {
      uniqueEntries.set(key, entry);
    }
  }
  const isExactMatch = (entry: Entry) => String(entry.number) === input.query;
  // `.sort()` on a copy, not `.toSorted()`: this runs on Hermes, which has no ES2023 array
  // methods, and reaching for one here crashed the composer as the suggestions loaded.
  return [...uniqueEntries.values()]
    .sort((left, right) => {
      const exactness = Number(isExactMatch(right)) - Number(isExactMatch(left));
      return exactness !== 0 ? exactness : right.updatedAt.localeCompare(left.updatedAt);
    })
    .slice(0, input.limit);
}

/** One suggestion per pull request: its host, repository and number. */
export function composerPullRequestKey(
  entry: Pick<ComposerPullRequestMatch, "host" | "repository" | "number">,
): string {
  return `${entry.host?.toLowerCase() ?? ""}/${entry.repository.trim().toLowerCase()}#${entry.number}`;
}
