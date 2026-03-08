/**
 * Unit tests for the action's main functionality, src/main.ts
 *
 * To mock dependencies in ESM, you can create fixtures that export mock
 * functions and objects. For example, the core module is mocked in this test,
 * so that the actual '@actions/core' module is not imported.
 */
import { jest } from '@jest/globals'
import * as exec from '@actions/exec'
import * as io from '@actions/io'
import * as path from 'path'
import * as os from 'os'
import * as fs from 'fs'

import * as core from '../__fixtures__/core.js'
// import { wait } from '../__fixtures__/wait.js'

// Mocks should be declared before the module being tested is imported.
jest.unstable_mockModule('@actions/core', () => core)
// jest.unstable_mockModule('../src/wait.js', () => ({ wait }))

// The module being tested should be imported dynamically. This ensures that the
// mocks are used in place of any actual dependencies.
const { runMain, runPost } = await import('../src/logic.js')

async function gitRepositoryHasBranch(
  repositoryDir: string,
  branch: string
): Promise<boolean> {
  return (
    (await exec.exec(
      'git',
      ['-C', repositoryDir, '--bare', 'rev-parse', '--verify', branch],
      {
        ignoreReturnCode: true
      }
    )) == 0
  )
}

describe('Cascade Merge Action', () => {
  beforeEach(async () => {
    jest.clearAllMocks()

    // 1. Setup Core Mocks
    getInputMock = jest.spyOn(core, 'getInput').mockImplementation()
    setFailedMock = jest.spyOn(core, 'setFailed').mockImplementation()
    setOutputMock = jest.spyOn(core, 'setOutput').mockImplementation()
    saveStateMock = jest.spyOn(core, 'saveState').mockImplementation()
    getStateMock = jest.spyOn(core, 'getState').mockImplementation()
    infoMock = jest.spyOn(core, 'info').mockImplementation()
    noticeMock = jest.spyOn(core, 'notice').mockImplementation()
    jest.spyOn(core, 'startGroup').mockImplementation()
    jest.spyOn(core, 'endGroup').mockImplementation()

    // 2. Setup Real Git File System
    originalCwd = process.cwd()
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-test-'))
    originDir = path.join(tmpDir, 'origin.git')
    workDir = path.join(tmpDir, 'workspace')

    // Init bare repository to act as 'origin'
    await exec.exec('git', ['init', '--bare', originDir])

    // Clone it to our workspace
    await exec.exec('git', ['clone', originDir, workDir])
    process.chdir(workDir)

    // Initial commit (required to branch)
    await exec.exec('git', ['config', 'user.name', 'Tester'])
    await exec.exec('git', ['config', 'user.email', 'test@example.com'])
    fs.writeFileSync('base.txt', 'initial content')
    await exec.exec('git', ['add', 'base.txt'])
    await exec.exec('git', ['commit', '-m', 'Initial commit'])
    await exec.exec('git', ['push', 'origin', 'main'])

    // Setup Downstream Branch (release/1.1)
    await exec.exec('git', ['checkout', '-b', 'release/1.1'])
    await exec.exec('git', ['push', 'origin', 'release/1.1'])

    // Setup Upstream Branch (release/1.0) with a new commit
    await exec.exec('git', ['checkout', '-b', 'release/1.0', 'main'])
    fs.writeFileSync('upstream.txt', 'upstream change')
    await exec.exec('git', ['add', 'upstream.txt'])
    await exec.exec('git', ['commit', '-m', 'Upstream feature'])
    await exec.exec('git', ['push', 'origin', 'release/1.0'])

    // Get the SHA of the new upstream commit to use in our trigger context
    let shaOutput = ''
    await exec.exec('git', ['rev-parse', 'release/1.0'], {
      listeners: {
        stdout: (data: Buffer) => {
          shaOutput += data.toString()
        }
      }
    })
    triggerSha = shaOutput.trim()

    // 3. Setup Dummy Context
    dummyContext = {
      triggerWorkflowRun: new URL(
        'https://github.com/test/repo/actions/runs/1'
      ),
      currentWorkflowRun: new URL(
        'https://github.com/test/repo/actions/runs/2'
      ),
      triggerBranch: 'release/1.0',
      triggerSha: triggerSha,
      createPullRequest: jest.fn().mockResolvedValue(undefined)
    }
  })

  afterEach(async () => {
    // Restore directory and cleanup
    process.chdir(originalCwd)
    await io.rmRF(tmpDir)
    jest.restoreAllMocks()
  })

  it('fails if graph contains invalid branches', async () => {
    getInputMock.mockImplementation((name: string) => {
      // 'merge/' is an invalid prefix based on isValidBranchName
      if (name === 'dependency_graph') return 'merge/release: release/1.1'
      return ''
    })

    await expect(runMain()).rejects.toThrow(/Invalid branch name/)
  })

  it('successfully merges upstream to downstream via temp branch', async () => {
    // Setup inputs
    getInputMock.mockImplementation((name: string) => {
      if (name === 'dependency_graph') return 'release/1.0: release/1.1'
      if (name === 'user_name') return 'Test Bot'
      if (name === 'user_email') return 'bot@example.com'
      return ''
    })

    // Run the action main phase
    await runMain(dummyContext)

    // Assert that no errors were thrown via core.setFailed
    expect(setFailedMock).not.toHaveBeenCalled()

    // Verify git actually created and merged the branch locally
    await exec.exec(
      'git',
      ['rev-parse', '--verify', 'merge/release/1.0/release/1.1'],
      {
        ignoreReturnCode: false
      }
    )

    // Verify the temporary branch contains the file we added in the upstream commit
    await exec.exec('git', ['checkout', 'merge/release/1.0/release/1.1'])
    expect(fs.existsSync('upstream.txt')).toBe(true)

    // Verify outputs were set for downstream steps
    expect(setOutputMock).toHaveBeenCalledWith(
      'target_branches_list',
      'release/1.1'
    )
    expect(setOutputMock).toHaveBeenCalledWith('merge_branches_list', [
      'merge/release/1.0/release/1.1'
    ])

    await expect(
      gitRepositoryHasBranch(originDir, 'merge/release/1.0/release/1.1')
    ).resolves.toBe(false)
    expect(saveStateMock.mock.calls).toHaveLength(1)
    const state = saveStateMock.mock.calls[0][1]
    // Verify state was saved for the post phase
    expect(saveStateMock).toHaveBeenCalledWith(
      'MERGE_TASKS_JSON',
      expect.stringContaining('merge/release/1.0/release/1.1')
    )

    getStateMock.mockImplementation((name: string) => {
      if (name === 'MERGE_TASKS_JSON') return state
      return ''
    })
    await runPost(dummyContext)

    await expect(
      gitRepositoryHasBranch(originDir, 'merge/release/1.0/release/1.1')
    ).resolves.toBe(true)
  })

  it('skips processing if branch has no downstreams', async () => {
    // Setup dependency graph that DOES NOT include release/1.0
    getInputMock.mockImplementation((name: string) => {
      if (name === 'dependency_graph') return 'release/2.0: release/3.0'
      return ''
    })

    await runMain(dummyContext)

    // Expect a notice and immediate return
    expect(noticeMock).toHaveBeenCalledWith(
      expect.stringContaining(
        "No downstream dependencies are defined for branch 'release/1.0'"
      )
    )
    expect(saveStateMock).not.toHaveBeenCalled()
  })
})
