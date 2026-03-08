import * as core from '@actions/core'
// import * as github from "@actions/github";
import {
  merge,
  fetch,
  push,
  checkout,
  isAncestor,
  setupUser,
  createBranch
} from './git.js'

interface MergeTask {
  upstream: string
  downstream: string
  tempBranch: string
  originalSha: string
}

export interface GithubContext {
  createPullRequest(
    title: string,
    body: string,
    tempBranch: string,
    downstream: string
  ): Promise<undefined>
  /**  URL of the "Trigger Workflow Run" (the one that triggered this cascade) */
  triggerWorkflowRun: URL
  triggerBranch: string
  triggerSha: string
  /** URL for the "Current Cascade Workflow" */
  currentWorkflowRun: URL
}

// Key to store successful merges to be processed in Post
const STATE_MERGE_TASKS = 'MERGE_TASKS_JSON'

export async function runPre(): Promise<boolean> {
  parseGraph(core.getInput('dependency_graph')) // will throw on problems
  return true
}

export async function runMain(context: GithubContext): Promise<void> {
  if (!(await runPre())) {
    // Can't use real pre step in action.yml, because it makes post-step execute after actions/checkout's.
    // Checkout action does not have pre step.
    // This action has to run its push operation before action/checkout deactivates the local repository.
    return
  }
  const dependencies = parseGraph(core.getInput('dependency_graph'))
  await setupUser(core.getInput('user_name'), core.getInput('user_email'))
  const upstream = context.triggerBranch
  const headSha = context.triggerSha
  if (!isValidBranchName(upstream)) {
    core.notice(
      `Efemeral branch '${upstream}' is subject to manual merge. Skipping.`
    )
    return
  }

  const downstreams = dependencies.get(upstream)
  if (!downstreams || downstreams.length === 0) {
    core.notice(
      `No downstream dependencies are defined for branch '${upstream}'.`
    )
    return
  }

  core.info(`Processing cascade for ${upstream} -> [${downstreams.join(', ')}]`)

  const toFetch = [upstream, ...downstreams]
  if (!(await fetch(toFetch))) {
    core.setFailed(
      'Some of configured branches are missing: ' + toFetch.join(', ')
    )
    return
  }

  const successfulTasks: MergeTask[] = []

  for (const downstream of downstreams) {
    const tempBranch = mergeBranchName(upstream, downstream)
    core.startGroup(`Merge ${upstream} to ${downstream} via ${tempBranch}`)
    try {
      await createBranch(tempBranch, downstream)

      // Check if already merged so that PR creation does not fail on empty merge
      if (await isAncestor(headSha, 'HEAD')) {
        core.info(
          `${headSha} is already merged into ${tempBranch} or ${downstream}.`
        )
        continue
      }

      // Merge the upstream state verified by original workflow
      await merge(headSha, `Merge branch ${upstream} into ${downstream}`)

      successfulTasks.push({
        upstream: upstream,
        downstream: downstream,
        tempBranch: tempBranch,
        originalSha: headSha
      })

      core.info(`✅ Successfully prepared ${tempBranch}`)
    } catch (e) {
      core.error(
        `Failed to merge for ${downstream}: ${e instanceof Error ? e.message : '' + e}`
      )
      // Any failure of automatic merge should result in action failure
      throw e
    } finally {
      core.endGroup()
    }
  }

  core.setOutput('target_branches_list', downstreams.join('\n'))
  core.setOutput(
    'merge_branches_list',
    successfulTasks.map((t) => t.tempBranch)
  )

  // Save state for Post step
  core.saveState(STATE_MERGE_TASKS, JSON.stringify(successfulTasks))
}

export async function runPost(context: GithubContext): Promise<void> {
  const tasksJson = core.getState(STATE_MERGE_TASKS)
  if (!tasksJson) return // Nothing to do

  const tasks: MergeTask[] = JSON.parse(tasksJson)

  for (const task of tasks) {
    core.startGroup(
      `Push ${task.upstream} to ${task.downstream} via ${task.tempBranch}`
    )

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
      await checkout(task.tempBranch)

      // Push
      await push(task.tempBranch)

      const title = `Merge ${task.upstream} to ${task.downstream}`

      const body = `
[Original Workflow](${context.triggerWorkflowRun})
[Cascade Merge Workflow](${context.currentWorkflowRun})

_Generated automatically by the [Cascade Merge Action](https://github.com/basilevs/cascade-merge)._
            `.trim()

      await context.createPullRequest(
        title,
        body,
        task.tempBranch,
        task.downstream
      )
    } finally {
      core.endGroup()
    }
  }
}

function mergeBranchName(upstream: string, downstream: string): string {
  return `merge/${upstream}/${downstream}`
}

const invalidPrefix = 'merge/'

function isValidBranchName(branch: string): boolean {
  return !branch.startsWith(invalidPrefix)
}

function checkBranchName(branch: string) {
  if (!isValidBranchName(branch)) {
    throw new Error(
      `Invalid branch name '${branch}'. Graph branches cannot start with '${invalidPrefix}'.`
    )
  }
}

function parseGraph(input: string): Map<string, string[]> {
  const map = new Map<string, string[]>()
  const lines = input.split(/[\r\n]+/)

  for (const line of lines) {
    const content = line.split('#')[0].trim()
    if (!content) continue
    const [key, values] = content.split(':')

    if (key && values) {
      const sources = values.trim().split(/\s+/)
      const existing = map.get(key.trim())
      if (existing) {
        existing.push(...sources)
      } else {
        map.set(key.trim(), sources)
      }
    }
  }

  for (const [upstream, downstreams] of map) {
    checkBranchName(upstream)
    downstreams.forEach(checkBranchName)
  }

  return map
}
