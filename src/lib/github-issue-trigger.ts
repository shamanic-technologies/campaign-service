/**
 * THE `github_issue_in_prod` TRIGGER KIND (owner 2026-10-12, ISSUE-IN-PROD-TRIGGER-1012): "que l'agent doive
 * d'abord créer une issue GitHub, et qu'on crée un nouveau type de trigger qui se déclenche quand une issue GitHub
 * est en prod".
 *
 * A GENERAL kind, like `delay` and `poll`: features-service declares trigger TYPES of this kind (`/public/channels`
 * `triggers[].kind`), any channel's reactive leg may name one, and this service detects it
 * (lib/github-issue-trigger-detector.ts, in the generic detectors loop). WHICH issue is a per-CAMPAIGN fact: a
 * sales funnel campaign states `githubIssue` (repo + number) at launch, and its units answering such a trigger run
 * only for the event naming that issue. Never a caller or channel branch.
 *
 * "IN PROD" (owner rule: a merged release is not a deployed one; verify the served artifact), ALL of:
 *  1. the issue is CLOSED as COMPLETED (closed as not planned / duplicate never fires);
 *  2. what closed it is a merge on the repo's default branch: a merged pull request into it, or a commit (a
 *     "fixes #N" commit), whose sha is the MERGE;
 *  3. EVERY deploy target of the repo on the box serves a commit CONTAINING that merge (`deploy.sh` records, per
 *     target, the sha the healthy running container was built from; GitHub's compare says "contains").
 * A merged-but-not-deployed merge waits. A repo the box does not serve never fires, and says so.
 *
 * FAIL LOUD: GitHub or the box record unreadable is its own state (`github_unreadable`, `served_unreadable`),
 * logged at error each tick and stored on the campaign, never read as "not yet".
 */

export const GITHUB_ISSUE_IN_PROD_KIND = "github_issue_in_prod" as const;

export interface GithubIssueRef {
  owner: string;
  repo: string;
  number: number;
}

const REPO_RE = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/;

/** A caller's `{repo: "owner/name", number}`, canonical. Null = not a GitHub issue reference. Pure. */
export function parseGithubIssue(input: { repo: string; number: number }): GithubIssueRef | null {
  const m = REPO_RE.exec(input.repo.trim());
  if (!m || !Number.isInteger(input.number) || input.number < 1) return null;
  return { owner: m[1].toLowerCase(), repo: m[2].toLowerCase(), number: input.number };
}

/** The stored key: `owner/repo#number`. Pure. */
export function githubIssueKey(ref: GithubIssueRef): string {
  return `${ref.owner}/${ref.repo}#${ref.number}`;
}

/** The stored key back to a reference. Null = not a key this module wrote. Pure. */
export function githubIssueFromKey(key: string | null | undefined): GithubIssueRef | null {
  if (!key) return null;
  const hash = key.lastIndexOf("#");
  if (hash < 0) return null;
  const n = Number(key.slice(hash + 1));
  return parseGithubIssue({ repo: key.slice(0, hash), number: n });
}

/** The wire shape of a stored key. Pure. */
export function serializeGithubIssue(key: string | null | undefined): { repo: string; number: number } | null {
  const ref = githubIssueFromKey(key);
  return ref ? { repo: `${ref.owner}/${ref.repo}`, number: ref.number } : null;
}

/**
 * Does a detector event concern a unit whose funnel campaign waits on `waitsOn`? A campaign waiting on an issue
 * runs only for an event naming THAT issue (`trigger.item.githubIssue`); one waiting on nothing is unaffected. Pure.
 */
export function eventConcernsGithubIssue(waitsOn: string | null | undefined, triggerItem: unknown): boolean {
  if (!waitsOn) return true;
  const named = triggerItem && typeof triggerItem === "object" ? (triggerItem as { githubIssue?: unknown }).githubIssue : undefined;
  return named === waitsOn;
}

// ── What GitHub and the box say, and the verdict ──────────────────────────────────────────────────

/** What closed an issue, as GitHub states it (the LAST close). */
export type GithubCloser =
  | { type: "pull_request"; number: number; merged: boolean; baseRef: string; mergeSha: string | null }
  | { type: "commit"; sha: string }
  | { type: "none" };

export interface GithubIssueFacts {
  /** The number names a pull request itself (then IT is what must reach prod). */
  isPullRequest: boolean;
  state: "open" | "closed";
  /** GitHub's `stateReason` (COMPLETED, NOT_PLANNED, DUPLICATE, REOPENED) lowercased, or null. */
  stateReason: string | null;
  defaultBranch: string;
  closer: GithubCloser;
}

export type GithubIssueState =
  | "open"
  | "closed_not_completed"
  | "closed_without_merge"
  | "merged_not_deployed"
  | "in_prod"
  | "not_served_by_box"
  | "github_unreadable"
  | "served_unreadable";

/** The merge that must reach prod, or why there is none. Pure. */
export function mergeOf(facts: GithubIssueFacts):
  | { ok: true; mergeSha: string; mergedBy: string }
  | { ok: false; state: Exclude<GithubIssueState, "merged_not_deployed" | "in_prod" | "not_served_by_box" | "github_unreadable" | "served_unreadable">; detail: string } {
  if (facts.isPullRequest) {
    const c = facts.closer;
    if (c.type !== "pull_request" || !c.merged) {
      return facts.state === "open"
        ? { ok: false, state: "open", detail: "the pull request is open" }
        : { ok: false, state: "closed_without_merge", detail: "the pull request was closed without being merged" };
    }
    if (c.baseRef !== facts.defaultBranch) {
      return { ok: false, state: "closed_without_merge", detail: `the pull request merged into ${c.baseRef}, not ${facts.defaultBranch}` };
    }
    if (!c.mergeSha) return { ok: false, state: "closed_without_merge", detail: "GitHub states no merge commit" };
    return { ok: true, mergeSha: c.mergeSha, mergedBy: `pull request #${c.number}` };
  }
  if (facts.state === "open") return { ok: false, state: "open", detail: "the issue is open" };
  if (facts.stateReason !== "completed") {
    return { ok: false, state: "closed_not_completed", detail: `the issue was closed as ${facts.stateReason ?? "unstated"}` };
  }
  const c = facts.closer;
  if (c.type === "commit") return { ok: true, mergeSha: c.sha, mergedBy: `commit ${c.sha.slice(0, 8)}` };
  if (c.type === "pull_request") {
    if (!c.merged) return { ok: false, state: "closed_without_merge", detail: `pull request #${c.number} is not merged` };
    if (c.baseRef !== facts.defaultBranch) {
      return { ok: false, state: "closed_without_merge", detail: `pull request #${c.number} merged into ${c.baseRef}, not ${facts.defaultBranch}` };
    }
    if (!c.mergeSha) return { ok: false, state: "closed_without_merge", detail: `pull request #${c.number} states no merge commit` };
    return { ok: true, mergeSha: c.mergeSha, mergedBy: `pull request #${c.number}` };
  }
  return { ok: false, state: "closed_without_merge", detail: "the issue was closed by hand, not by a merge" };
}

/** Does `served` contain `merge`? GitHub compare `merge...served`: `ahead` / `identical` = yes. Pure. */
export function servedContains(compareStatus: string): boolean {
  return compareStatus === "ahead" || compareStatus === "identical";
}

export interface GithubIssueCheck {
  state: GithubIssueState;
  detail: string;
  checkedAt: string;
  mergeSha?: string;
  mergedBy?: string;
  /** Per deploy target: the sha it serves and whether that contains the merge. */
  served?: Array<{ target: string; sha: string; containsMerge: boolean }>;
}
