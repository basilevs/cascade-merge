import * as core from "@actions/core";
import * as github from "@actions/github";
import {
    merge,
    fetch,
    push,
    execCmd,
    checkout,
    setupUser,
    mergeWithDefaultComment,
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
    // Configuration checks
    const dependencies = parseGraph(core.getInput("dependency_graph"));
    await setupUser(core.getInput("user_name"), core.getInput("user_email"));

    // Input checks
    const payload = github.context.payload;
    const workflow_run = payload.workflow_run;
    if (!workflow_run) {
        core.setFailed("This action can only run on workflow_run events. Refusing to merge unvalidated changes.");
        return;
    }
    const runConclusion = workflow_run.conclusion;
    const headBranch = workflow_run.head_branch;
    const headSha = workflow_run.head_sha;
    if (runConclusion !== "success") {
        core.info(
            `Original workflow concluded with '${runConclusion}'. Skipping merges.`,
        );
        return;
    }

    const downstreams = dependencies.get(headBranch);
    if (!downstreams || downstreams.length === 0) {
        core.info(
            `No downstream dependencies defined for branch '${headBranch}'.`,
        );
        return;
    }

    core.info(
        `Processing cascade for ${headBranch} -> [${downstreams.join(", ")}]`,
    );

    const toFetch = [headBranch, ...downstreams];
    if (! await fetch(toFetch) ) {
        core.setFailed("Some of configured branches are missing: " + toFetch.join(', '));
        return;
    }

    const successfulTasks: MergeTask[] = [];

    // 4. Process Downstreams
    for (const downstream of downstreams) {
        const tempBranch = `merge/${headBranch}/${downstream}`;
        core.startGroup(`Preparing merge: ${tempBranch}`);

        try {
            // Fetch potentially existing temp branch
            if (await fetch([tempBranch])) {
                await checkout(tempBranch);
                // Reset to match remote exactly to avoid local divergence
                await execCmd(["reset", "--hard", `origin/${tempBranch}`]);
            } else {
                // If new, start from downstream
                await execCmd(["checkout", "-b", tempBranch, `origin/${downstream}`]);
            }

            // Merge the latest Downstream (Syncing)
            // This ensures we are up to date with target before pushing
            await mergeWithDefaultComment(`origin/${downstream}`);

            // Merge the specific Upstream SHA (The build artifact)
            // We assume strict merge requirements (fail on conflict)
            await merge(headSha, `Merge branch ${headBranch} into ${downstream}`);

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
            // Any failure of automatic merge should result in action failure
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
    const payload = github.context.payload;

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

            if (existingPrs.length !== 0) {
                core.info(`PR already exists for ${task.downstream}`);
                continue;
            }
            // Get the URL of the "Original Workflow" (the one that triggered this cascade)
            // The payload contains the 'workflow_run' object because this action triggered on 'workflow_run'
            const originalWorkflowUrl = payload.workflow_run?.html_url;

            // Construct the URL for the "Current Cascade Workflow"
            const repoUrl = `${github.context.serverUrl}/${repo.owner}/${repo.repo}`;
            const currentRunUrl = `${repoUrl}/actions/runs/${github.context.runId}`;

            const title = `Merge ${task.upstream} to ${task.downstream}`;

            const body = `
[Original Workflow](${originalWorkflowUrl})
[Cascade Merge Workflow](${currentRunUrl})

_Generated automatically by the [Cascade Merge Action](https://github.com/basilevs/cascade-merge)._
            `.trim();

            // Create the PR
            const created = await octokit.rest.pulls.create({
                ...repo,
                title,
                body,
                head: task.tempBranch,
                base: task.downstream
            });
            core.info(`✅ Created [Pull Request ${created.data.id}](${created.url}) for ${task.downstream}`);

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
