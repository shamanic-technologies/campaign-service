import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  eventConcernsGithubIssue,
  githubIssueFromKey,
  githubIssueKey,
  mergeOf,
  parseGithubIssue,
  serializeGithubIssue,
  type GithubIssueFacts,
} from "../../src/lib/github-issue-trigger.js";
import { checkGithubIssue, readServedShas, type GithubIssueReads } from "../../src/lib/github-issue-client.js";

const REF = parseGithubIssue({ repo: "Shamanic-Technologies/Campaign-Service", number: 12 })!;
const MERGE = "a".repeat(40);
const OLD = "b".repeat(40);
const NEW = "c".repeat(40);

const closedBy = (closer: GithubIssueFacts["closer"], stateReason = "completed"): GithubIssueFacts => ({
  isPullRequest: false, state: "closed", stateReason, defaultBranch: "main", closer,
});
const mergedPr = { type: "pull_request" as const, number: 7, merged: true, baseRef: "main", mergeSha: MERGE };

function reads(facts: GithubIssueFacts, served: Array<{ target: string; sha: string }> | null, containing: string[]): GithubIssueReads {
  return {
    facts: async () => facts,
    served: async () => served,
    contains: async (_r, merge, sha) => merge === MERGE && containing.includes(sha),
  };
}

describe("github issue references", () => {
  it("canonicalizes owner/repo and round-trips the key", () => {
    expect(githubIssueKey(REF)).toBe("shamanic-technologies/campaign-service#12");
    expect(githubIssueFromKey("shamanic-technologies/campaign-service#12")).toEqual(REF);
    expect(serializeGithubIssue("shamanic-technologies/campaign-service#12")).toEqual({ repo: "shamanic-technologies/campaign-service", number: 12 });
    expect(parseGithubIssue({ repo: "no-slash", number: 1 })).toBeNull();
    expect(parseGithubIssue({ repo: "a/b", number: 0 })).toBeNull();
  });

  it("a campaign waiting on an issue concerns only the event naming that issue", () => {
    expect(eventConcernsGithubIssue(null, null)).toBe(true);
    expect(eventConcernsGithubIssue("o/r#1", { githubIssue: "o/r#1" })).toBe(true);
    expect(eventConcernsGithubIssue("o/r#1", { githubIssue: "o/r#2" })).toBe(false);
    expect(eventConcernsGithubIssue("o/r#1", null)).toBe(false);
  });
});

describe("mergeOf", () => {
  it("open, not planned, hand-closed and a merge elsewhere never name a merge", () => {
    expect(mergeOf({ ...closedBy(mergedPr), state: "open", stateReason: null })).toMatchObject({ ok: false, state: "open" });
    expect(mergeOf(closedBy(mergedPr, "not_planned"))).toMatchObject({ ok: false, state: "closed_not_completed" });
    expect(mergeOf(closedBy({ type: "none" }))).toMatchObject({ ok: false, state: "closed_without_merge" });
    expect(mergeOf(closedBy({ ...mergedPr, baseRef: "staging" }))).toMatchObject({ ok: false, state: "closed_without_merge" });
    expect(mergeOf(closedBy({ ...mergedPr, merged: false }))).toMatchObject({ ok: false, state: "closed_without_merge" });
  });
  it("a merged PR into the default branch, or a closing commit, is the merge", () => {
    expect(mergeOf(closedBy(mergedPr))).toEqual({ ok: true, mergeSha: MERGE, mergedBy: "pull request #7" });
    expect(mergeOf(closedBy({ type: "commit", sha: MERGE }))).toMatchObject({ ok: true, mergeSha: MERGE });
  });
  it("a pull request number is its own merge", () => {
    expect(mergeOf({ isPullRequest: true, state: "closed", stateReason: null, defaultBranch: "main", closer: mergedPr })).toMatchObject({ ok: true, mergeSha: MERGE });
  });
});

describe("checkGithubIssue: in prod = merged AND served by every target", () => {
  it("merged but not served yet waits, naming the target", async () => {
    const c = await checkGithubIssue(REF, new Date(), reads(closedBy(mergedPr), [{ target: "campaign-service", sha: OLD }], []));
    expect(c.state).toBe("merged_not_deployed");
    expect(c.detail).toContain("campaign-service");
  });
  it("served by one target of two still waits; by all = in prod", async () => {
    const two = [{ target: "admin-app", sha: NEW }, { target: "landing-app", sha: OLD }];
    expect((await checkGithubIssue(REF, new Date(), reads(closedBy(mergedPr), two, [NEW]))).state).toBe("merged_not_deployed");
    const c = await checkGithubIssue(REF, new Date(), reads(closedBy(mergedPr), two, [NEW, OLD]));
    expect(c).toMatchObject({ state: "in_prod", mergeSha: MERGE });
    expect(c.served).toHaveLength(2);
  });
  it("unreadable sources are their own states, never 'not yet'", async () => {
    const boom = async () => { throw new Error("GitHub 401"); };
    expect((await checkGithubIssue(REF, new Date(), { ...reads(closedBy(mergedPr), [], []), facts: boom })).state).toBe("github_unreadable");
    expect((await checkGithubIssue(REF, new Date(), { ...reads(closedBy(mergedPr), [], []), served: boom })).state).toBe("served_unreadable");
    expect((await checkGithubIssue(REF, new Date(), { ...reads(closedBy(mergedPr), [{ target: "x", sha: NEW }], []), contains: boom })).state).toBe("github_unreadable");
    expect((await checkGithubIssue(REF, new Date(), reads(closedBy(mergedPr), null, []))).state).toBe("not_served_by_box");
  });
  it("an open issue reads nothing from the box", async () => {
    let servedAsked = false;
    const r = reads({ ...closedBy(mergedPr), state: "open" }, [], []);
    const c = await checkGithubIssue(REF, new Date(), { ...r, served: async () => { servedAsked = true; return []; } });
    expect(c.state).toBe("open");
    expect(servedAsked).toBe(false);
  });
});

describe("readServedShas (the box's record)", () => {
  let dir = "";
  const prev = process.env.BOX_SERVED_DIR;
  afterEach(async () => {
    process.env.BOX_SERVED_DIR = prev;
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("reads every target of the repo, case-insensitively; a repo with no record is null", async () => {
    dir = await mkdtemp(join(tmpdir(), "served-"));
    await mkdir(join(dir, "Shamanic-Technologies", "campaign-service"), { recursive: true });
    await writeFile(join(dir, "Shamanic-Technologies", "campaign-service", "campaign-service"), `${NEW}\n`);
    await writeFile(join(dir, "Shamanic-Technologies", "campaign-service", ".campaign-service.tmp"), "junk");
    process.env.BOX_SERVED_DIR = dir;
    expect(await readServedShas(REF)).toEqual([{ target: "campaign-service", sha: NEW }]);
    expect(await readServedShas(parseGithubIssue({ repo: "shamanic-technologies/other", number: 1 })!)).toBeNull();
  });

  it("an unset or unreadable record throws (fail loud)", async () => {
    delete process.env.BOX_SERVED_DIR;
    await expect(readServedShas(REF)).rejects.toThrow(/BOX_SERVED_DIR/);
    process.env.BOX_SERVED_DIR = "/definitely/not/here";
    await expect(readServedShas(REF)).rejects.toThrow(/not readable/);
  });
});
