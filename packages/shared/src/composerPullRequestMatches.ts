import type { ThreadPullRequestLink } from "@t3tools/contracts";

import { visibleThreadPullRequests } from "./threadPullRequests.ts";

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
  // Hermes has no ES2023 array methods, so sort a fresh array.
  return [...uniqueEntries.values()]
    .sort(
      (left, right) =>
        Number(isExactMatch(right)) - Number(isExactMatch(left)) ||
        Number(isLinked(right)) - Number(isLinked(left)) ||
        right.updatedAt.localeCompare(left.updatedAt),
    )
    .slice(0, input.limit);
}

/** Puts the thread's linked pull requests that match a text query ahead of the searched ones. */
export function withLinkedComposerPullRequestsFirst<
  Entry extends ComposerPullRequestMatch,
  Linked extends ComposerPullRequestMatch & {
    readonly title: string;
    readonly headBranch: string;
  },
>(input: {
  readonly matches: ReadonlyArray<Entry>;
  readonly linked: ReadonlyArray<Linked>;
  readonly query: string;
  readonly limit: number;
}): ReadonlyArray<Entry | Linked> {
  const matchesByKey = new Map(
    input.matches.map((entry) => [composerPullRequestKey(entry), entry]),
  );
  const words = input.query.toLowerCase().split(/\s+/u).filter(Boolean);
  const linked = input.linked.flatMap((entry): Array<Entry | Linked> => {
    const match = matchesByKey.get(composerPullRequestKey(entry));
    if (match !== undefined) return [match];
    const text =
      `#${entry.number} ${entry.title} ${entry.repository} ${entry.headBranch}`.toLowerCase();
    return words.every((word) => text.includes(word)) ? [entry] : [];
  });
  const linkedKeys = new Set(linked.map(composerPullRequestKey));
  return [
    ...linked,
    ...input.matches.filter((entry) => !linkedKeys.has(composerPullRequestKey(entry))),
  ].slice(0, input.limit);
}

/** One suggestion per pull request: its host, repository and number. */
export function composerPullRequestKey(
  entry: Pick<ComposerPullRequestMatch, "host" | "url" | "repository" | "number">,
): string {
  const host = entry.host ?? (entry.url === undefined ? undefined : urlHost(entry.url));
  return `${host?.toLowerCase() ?? ""}/${entry.repository.trim().toLowerCase()}#${entry.number}`;
}

function urlHost(url: string): string | undefined {
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}
