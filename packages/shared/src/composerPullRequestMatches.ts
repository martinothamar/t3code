import type { ThreadPullRequestLink } from "@t3tools/contracts";

import { legacyThreadPullRequestKey, visibleThreadPullRequests } from "./threadPullRequests.ts";

export interface ComposerPullRequestMatch {
  /** Keeps the same repository on two hosts apart; entries without one share a key. */
  readonly host?: string;
  /** Exact-number detail reads omit the host; recover it from their URL. */
  readonly url?: string;
  readonly number: number;
  readonly projectId: string;
  readonly repository: string;
  readonly updatedAt: string;
}

export function composerPullRequestsFromLinks(
  links: ReadonlyArray<ThreadPullRequestLink>,
  projectId: string,
) {
  return visibleThreadPullRequests(links).flatMap((link) =>
    link.snapshot === null
      ? []
      : [
          {
            projectId,
            host: link.host,
            repository: link.repository,
            number: link.number,
            url: link.url,
            title: link.snapshot.title,
            headBranch: link.snapshot.headBranch,
            baseBranch: link.snapshot.baseBranch,
            state: link.snapshot.state,
            isDraft: link.snapshot.isDraft,
            updatedAt: link.snapshot.updatedAt ?? link.linkedAt,
          },
        ],
  );
}

export function filterComposerPullRequestMatches<
  Entry extends ComposerPullRequestMatch,
  Linked extends ComposerPullRequestMatch = never,
>(input: {
  readonly entries: ReadonlyArray<Entry>;
  readonly linked?: ReadonlyArray<Linked>;
  readonly projectId: string;
  readonly repositories: ReadonlyArray<string>;
  readonly query: string;
  readonly limit: number;
}): ReadonlyArray<Entry | Linked> {
  const repositories = new Set(
    input.repositories.map((repository) => repository.trim().toLowerCase()),
  );
  const linked = (input.linked ?? []).filter((entry) => String(entry.number).includes(input.query));
  const linkedKeys = new Set(linked.map(composerPullRequestKey));
  const matchingEntries = input.entries.filter(
    (entry) =>
      entry.projectId === input.projectId &&
      repositories.has(entry.repository.trim().toLowerCase()) &&
      String(entry.number).includes(input.query),
  );
  // Prefer the project listing's current data over the linked snapshot of the same pull request.
  const uniqueEntries = new Map<string, Entry | Linked>();
  for (const entry of [...matchingEntries, ...linked]) {
    const key = composerPullRequestKey(entry);
    if (!uniqueEntries.has(key)) {
      uniqueEntries.set(key, entry);
    }
  }
  const isExactMatch = (entry: ComposerPullRequestMatch) => String(entry.number) === input.query;
  const isLinked = (entry: ComposerPullRequestMatch) =>
    linkedKeys.has(composerPullRequestKey(entry));
  // `.sort()` on a copy, not `.toSorted()`: this runs on Hermes, which has no ES2023 array
  // methods, and reaching for one here crashed the composer as the suggestions loaded.
  return [...uniqueEntries.values()]
    .sort(
      (left, right) =>
        Number(isExactMatch(right)) - Number(isExactMatch(left)) ||
        Number(isLinked(right)) - Number(isLinked(left)) ||
        right.updatedAt.localeCompare(left.updatedAt),
    )
    .slice(0, input.limit);
}

/** One suggestion per pull request: its host, repository and number. */
export function composerPullRequestKey(
  entry: Pick<ComposerPullRequestMatch, "host" | "url" | "repository" | "number">,
): string {
  const key =
    entry.host === undefined && entry.url !== undefined
      ? legacyThreadPullRequestKey({ ...entry, url: entry.url })
      : entry;
  return `${key.host?.toLowerCase() ?? ""}/${key.repository.trim().toLowerCase()}#${key.number}`;
}
