import * as exec from '@actions/exec'

export async function setupUser(name: string, email: string) {
  await exec.exec('git', ['config', 'user.name', name])
  await exec.exec('git', ['config', 'user.email', email])
}

export async function fetch(branches: string[]): Promise<boolean> {
  // Fetch with enough depth to allow merging.
  // Using unshallow if needed is safer but slower.
  // Here we assume standard fetch of specific branch.

  return (
    0 ===
    (await exec.exec(
      'git',
      [
        'fetch',
        '--depth=2147483647',
        '--no-tags',
        'origin',
        ...branches.map((branch) => `+${branch}:refs/remotes/origin/${branch}`)
      ],
      { ignoreReturnCode: true }
    ))
  )
}

/** Fetch and merge or create  a branch  */
export async function createBranch(
  name: string,
  upstream: string
): Promise<undefined> {
  // Fetch potentially existing temp branch
  if (await fetch([name])) {
    await checkout(name)
    // Reset to match remote exactly to avoid local divergence
    await execCmd(['reset', '--hard', `origin/${name}`])
    // Merge the latest Downstream
    // This ensures we are up to date with target before pushing
    // Prevents accumulation of conlicts in the temporary branch by failing early
    await mergeWithDefaultComment(`origin/${upstream}`)
  } else {
    // If new, start from downstream
    await execCmd(['checkout', '-b', name, `origin/${upstream}`])
  }
}

export async function isAncestor(
  upstream: string,
  downstream: string
): Promise<boolean> {
  const exitCode = await exec.exec(
    'git',
    ['merge-base', '--is-ancestor', upstream, downstream],
    { ignoreReturnCode: true }
  )
  return exitCode === 0
}

export async function checkout(branch: string) {
  return await execCmd(['checkout', branch])
}

async function execCmd(args: string[]) {
  await exec.exec('git', args)
}

async function mergeWithDefaultComment(ref: string) {
  try {
    return await execCmd(['merge', '--no-edit', ref])
  } catch (e) {
    throw new Error(`Conflict merging ${ref}`, { cause: e })
  }
}

export async function merge(ref: string, message: string) {
  try {
    return await execCmd(['merge', '--no-edit', '-m', message, ref])
  } catch (e) {
    throw new Error(`Conflict merging ${ref}`, { cause: e })
  }
}

export async function push(branch: string) {
  return await execCmd(['push', 'origin', branch])
}
