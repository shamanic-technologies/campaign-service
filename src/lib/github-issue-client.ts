import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  mergeOf,
  servedContains,
  type GithubCloser,
  type GithubIssueCheck,
  type GithubIssueFacts,
  type GithubIssueRef,
} from "./github-issue-trigger.js";

/**
 * The reads behind lib/github-issue-trigger.ts: GitHub (one GraphQL call per issue, one compare per deploy
 * target) and the box's served record (`deploy.sh` writes `<BOX_SERVED_DIR>/<owner>/<repo>/<target>` = the sha
 * the healthy running container was built from; mounted read-only into this container).
 *
 * Env: `GITHUB_ISSUES_TOKEN` (read access to the org's repos; the same token chat-service files issues with),
 * `BOX_SERVED_DIR`. Either missing = the matching `*_unreadable` state, never "not yet".
 */

const GITHUB_API = "https://api.github.com";

class ReadError extends Error {}

async function github<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = process.env.GITHUB_ISSUES_TOKEN;
  if (!token) throw new ReadError("GITHUB_ISSUES_TOKEN is not set");
  const res = await fetch(`${GITHUB_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "campaign-service",
    },
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  if (!res.ok) throw new ReadError(`GitHub ${res.status} on ${path}: ${text.slice(0, 200)}`);
  return JSON.parse(text) as T;
}

const ISSUE_QUERY = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    defaultBranchRef { name }
    issueOrPullRequest(number: $number) {
      __typename
      ... on Issue {
        state
        stateReason
        timelineItems(itemTypes: [CLOSED_EVENT], last: 1) {
          nodes {
            ... on ClosedEvent {
              closer {
                __typename
                ... on PullRequest { number merged baseRefName mergeCommit { oid } }
                ... on Commit { oid }
              }
            }
          }
        }
      }
      ... on PullRequest { number state merged baseRefName mergeCommit { oid } }
    }
  }
}`;

interface GqlCloser {
  __typename?: string;
  number?: number;
  merged?: boolean;
  baseRefName?: string;
  mergeCommit?: { oid?: string } | null;
  oid?: string;
}

/** What GitHub says about one issue (or pull request). Throws `ReadError` when it cannot be read. */
export async function fetchGithubIssueFacts(ref: GithubIssueRef): Promise<GithubIssueFacts> {
  const body = await github<{
    data?: {
      repository?: {
        defaultBranchRef?: { name?: string } | null;
        issueOrPullRequest?: (GqlCloser & {
          __typename?: string;
          state?: string;
          stateReason?: string | null;
          timelineItems?: { nodes?: Array<{ closer?: GqlCloser | null } | null> };
        }) | null;
      } | null;
    };
    errors?: Array<{ message?: string }>;
  }>("/graphql", {
    method: "POST",
    body: JSON.stringify({ query: ISSUE_QUERY, variables: { owner: ref.owner, repo: ref.repo, number: ref.number } }),
  });
  if (body.errors?.length) throw new ReadError(`GitHub GraphQL: ${body.errors.map((e) => e.message).join("; ").slice(0, 300)}`);
  const repo = body.data?.repository;
  if (!repo) throw new ReadError(`GitHub: repository ${ref.owner}/${ref.repo} not found or not readable with this token`);
  const item = repo.issueOrPullRequest;
  if (!item) throw new ReadError(`GitHub: ${ref.owner}/${ref.repo}#${ref.number} not found`);
  const defaultBranch = repo.defaultBranchRef?.name;
  if (!defaultBranch) throw new ReadError(`GitHub: ${ref.owner}/${ref.repo} states no default branch`);

  const closerOf = (c: GqlCloser | null | undefined): GithubCloser => {
    if (c?.__typename === "PullRequest" && typeof c.number === "number") {
      return { type: "pull_request", number: c.number, merged: c.merged === true, baseRef: c.baseRefName ?? "", mergeSha: c.mergeCommit?.oid ?? null };
    }
    if (c?.__typename === "Commit" && c.oid) return { type: "commit", sha: c.oid };
    return { type: "none" };
  };

  if (item.__typename === "PullRequest") {
    return {
      isPullRequest: true,
      state: item.state === "OPEN" ? "open" : "closed",
      stateReason: null,
      defaultBranch,
      closer: closerOf({ ...item, __typename: "PullRequest" }),
    };
  }
  const nodes = item.timelineItems?.nodes ?? [];
  return {
    isPullRequest: false,
    state: item.state === "OPEN" ? "open" : "closed",
    stateReason: item.stateReason ? item.stateReason.toLowerCase() : null,
    defaultBranch,
    closer: closerOf(nodes[nodes.length - 1]?.closer),
  };
}

/** Does `served` contain `merge` on this repo? Throws `ReadError` when GitHub cannot say. */
export async function fetchServedContains(ref: GithubIssueRef, mergeSha: string, servedSha: string): Promise<boolean> {
  const body = await github<{ status?: string }>(
    `/repos/${ref.owner}/${ref.repo}/compare/${encodeURIComponent(mergeSha)}...${encodeURIComponent(servedSha)}`,
  );
  if (!body.status) throw new ReadError(`GitHub compare ${mergeSha.slice(0, 8)}...${servedSha.slice(0, 8)} states no status`);
  return servedContains(body.status);
}

/**
 * The sha every deploy target of the repo serves, from the box's record. `null` = the box serves nothing of
 * this repo (no record). Throws `ReadError` when the record cannot be read at all.
 */
export async function readServedShas(ref: GithubIssueRef): Promise<Array<{ target: string; sha: string }> | null> {
  const root = process.env.BOX_SERVED_DIR;
  if (!root) throw new ReadError("BOX_SERVED_DIR is not set");
  // The record is written under GitHub's spelling; ours is lowercased. Match the directories case-insensitively.
  let owners: string[];
  try {
    owners = await readdir(root);
  } catch (err) {
    throw new ReadError(`the box's served record ${root} is not readable: ${err instanceof Error ? err.message : String(err)}`);
  }
  const owner = owners.find((o) => o.toLowerCase() === ref.owner);
  if (!owner) return null;
  const repos = await readdir(join(root, owner));
  const repo = repos.find((r) => r.toLowerCase() === ref.repo);
  if (!repo) return null;
  const targets = (await readdir(join(root, owner, repo))).filter((t) => !t.startsWith("."));
  if (targets.length === 0) return null;
  const out: Array<{ target: string; sha: string }> = [];
  for (const target of targets.sort()) {
    const sha = (await readFile(join(root, owner, repo, target), "utf8")).trim();
    if (!/^[0-9a-f]{7,40}$/.test(sha)) throw new ReadError(`the box's served record for ${owner}/${repo} ${target} is not a sha: ${JSON.stringify(sha.slice(0, 50))}`);
    out.push({ target, sha });
  }
  return out;
}

export interface GithubIssueReads {
  facts: typeof fetchGithubIssueFacts;
  served: typeof readServedShas;
  contains: typeof fetchServedContains;
}

const LIVE_READS: GithubIssueReads = { facts: fetchGithubIssueFacts, served: readServedShas, contains: fetchServedContains };

/** Is the issue in prod, and if not why. Never throws: an unreadable source is its own state. */
export async function checkGithubIssue(
  ref: GithubIssueRef,
  now: Date = new Date(),
  reads: GithubIssueReads = LIVE_READS,
): Promise<GithubIssueCheck> {
  const checkedAt = now.toISOString();
  let facts: GithubIssueFacts;
  try {
    facts = await reads.facts(ref);
  } catch (err) {
    return { state: "github_unreadable", detail: err instanceof Error ? err.message : String(err), checkedAt };
  }
  const merge = mergeOf(facts);
  if (!merge.ok) return { state: merge.state, detail: merge.detail, checkedAt };
  const base = { checkedAt, mergeSha: merge.mergeSha, mergedBy: merge.mergedBy };

  let targets: Array<{ target: string; sha: string }> | null;
  try {
    targets = await reads.served(ref);
  } catch (err) {
    return { ...base, state: "served_unreadable", detail: err instanceof Error ? err.message : String(err) };
  }
  if (!targets) {
    return { ...base, state: "not_served_by_box", detail: `the box deploys nothing from ${ref.owner}/${ref.repo}, so it never reaches prod there` };
  }

  const served: NonNullable<GithubIssueCheck["served"]> = [];
  for (const t of targets) {
    try {
      served.push({ ...t, containsMerge: await reads.contains(ref, merge.mergeSha, t.sha) });
    } catch (err) {
      return { ...base, state: "github_unreadable", detail: err instanceof Error ? err.message : String(err) };
    }
  }
  const waiting = served.filter((s) => !s.containsMerge);
  if (waiting.length > 0) {
    return {
      ...base,
      served,
      state: "merged_not_deployed",
      detail: `merged by ${merge.mergedBy}; not served yet by ${waiting.map((w) => `${w.target} (on ${w.sha.slice(0, 8)})`).join(", ")}`,
    };
  }
  return { ...base, served, state: "in_prod", detail: `merged by ${merge.mergedBy} and served by ${served.map((s) => s.target).join(", ")}` };
}
