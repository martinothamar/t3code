import { describe, expect, it } from "vite-plus/test";

import type { ThreadPullRequestLink } from "@t3tools/contracts";

import {
  composerPullRequestsFromLinks,
  filterComposerPullRequestMatches,
} from "./composerPullRequestMatches.ts";

const entry = (number: number, updatedAt: string) => ({
  number,
  host: "github.com",
  projectId: "p1",
  repository: "owner/repo",
  updatedAt,
});

describe("filterComposerPullRequestMatches", () => {
  it("ranks the exact number above newer substring matches", () => {
    const result = filterComposerPullRequestMatches({
      entries: [entry(1234, "2026-01-03"), entry(123, "2026-01-01"), entry(1230, "2026-01-02")],
      projectId: "p1",
      repositories: ["owner/repo"],
      query: "123",
      limit: 10,
    });
    expect(result.map((match) => match.number)).toEqual([123, 1234, 1230]);
  });
  it("keeps the same repository on two hosts apart", () => {
    const result = filterComposerPullRequestMatches({
      entries: [
        { ...entry(7, "2026-01-02"), host: "github.com" },
        { ...entry(7, "2026-01-01"), host: "github.acme.test" },
      ],
      projectId: "p1",
      repositories: ["owner/repo"],
      query: "7",
      limit: 10,
    });
    expect(result.map((match) => match.host)).toEqual(["github.com", "github.acme.test"]);
  });
});

describe("linked pull requests", () => {
  const link = (
    repository: string,
    number: number,
    overrides: Partial<ThreadPullRequestLink> = {},
  ): ThreadPullRequestLink => ({
    host: "github.com",
    repository,
    number,
    url: `https://github.com/${repository}/pull/${number}`,
    source: "agent",
    linkedAt: "2026-01-01T00:00:00.000Z",
    snapshot: {
      state: "open",
      title: `${repository} ${number}`,
      headBranch: "feature",
      baseBranch: "main",
      isDraft: false,
      updatedAt: "2026-01-02T00:00:00.000Z",
      syncedAt: "2026-01-02T00:00:00.000Z",
    },
    stack: null,
    ...overrides,
  });

  it("offers a linked pull request from another repository above the project's own", () => {
    const result = filterComposerPullRequestMatches({
      entries: [entry(4, "2026-01-03"), { ...entry(4, "2026-01-04"), repository: "owner/other" }],
      linked: composerPullRequestsFromLinks([link("owner/repo-b", 4)], "p1"),
      projectId: "p1",
      repositories: ["owner/repo"],
      query: "4",
      limit: 10,
    });
    expect(result.map((match) => `${match.repository}#${match.number}`)).toEqual([
      "owner/repo-b#4",
      "owner/repo#4",
    ]);
  });

  it("keeps one row for a linked pull request the project listing already has", () => {
    const result = filterComposerPullRequestMatches({
      entries: [entry(4, "2026-01-03")],
      linked: composerPullRequestsFromLinks([link("Owner/Repo", 4)], "p1"),
      projectId: "p1",
      repositories: ["owner/repo"],
      query: "",
      limit: 10,
    });
    expect(result).toEqual([entry(4, "2026-01-03")]);
  });

  it("merges a hostless exact-number detail with its linked snapshot", () => {
    const { host: _host, ...detail } = {
      ...entry(42, "2026-01-03"),
      url: "https://github.com/owner/repo/pull/42",
    };
    const result = filterComposerPullRequestMatches({
      entries: [detail, { ...entry(142, "2026-01-04"), host: "github.acme.test" }],
      linked: composerPullRequestsFromLinks([link("owner/repo", 42)], "p1"),
      projectId: "p1",
      repositories: ["owner/repo"],
      query: "42",
      limit: 10,
    });
    expect(result).toEqual([detail, { ...entry(142, "2026-01-04"), host: "github.acme.test" }]);
  });

  it("combines workspace repositories and linked suggestions while preserving exact-number priority", () => {
    const result = filterComposerPullRequestMatches({
      entries: [
        entry(4, "2026-01-03"),
        { ...entry(14, "2026-01-05"), repository: "owner/workspace-b" },
        { ...entry(4, "2026-01-06"), repository: "owner/unrelated" },
      ],
      linked: composerPullRequestsFromLinks([link("owner/linked", 14)], "p1"),
      projectId: "p1",
      repositories: ["owner/repo", "owner/workspace-b"],
      query: "4",
      limit: 10,
    });
    expect(result.map((match) => `${match.repository}#${match.number}`)).toEqual([
      "owner/repo#4",
      "owner/linked#14",
      "owner/workspace-b#14",
    ]);
  });

  it("deduplicates a linked snapshot only against the listing from the same host", () => {
    const result = filterComposerPullRequestMatches({
      entries: [entry(4, "2026-01-03"), { ...entry(4, "2026-01-04"), host: "github.acme.test" }],
      linked: composerPullRequestsFromLinks([link("owner/repo", 4)], "p1"),
      projectId: "p1",
      repositories: ["owner/repo"],
      query: "4",
      limit: 10,
    });
    expect(result.map((match) => match.host)).toEqual(["github.com", "github.acme.test"]);
    expect(result[0]).toEqual(entry(4, "2026-01-03"));
  });
});
