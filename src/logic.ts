import * as core from "@actions/core";
import * as github from "@actions/github";
import {
  merge,
  fetch,
  push,
  execCmd,
  checkout,
  setupUser,
  branchExistsRemote,
} from "./git.js";

interface MergeTask {
  upstream: string;
  downstream: string;
  tempBranch: string;
  originalSha: string;
}

// Key to store successful merges to be processed in Post
const STATE_MERGE_TASKS = "MERGE_TASKS_JSON";

export async function runMain(): Promise<void> {
  const graphRaw = core.getInput("dependency_graph");

  // 1. Validate Workflow Trigger
  if (github.context.eventName !== "workflow_run") {
    core.info("This action only runs on workflow_run events. Skipping.");
    return;
  }

  const payload = github.context.payload;
  const runConclusion = payload.workflow_run?.conclusion;
  const headBranch = payload.workflow_run?.head_branch;
  const headSha = payload.workflow_run?.head_sha;

  if (runConclusion !== "success") {
    core.info(
      `Original workflow concluded with '${runConclusion}'. Skipping cascade.`,
    );
    return;
  }

  // 2. Parse Dependency Graph
  const dependencies = parseGraph(graphRaw);
  const downstreams = dependencies.get(headBranch);

  if (!downstreams || downstreams.length === 0) {
    core.info(
      `No downstream dependencies defined for branch '${headBranch}'. Skipping.`,
    );
    return;
  }

  core.info(
    `Processing cascade for ${headBranch} -> [${downstreams.join(", ")}]`,
  );

  // 3. Setup Git
  await setupUser(core.getInput("user_name"), core.getInput("user_email"));

  // Fetch upstream specifically
  await fetch(headBranch);

  const successfulTasks: MergeTask[] = [];

  // 4. Process Downstreams
  for (const downstream of downstreams) {
    const tempBranch = `merge/${headBranch}/${downstream}`;
    core.startGroup(`Preparing merge: ${tempBranch}`);

    try {
      // Fetch downstream and potential existing temp branch
      await fetch(downstream);
      await fetch(tempBranch).catch(() => {}); // Ignore fail if temp doesn't exist

      // Checkout Logic
      const tempExists = await branchExistsRemote(tempBranch);

      if (tempExists) {
        await checkout(tempBranch);
        // Reset to match remote exactly to avoid local divergence
        await execCmd(["reset", "--hard", `origin/${tempBranch}`]);
      } else {
        // If new, start from downstream
        await execCmd(["checkout", "-b", tempBranch, `origin/${downstream}`]);
      }

      // Merge 1: Merge the specific Upstream SHA (The build artifact)
      // We assume strict merge requirements (fail on conflict)
      await merge(
        headSha,
        `Merge upstream commit ${headSha} into ${tempBranch}`,
      );

      // Merge 2: Merge the latest Downstream (Syncing)
      // This ensures we are up to date with target before pushing
      await merge(`origin/${downstream}`, `Sync with ${downstream}`);

      successfulTasks.push({
        upstream: headBranch,
        downstream: downstream,
        tempBranch: tempBranch,
        originalSha: headSha,
      });

      core.info(`✅ Successfully prepared ${tempBranch}`);
    } catch (e) {
      core.error(
        `Failed to merge for ${downstream}: ${e instanceof Error ? e.message : "" + e}`,
      );
      // Per requirements: "Any failure of automatic merge should result in action failure"
      throw e;
    } finally {
      core.endGroup();
    }
  }

  // Save state for Post step
  core.saveState(STATE_MERGE_TASKS, JSON.stringify(successfulTasks));
}

export async function runPost(): Promise<void> {
  const tasksJson = core.getState(STATE_MERGE_TASKS);
  if (!tasksJson) return; // Nothing to do

  const tasks: MergeTask[] = JSON.parse(tasksJson);
  const token = core.getInput("token");
  const octokit = github.getOctokit(token);
  const repo = github.context.repo;

  for (const task of tasks) {
    core.startGroup(`Finalizing: ${task.tempBranch}`);
    try {
      // 1. Push the temp branch
      // Note: If intermediate steps modified files, those changes must be committed
      // by the user script BEFORE this action's post step runs, or simply left staged?
      // Requirement says "filter out unwanted changes".
      // We assume user committed them or we push current state.
      // Standard git push behavior pushes committed changes.

      // We must ensure we push the specific temp branch, but we might not be checked out on it
      // if there were multiple tasks.
      // FORCE CHECKOUT to ensure we push the right context if files were changed.
      await checkout(task.tempBranch);

      let prefix = github.context.serverUrl.replace("https://", "https://" + token + "@");
      await execCmd(["remote", "set-url", "origin", prefix + "/" + github.context.repo.owner + "/" + github.context.repo.repo + "/"]);
      // Push
      await push(task.tempBranch);

      // 2. Create Pull Request
      // Check if PR exists first to avoid duplicates
      const { data: existingPrs } = await octokit.rest.pulls.list({
        ...repo,
        head: `${repo.owner}:${task.tempBranch}`,
        base: task.downstream,
        state: "open",
      });

      if (existingPrs.length === 0) {
        const title = `Cascade Merge: ${task.upstream} to ${task.downstream}`;
        const body = `Automated cascade merge triggered by workflow run on ${task.upstream}.\n\nSource Commit: ${task.originalSha}`;

        await octokit.rest.pulls.create({
          ...repo,
          title,
          body,
          head: task.tempBranch,
          base: task.downstream,
        });
        core.info(`✅ PR Created for ${task.downstream}`);
      } else {
        core.info(`PR already exists for ${task.downstream}`);
      }
    } catch (e) {
      core.setFailed(
        `Failed post-action for ${task.tempBranch}: ${e instanceof Error ? e.message : "" + e}`,
      );
      throw e;
    } finally {
      core.endGroup();
    }
  }
}

function parseGraph(input: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  const lines = input.split(/[\r\n]+/);

  for (const line of lines) {
    if (!line.trim() || line.startsWith("#")) continue;
    const [key, values] = line.split(":");
    if (key && values) {
      const sources = values.trim().split(/\s+/);
      map.set(key.trim(), sources);
    }
  }
  return map;
}
