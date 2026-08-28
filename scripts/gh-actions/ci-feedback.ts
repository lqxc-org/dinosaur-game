import { Octokit } from "@octokit/rest";

/**
 * CI Feedback Bot - Collects failures from CI workflow runs and posts feedback to PRs
 */

interface JobSummary {
  name: string;
  url: string;
  logs: string;
}

interface PostJobFeedbackOptions {
  token: string;
  owner: string;
  repo: string;
  prNumber: number;
  jobName: string;
  runId: number;
  headSha: string;
  workflowRunUrl: string;
  prAuthor?: string;
  prIsDraft?: boolean;
}

/**
 * Strip ANSI escape codes from text
 * These codes are used for terminal coloring but appear as garbled characters in PR comments
 * @param text - The text containing potential ANSI escape codes
 * @returns Clean text with all ANSI escape codes removed
 */
export function stripAnsiCodes(text: string): string {
  // Matches ANSI escape sequences: ESC[ followed by any number of parameters and a final byte
  // This covers color codes, cursor movement, and other terminal control sequences
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

/**
 * Extract relevant error lines from job logs
 *
 * Prioritizes errors from the end of the log, as those are typically
 * the actual failure causes. The function:
 * 1. Scans the log from the end to find error blocks
 * 2. Includes context lines around each error
 * 3. Returns the most relevant errors (those closest to the end of the log)
 */
export function extractErrorLines(logs: string): string {
  // Strip ANSI escape codes first to get clean log lines
  const cleanLogs = stripAnsiCodes(logs);
  const logLines = cleanLogs.split("\n");

  // Patterns for error detection - includes common build/test failure indicators
  // More specific patterns are checked first (higher priority)
  const errorPatterns = [
    // Rust-specific errors (high priority)
    /error\[E\d+\]/i, // Rust compiler errors like error[E0433]
    /panicked at/i, // Rust panic messages
    /thread .+ panicked/i, // Thread panic
    // General errors (medium priority)
    /^error:/i, // Lines starting with "error:"
    /^error\s/i, // Lines starting with "error "
    /:\s*error:/i, // "file.rs: error:" style
    /FAILED/i, // Test failures
    /FAILURE/i, // General failures
    // Lower priority patterns
    /error/i,
    /failed/i,
    /exception/i,
    /panic/i,
  ];

  // Find all error line indices, prioritizing from the end
  const errorIndices: number[] = [];
  for (let i = logLines.length - 1; i >= 0; i--) {
    const line = logLines[i]!;
    if (errorPatterns.some((pattern) => pattern.test(line))) {
      errorIndices.push(i);
    }
  }

  // If no errors found, return last 30 lines
  if (errorIndices.length === 0) {
    return logLines.slice(-30).join("\n");
  }

  // Build error blocks with context, prioritizing errors from the end
  // Use a Set to track included line indices to preserve order and avoid duplicates
  const includedIndices = new Set<number>();
  const targetLineCount = 50;

  // Process errors from end to beginning (errorIndices is already reverse order)
  for (const errorIdx of errorIndices) {
    if (includedIndices.size >= targetLineCount) break;

    // Add context: 3 lines before and 3 lines after for better context
    const start = Math.max(0, errorIdx - 3);
    const end = Math.min(logLines.length, errorIdx + 4);

    for (let j = start; j < end; j++) {
      includedIndices.add(j);
    }
  }

  // Convert to sorted array and extract lines (preserves original order)
  const sortedIndices = Array.from(includedIndices).sort((a, b) => a - b);
  const resultLines = sortedIndices.map((i) => logLines[i]);

  // Limit to 50 lines to avoid huge comments
  return resultLines.slice(0, 50).join("\n");
}

/**
 * Convert various response data types to string
 * GitHub API can return string, ArrayBuffer, or Buffer depending on context
 */
function responseDataToString(data: unknown): string {
  if (typeof data === "string") {
    return data;
  } else if (data instanceof ArrayBuffer) {
    return new TextDecoder().decode(data);
  } else if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  } else {
    return String(data);
  }
}

/**
 * Count previous failures per job from existing comments
 */
export function countPreviousFailures(
  comments: Array<{ body?: string | null; user?: { type?: string } | null }>,
): Record<string, number> {
  const jobFailureCounts: Record<string, number> = {};

  // Find CI feedback comments from this workflow
  // Note: We only check for the marker, not user.type, because comments posted via
  // user PAT (like COPILOT_INVOKER_TOKEN) have type "User", not "Bot"
  const feedbackComments = comments.filter((comment) =>
    comment.body?.includes("<!-- CI-FEEDBACK-BOT -->"),
  );

  for (const comment of feedbackComments) {
    if (!comment.body) continue;

    // Parse job names from previous comments
    const jobMatches = comment.body.match(/### ❌ Job: `([^`]+)`/g);
    if (jobMatches) {
      for (const match of jobMatches) {
        const innerMatch = match.match(/### ❌ Job: `([^`]+)`/);
        if (innerMatch && innerMatch[1]) {
          const jobName = innerMatch[1];
          jobFailureCounts[jobName] = (jobFailureCounts[jobName] || 0) + 1;
        }
      }
    }
  }

  return jobFailureCounts;
}

/**
 * Build the comment body for CI failure report
 */
export function buildCommentBody(
  runId: number,
  workflowRunUrl: string,
  headSha: string,
  jobsToReport: JobSummary[],
  skippedJobs: JobSummary[],
  jobFailureCounts: Record<string, number>,
): string {
  let commentBody = `<!-- CI-FEEDBACK-BOT -->\n## 🚨 CI Failure Report\n\n`;
  commentBody += `**Workflow Run:** [#${runId}](${workflowRunUrl})\n`;
  commentBody += `**Commit:** \`${headSha.substring(0, 7)}\`\n\n`;
  commentBody += `The following CI jobs have failed:\n\n`;

  for (const summary of jobsToReport) {
    const failureCount = (jobFailureCounts[summary.name] || 0) + 1;
    commentBody += `### ❌ Job: \`${summary.name}\`\n\n`;
    commentBody += `**Attempt ${failureCount} of 3** | [View Full Logs](${summary.url})\n\n`;
    commentBody += `<details>\n<summary>Error Summary</summary>\n\n`;
    commentBody += `\`\`\`\n${summary.logs}\n\`\`\`\n\n`;
    commentBody += `</details>\n\n`;
  }

  if (skippedJobs.length > 0) {
    commentBody += `---\n\n`;
    commentBody += `⚠️ **Note:** The following jobs have failed 3+ times and will no longer trigger auto-feedback:\n`;
    commentBody += skippedJobs.map((j) => `- \`${j.name}\``).join("\n") + "\n\n";
  }

  commentBody += `---\n\n`;
  commentBody += `@copilot Please analyze these CI failures and suggest fixes based on the error logs above.\n`;

  return commentBody;
}

/**
 * Post-job feedback function - runs within the CI workflow itself
 * This approach has direct access to PR context, avoiding PR detection issues
 */
export async function runPostJobFeedback(options: PostJobFeedbackOptions): Promise<void> {
  const {
    token,
    owner,
    repo,
    prNumber,
    jobName,
    runId,
    headSha,
    workflowRunUrl,
    prAuthor,
    prIsDraft,
  } = options;

  // Check if we should post feedback based on PR author and draft status
  // Only post feedback for:
  // 1. PRs opened by copilot bot (login can be "Copilot", "copilot", or "copilot[bot]")
  // 2. Non-draft PRs
  const authorLower = prAuthor?.toLowerCase() ?? "";
  const isCopilotPR = authorLower === "copilot" || authorLower === "copilot[bot]";
  if (!isCopilotPR && prIsDraft) {
    console.log(
      `Skipping feedback for draft PR #${prNumber} (author: ${prAuthor}). Only non-draft PRs or Copilot PRs receive feedback.`,
    );
    return;
  }

  const octokit = new Octokit({ auth: token });

  console.log(`Processing feedback for job "${jobName}" on PR #${prNumber}`);

  // Get job logs for the specific failed job
  const { data: jobsData } = await octokit.rest.actions.listJobsForWorkflowRun({
    owner,
    repo,
    run_id: runId,
  });

  // Find the specific job by name
  const job = jobsData.jobs.find((j) => j.name === jobName);
  if (!job) {
    const availableJobs = jobsData.jobs.map((j) => j.name).join(", ");
    console.log(`Job "${jobName}" not found in workflow run. Available jobs: ${availableJobs}`);
    return;
  }

  // Get job logs
  let logs = "Unable to retrieve logs";
  try {
    const response = await octokit.rest.actions.downloadJobLogsForWorkflowRun({
      owner,
      repo,
      job_id: job.id,
    });

    logs = extractErrorLines(responseDataToString(response.data));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`Failed to get logs for job ${jobName}: ${message}`);
  }

  const summary: JobSummary = {
    name: jobName,
    url: job.html_url || "",
    logs,
  };

  // Check existing comments to count failures
  const { data: comments } = await octokit.rest.issues.listComments({
    owner,
    repo,
    issue_number: prNumber,
  });

  const jobFailureCounts = countPreviousFailures(comments);
  const failureCount = jobFailureCounts[jobName] || 0;

  // Skip if this job has already failed 3+ times
  if (failureCount >= 3) {
    console.log(`Job "${jobName}" has already failed ${failureCount} times. Skipping feedback.`);
    return;
  }

  // Build and post comment for this single job
  const commentBody = buildCommentBody(
    runId,
    workflowRunUrl,
    headSha,
    [summary],
    [],
    jobFailureCounts,
  );

  await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: prNumber,
    body: commentBody,
  });

  console.log(`Posted CI feedback comment for job "${jobName}" on PR #${prNumber}`);
}

/**
 * CLI entry point for post-job feedback (runs within CI workflow)
 */
export function runPostJobFeedbackCLI(): void {
  const token = process.env.GITHUB_TOKEN;
  const owner = process.env.GITHUB_REPOSITORY_OWNER;
  const githubRepository = process.env.GITHUB_REPOSITORY;
  const prNumberStr = process.env.PR_NUMBER;
  const jobName = process.env.JOB_NAME;
  const runIdStr = process.env.RUN_ID;
  const headSha = process.env.HEAD_SHA;
  const workflowRunUrl = process.env.WORKFLOW_RUN_URL;
  const prAuthor = process.env.PR_AUTHOR;
  const prIsDraftStr = process.env.PR_IS_DRAFT;

  if (!token) {
    console.error("GITHUB_TOKEN is required but was not provided or is empty.");
    console.error("");
    console.error(
      "This usually means the COPILOT_INVOKER_TOKEN secret is not set in your repository.",
    );
    console.error("To set it up:");
    console.error(
      "  1. Create a Personal Access Token (PAT) with 'pull-requests: write' permission",
    );
    console.error("  2. Go to your repo Settings → Secrets → Actions");
    console.error("  3. Add a new secret named 'COPILOT_INVOKER_TOKEN' with your PAT");
    console.error("");
    console.error("See the ci-feedback-post-job command help for detailed setup instructions.");
    process.exit(1);
  }
  if (!owner) {
    console.error("GITHUB_REPOSITORY_OWNER is required");
    process.exit(1);
  }
  if (!githubRepository || !githubRepository.includes("/")) {
    console.error("GITHUB_REPOSITORY is required and must be in format 'owner/repo'");
    process.exit(1);
  }
  const repo = githubRepository.split("/")[1];
  if (!repo) {
    console.error("GITHUB_REPOSITORY must contain a repository name");
    process.exit(1);
  }
  if (!prNumberStr) {
    console.log("PR_NUMBER not set - not a pull request event, skipping");
    process.exit(0);
  }
  const prNumber = parseInt(prNumberStr, 10);
  if (isNaN(prNumber)) {
    console.error("PR_NUMBER must be a valid number");
    process.exit(1);
  }
  if (!jobName) {
    console.error("JOB_NAME is required");
    process.exit(1);
  }
  if (!runIdStr) {
    console.error("RUN_ID is required");
    process.exit(1);
  }
  const runId = parseInt(runIdStr, 10);
  if (isNaN(runId)) {
    console.error("RUN_ID must be a valid number");
    process.exit(1);
  }
  if (!headSha) {
    console.error("HEAD_SHA is required");
    process.exit(1);
  }
  if (!workflowRunUrl) {
    console.error("WORKFLOW_RUN_URL is required");
    process.exit(1);
  }

  // Parse draft status (GitHub Actions passes "true" or "false" as strings)
  const prIsDraft = prIsDraftStr === "true";

  runPostJobFeedback({
    token,
    owner,
    repo,
    prNumber,
    jobName,
    runId,
    headSha,
    workflowRunUrl,
    prAuthor,
    prIsDraft,
  }).catch((error) => {
    console.error("Post-job CI Feedback failed:", error);
    process.exit(1);
  });
}
