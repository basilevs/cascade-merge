import * as core from '@actions/core'
import type { GithubContext } from './logic.js'
import * as github from '@actions/github'
import { RequestError } from '@octokit/request-error'

const token = core.getInput('token')
const octokit = github.getOctokit(token)
const repo = github.context.repo
const payload = github.context.payload

const repoUrl = new URL(
  `${github.context.serverUrl}/${repo.owner}/${repo.repo}`
)
const currentRunUrl = new URL(`${repoUrl}/actions/runs/${github.context.runId}`)
const workflow_run = payload.workflow_run
// The payload contains the 'workflow_run' object because this action triggered on 'workflow_run'
if (!workflow_run) {
  throw new Error(
    'Cascade merge should only be done on workflow_run events. Refusing to merge unvalidated changes. Ensure workflow has on:workflow_run section.'
  )
}
const conclusion = payload.workflow_run.conclusion

const triggerWorkflowRun: URL = new URL(workflow_run.html_url)
let result: GithubContext | undefined = undefined
if (conclusion !== 'success') {
  core.info(
    `Original workflow ${triggerWorkflowRun} concluded with '${conclusion}'. Skipping merges.`
  )
} else {
  result = {
    triggerWorkflowRun: triggerWorkflowRun,
    currentWorkflowRun: currentRunUrl,
    triggerBranch: payload.workflow_run.head_branch,
    triggerSha: payload.workflow_run.head_sha,
    createPullRequest: async function (
      title: string,
      body: string,
      upstream: string,
      downstream: string
    ) {
      const { data: existingPrs } = await octokit.rest.pulls.list({
        ...repo,
        head: `${repo.owner}:${upstream}`,
        base: downstream,
        state: 'open'
      })
      if (existingPrs.length !== 0) {
        core.info(
          `PR already exists: [${existingPrs[0].title}](${existingPrs[0].html_url})`
        )
        return
      }
      try {
        const created = await octokit.rest.pulls.create({
          ...repo,
          title,
          body,
          head: upstream,
          base: downstream
        })
        core.info(`✅ Created [${title}](${created.data.html_url})`)
      } catch (e) {
        if (e instanceof RequestError && e.status == 403) {
          core.warning(
            `Not enough permissions to create a pull request. Add 'pull_request: write' permission to your token or job.`
          )
        } else {
          throw e
        }
      }
    }
  }
}

export const githubContext: GithubContext | undefined = result
