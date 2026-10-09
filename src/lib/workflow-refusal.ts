/**
 * workflow-service REFUSED to execute a workflow. Thrown by `executeCampaignWorkflow` on any non-2xx,
 * carrying the status and the parsed body, so a caller can tell "this workflow is GONE" (410
 * deprecated, possibly with a successor) from any other refusal without re-parsing a message.
 *
 * Its own module, with no imports: half the suites mock `workflows.js` wholesale, and a class read
 * through that mock would be undefined exactly on the error path that needs it.
 */
export class WorkflowExecutionRefusedError extends Error {
  readonly status: number;
  readonly workflowSlug: string;
  /** workflow-service's named successor, when it states one (`upgradedToWorkflowSlug`). */
  readonly upgradedToWorkflowSlug: string | null;

  constructor(args: { workflowSlug: string; campaignId: string; status: number; body: string }) {
    super(
      `[campaign-service] Execution of "${args.workflowSlug}" for campaign ${args.campaignId} was refused (${args.status}): ${args.body}`,
    );
    this.name = "WorkflowExecutionRefusedError";
    this.status = args.status;
    this.workflowSlug = args.workflowSlug;
    this.upgradedToWorkflowSlug = successorOf(args.body);
  }
}

function successorOf(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { upgradedToWorkflowSlug?: unknown };
    return typeof parsed.upgradedToWorkflowSlug === "string" && parsed.upgradedToWorkflowSlug.length > 0
      ? parsed.upgradedToWorkflowSlug
      : null;
  } catch {
    return null;
  }
}

/** 410 = workflow-service says the workflow is deprecated: it will never run again under that slug. */
export function isRetiredWorkflowRefusal(err: unknown): err is WorkflowExecutionRefusedError {
  return err instanceof WorkflowExecutionRefusedError && err.status === 410;
}
