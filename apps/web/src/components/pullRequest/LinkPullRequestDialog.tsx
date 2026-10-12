import { pullRequestHostOf, type ScopedThreadRef } from "@t3tools/contracts";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { useAtomValue } from "@effect/atom-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { parseChangeRequestUrl } from "~/lib/openPullRequestLink";
import { parsePullRequestReference } from "~/pullRequestReference";
import { useProjects, useThreadShell } from "~/state/entities";
import { usePullRequestLinking } from "~/hooks/usePullRequestLinking";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { Atom } from "effect/reactivity";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";

/**
 * Which thread has the link dialog open, set by whichever entry point asked (command palette,
 * pull-requests surface, detail panel) and rendered once by the chat view so the dialog outlives
 * a palette that closes the moment its command runs.
 */
const linkPullRequestDialogThreadAtom = Atom.make<ScopedThreadRef | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("pull-requests:link-dialog-thread"),
);

export function openLinkPullRequestDialog(threadRef: ScopedThreadRef): void {
  appAtomRegistry.set(linkPullRequestDialogThreadAtom, threadRef);
}

interface LinkPullRequestDialogProps {
  open: boolean;
  threadRef: ScopedThreadRef;
  /** The thread's own project: bare numbers resolve against its repository. */
  projectId: string | null;
  onOpenChange: (open: boolean) => void;
}

/** Mounted once per chat view; shows the dialog for whichever thread asked for it. */
export function LinkPullRequestDialogHost() {
  const threadRef = useAtomValue(linkPullRequestDialogThreadAtom);
  const thread = useThreadShell(threadRef);
  const linking = usePullRequestLinking(threadRef?.environmentId);
  if (threadRef === null || linking.mode === "unsupported") return null;
  return (
    <LinkPullRequestDialog
      open
      threadRef={threadRef}
      projectId={thread?.projectId ?? null}
      onOpenChange={(open) => {
        if (!open) appAtomRegistry.set(linkPullRequestDialogThreadAtom, null);
      }}
    />
  );
}

interface ResolvedLink {
  readonly host: string;
  readonly repository: string;
  readonly number: number;
  readonly url: string;
}

interface LinkRepository {
  readonly host: string;
  readonly repository: string;
  readonly webUrl: (number: number) => string | null;
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
 * Which pull request an input names, or why it cannot. A URL carries its own host and
 * repository; a bare `#123` can only mean the thread's own repository. `repositories` are the
 * thread project's: one for a project rooted in a repository, or a workspace folder's
 * checkouts, among which `repo#123` or `owner/repo#123` picks one.
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
    return { error: "Paste a full URL to link a pull request from another repository." };
  }
  if (others.length > 0) {
    return { error: "This folder holds several repositories; enter repo#123, or paste the URL." };
  }
  return linkInRepository(only, number);
}

function LinkPullRequestDialog({
  open,
  threadRef,
  projectId,
  onOpenChange,
}: LinkPullRequestDialogProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [reference, setReference] = useState("");
  const [dirty, setDirty] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const projects = useProjects();
  const environmentProjects = useMemo(
    () => projects.filter((project) => project.environmentId === threadRef.environmentId),
    [projects, threadRef.environmentId],
  );
  const ownRepositories = useMemo((): ReadonlyArray<LinkRepository> => {
    const project = environmentProjects.find((candidate) => candidate.id === projectId);
    if (!project) return [];
    const identities =
      project.repositoryIdentity != null
        ? [project.repositoryIdentity]
        : (project.workspaceRepositories ?? []);
    return identities.flatMap((identity) => {
      const repository =
        identity.displayName ??
        (identity.owner && identity.name ? `${identity.owner}/${identity.name}` : null);
      if (repository === null) return [];
      const definition = sourceControlClients.get(identity.provider ?? "unknown");
      const host = pullRequestHostOf(identity, definition.kind);
      return [
        {
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
        },
      ];
    });
  }, [environmentProjects, projectId]);
  const linking = usePullRequestLinking(threadRef.environmentId);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!open) return;
    setReference("");
    setDirty(false);
    setSubmitError(null);
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  const resolved = useMemo(
    () =>
      resolveLinkPullRequestInput({
        reference,
        repositories: ownRepositories,
        hasProject: (reference) => linking.canLink(reference.url),
      }),
    [linking, ownRepositories, reference],
  );

  const submit = useCallback(async () => {
    setDirty(true);
    if (resolved === null || "error" in resolved) return;
    setSubmitError(null);
    setPending(true);
    try {
      await linking.changeLink(threadRef, resolved.link.url, true);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "Could not link the pull request.");
      return;
    } finally {
      setPending(false);
    }
    onOpenChange(false);
  }, [linking, onOpenChange, resolved, threadRef]);

  const validation = !dirty
    ? null
    : reference.trim().length === 0
      ? "Paste a pull request URL or enter 123 / #123."
      : resolved === null
        ? "Use a pull request URL, 123, or #123."
        : "error" in resolved
          ? resolved.error
          : null;

  return (
    <Dialog open={open} onOpenChange={(next) => (pending ? undefined : onOpenChange(next))}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Link pull request</DialogTitle>
          <DialogDescription>
            Attach a pull request to this thread by its URL, or by its number for this thread's
            repository.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <Input
            ref={inputRef}
            placeholder="Pull request URL or #42"
            value={reference}
            onChange={(event) => {
              setDirty(true);
              setReference(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              void submit();
            }}
          />
          {resolved !== null && "link" in resolved ? (
            <p className="truncate text-muted-foreground text-xs">
              {resolved.link.host}/{resolved.link.repository} #{resolved.link.number}
            </p>
          ) : null}
          {(validation ?? submitError) ? (
            <p className="text-destructive text-xs">{validation ?? submitError}</p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onOpenChange(false)}
            disabled={pending}
          >
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => void submit()}
            disabled={pending || resolved === null || "error" in resolved}
          >
            {pending ? "Linking..." : "Link"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
