import { pullRequestHostOf, type RepositoryIdentity } from "@t3tools/contracts";
import { parseChangeRequestUrl } from "@t3tools/shared/changeRequestUrl";

import { sourceControlClients } from "./sourceControlClients.ts";

const PULL_REQUEST_NUMBER_PATTERN = /^#?(\d+)$/;

export function parsePullRequestReference(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const normalizedInput =
    sourceControlClients.definitions
      .map((definition) => definition.checkoutCommandArgument(trimmed))
      .find((argument) => argument !== null) ?? trimmed;
  if (normalizedInput.length === 0) {
    return null;
  }

  if (
    sourceControlClients.definitions.some((definition) =>
      definition.isChangeRequestReference(normalizedInput),
    )
  ) {
    return normalizedInput;
  }

  const numberMatch = PULL_REQUEST_NUMBER_PATTERN.exec(normalizedInput);
  if (numberMatch?.[1]) {
    return numberMatch[1];
  }

  return null;
}

/** One repository a bare number can resolve to one of its pull requests in. */
function pullRequestLinkProject(identity: RepositoryIdentity | null | undefined) {
  if (!identity) return null;
  const repository =
    identity.displayName ??
    (identity.owner && identity.name ? `${identity.owner}/${identity.name}` : null);
  if (repository === null) return null;
  const definition = sourceControlClients.get(identity.provider ?? "unknown");
  const host = pullRequestHostOf(identity, definition.kind);
  return {
    host,
    repository,
    webUrl: (number: number) =>
      definition.changeRequestUrl({
        host,
        repository,
        number,
        remoteUrl: identity.locator.remoteUrl,
        webUrl: identity.webUrl,
      }),
  };
}

type LinkRepository = NonNullable<ReturnType<typeof pullRequestLinkProject>>;

/**
 * The thread project's repositories: its own, or the checkouts in a workspace folder, where two
 * checkouts of one repository are one repository to link from.
 */
export function pullRequestLinkRepositories(
  project:
    | {
        readonly repositoryIdentity?: RepositoryIdentity | null | undefined;
        readonly workspaceRepositories?: ReadonlyArray<RepositoryIdentity> | undefined;
      }
    | null
    | undefined,
): ReadonlyArray<LinkRepository> {
  if (!project) return [];
  const identities =
    project.repositoryIdentity != null
      ? [project.repositoryIdentity]
      : (project.workspaceRepositories ?? []);
  const seen = new Set<string>();
  return identities.flatMap((identity) => {
    const repository = pullRequestLinkProject(identity);
    if (repository === null) return [];
    const key = `${repository.host}/${repository.repository}`.toLowerCase();
    if (seen.has(key)) return [];
    seen.add(key);
    return [repository];
  });
}

interface ResolvedLink {
  readonly host: string;
  readonly repository: string;
  readonly number: number;
  readonly url: string;
}

function linkInRepository(
  repository: LinkRepository,
  number: number,
): { link: ResolvedLink } | { error: string } {
  const webUrl = repository.webUrl(number);
  const webReference = webUrl === null ? null : parseChangeRequestUrl(webUrl);
  if (webUrl === null || webReference === null) {
    return { error: "Paste a full URL; this project's host has no known pull request URL." };
  }
  return { link: { ...webReference, url: webUrl } };
}

/**
 * A bare number names a pull request in the thread's only repository; among a workspace folder's
 * checkouts, `repo#123` or `owner/repo#123` picks one.
 */
export function resolveLinkPullRequestInput(input: {
  readonly reference: string;
  readonly repositories: ReadonlyArray<LinkRepository>;
  readonly hasProject: (reference: ResolvedLink) => boolean;
}): { link: ResolvedLink } | { error: string } | null {
  const trimmed = input.reference.trim();
  const named =
    parseChangeRequestUrl(trimmed) === null
      ? /^([\w.-]+(?:\/[\w.-]+)*)#(\d+)$/u.exec(trimmed)
      : null;
  if (named?.[1] && named[2]) {
    const name = named[1].toLowerCase();
    const matches = input.repositories.filter((candidate) => {
      const repository = candidate.repository.toLowerCase();
      return repository === name || repository.split("/").at(-1) === name;
    });
    const number = Number(named[2]);
    if (!Number.isSafeInteger(number) || number < 1) return null;
    if (matches.length === 1) return linkInRepository(matches[0]!, number);
    return {
      error:
        matches.length === 0
          ? `This project holds no repository named ${named[1]}.`
          : `${named[1]} names more than one repository here; write owner/repo#${number}.`,
    };
  }
  const parsed =
    parseChangeRequestUrl(trimmed) !== null ? trimmed : parsePullRequestReference(input.reference);
  if (parsed === null) return null;
  const url = parseChangeRequestUrl(parsed);
  if (url !== null) {
    if (!input.hasProject({ ...url, url: parsed })) {
      return { error: `No project in this environment can read ${url.host}/${url.repository}.` };
    }
    return {
      link: { host: url.host, repository: url.repository, number: url.number, url: parsed },
    };
  }
  const number = Number(parsed);
  if (!Number.isSafeInteger(number) || number < 1) return null;
  const [only, ...others] = input.repositories;
  if (only === undefined) {
    return {
      error:
        "Paste the full pull request URL; this thread has no repository to resolve the number against.",
    };
  }
  if (others.length > 0) {
    return { error: "This folder holds several repositories; enter repo#123, or paste the URL." };
  }
  return linkInRepository(only, number);
}
