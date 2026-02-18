import * as core from "@actions/core";
import * as github from "@actions/github";
import { RequestError } from "@octokit/request-error"
import { inspect } from 'util';
import {
    merge,
    fetch,
    push,
    execCmd,
    checkout,
    isAncestor,
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

const payload = github.context.payload;

export async function runPre():  Promise<boolean> {
    // Fail early on invalid configuration
    if (!payload.workflow_run) {
        core.setFailed("Cascade merge should only be done on workflow_run events. Refusing to merge unvalidated changes. Ensure workflow has on:workflow_run section.");
        return false;
    }
    parseGraph(core.getInput("dependency_graph")); // will throw on problems
    return true;
}

export async function runMain(): Promise<void> {
    if (!await runPre()) { // Can't use real pre step in action.yml, because it makes post-step execute after actions/checkout's. Checkout action does not have pre step.
        return;
    }
    const dependencies = parseGraph(core.getInput("dependency_graph"));
    await setupUser(core.getInput("user_name"), core.getInput("user_email"));

    // Input checks
    const workflow_run = payload.workflow_run;
    const headBranch = workflow_run.head_branch;
    const headSha = workflow_run.head_sha;

    const runConclusion = workflow_run.conclusion;
    if (runConclusion !== "success") {
        core.info(
            `Original workflow concluded with '${runConclusion}'. Skipping merges.`,
        );
        return;
    }

    if (!isValidBranchName(headBranch)) {
        core.notice(
            `Efemeral branch '${headBranch}' is subject to manual merge. Skipping.`
        );
        return;
    }

    const downstreams = dependencies.get(headBranch);
    if (!downstreams || downstreams.length === 0) {
        core.notice(
            `No downstream dependencies are defined for branch '${headBranch}'.`,
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

    for (const downstream of downstreams) {
        const tempBranch = mergeBranchName(headBranch, downstream);
        core.startGroup(`Preparing merge: ${tempBranch}`);

        try {
            // Fetch potentially existing temp branch
            if (await fetch([tempBranch])) {
                await checkout(tempBranch);
                // Reset to match remote exactly to avoid local divergence
                await execCmd(["reset", "--hard", `origin/${tempBranch}`]);
                // Merge the latest Downstream
                // This ensures we are up to date with target before pushing
                // Prevents accumulation of conlicts in the temporary branch by failing early
                await mergeWithDefaultComment(`origin/${downstream}`);
            } else {
                // If new, start from downstream
                await execCmd(["checkout", "-b", tempBranch, `origin/${downstream}`]);
            }

            // Check if already merged so that PR creation does not fail on empty merge
            if (await isAncestor(headSha, 'HEAD')) {
                core.info(`${headSha} is already merged into ${tempBranch} or ${downstream}.`);
                continue;
            }

            // Merge the upstream state verified by original workflow
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

    core.setOutput('target_branches_list', downstreams.join('\n'));
    core.setOutput('merge_branches_list', successfulTasks.map(t => t.tempBranch) );
  
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
                const pr = existingPrs[0];
                core.info(`PR already exists: [${pr.title}](${pr.html_url})`);
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
            try {
                const created = await octokit.rest.pulls.create({
                    ...repo,
                    title,
                    body,
                    head: task.tempBranch,
                    base: task.downstream
                });
                core.info(`✅ Created [${title}](${created.data.html_url})`);
            } catch (e) {
                if (e instanceof RequestError && e.status == 403) {
                    core.warning(`Not enough permissions to create a pull request. Add 'pull_request: write' permission to your token or job.`);
                } else {
                    throw e;
                }
            }
        } finally {
            core.endGroup();
        }
    }
}

function mergeBranchName(upstream: string, downstream: string): string {
    return `merge/${upstream}/${downstream}`;
}

const invalidPrefix = 'merge/';

function isValidBranchName(branch: string): boolean {
    return !branch.startsWith(invalidPrefix);
}

function checkBranchName(branch: string) {
    if (!isValidBranchName(branch)) {
        throw new Error(`Invalid branch name '${branch}'. Graph branches cannot start with '${invalidPrefix}'.`);
    }
}

function parseGraph(input: string): Map<string, string[]> {
    const map = new Map<string, string[]>();
    const lines = input.split(/[\r\n]+/);

    for (const line of lines) {
        const content = line.split('#')[0].trim();
        if (!content) continue;
        const [key, values] = content.split(":");
        
        if (key && values) {
            const sources = values.trim().split(/\s+/);
            const existing = map.get(key.trim());
            if (existing) {
                existing.push(...sources);
            } else {
                map.set(key.trim(), sources);
            }
        }
    }

    for (const [upstream, downstreams] of map) {
        checkBranchName(upstream);
        downstreams.forEach(checkBranchName);
    }
    
    return map;
}
