/**
 * ONE definition of "a run is alive for this campaign", shared by every leg that asks.
 *
 * A run older than this window is an ORPHAN: its DAG died without ever calling `/end-run`, so the
 * row stays `running` forever and nothing else will ever close it. The threshold must therefore be
 * strictly greater than the longest legitimate flow — lead-service's `buffer/next` fill runs up to
 * ~10 min (`PULL_NEXT_TIMEOUT_MS`) and the wrapping `lead-service/lead-serve` run has been observed
 * at 755s in prod — and as small as that allows, because it is also the blind window in which a
 * campaign whose run was orphaned cannot be told apart from one that is working.
 *
 * It lives in its own module because TWO legs read it and they must never disagree:
 *
 *   - the scheduler's stuck sweep (`claimStuckCampaigns`), which re-schedules a campaign whose run
 *     is no longer alive, and
 *   - gate-check's stale cleanup (block 1), which finalizes that orphan so the one-run-at-a-time
 *     guard (block 2) stops reading it as a live run.
 *
 * They used to disagree by 12× — 15 minutes here, THREE HOURS there — and the gap is a full stop
 * that nothing reports as one. Prod 2026-09-17, campaign 647572d9-729e-4731-9456-28fa351be92c: a
 * deploy restarted campaign-service mid-DAG at 05:50:41, the Windmill job failed ten seconds later,
 * and its `campaign-service` marker run was left `running` with no `/end-run` ever coming. From
 * 06:05 the scheduler correctly read that run as dead and re-fired the campaign every ~15 minutes;
 * the gate read the SAME row as alive and refused every one of those runs with "A run is already in
 * progress" — for the 2h45m remaining on its own three-hour threshold. Every refusal burned a
 * Windmill job and produced nothing, and the campaign said, truthfully and uselessly, that a run
 * was in progress.
 *
 * Two legs on two definitions is the shape this service keeps deleting.
 */
export const RUN_LIVENESS_THRESHOLD_MS = 15 * 60_000; // 15 minutes
