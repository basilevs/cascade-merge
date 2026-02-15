import * as exec from '@actions/exec';

export async function setupUser(name: string, email: string) {
  await exec.exec('git', ['config', 'user.name', name]);
  await exec.exec('git', ['config', 'user.email', email]);
}

export async function fetch(branch: string) {
  // Fetch with enough depth to allow merging. 
  // Using unshallow if needed is safer but slower. 
  // Here we assume standard fetch of specific branch.
  await exec.exec('git', ['fetch', 'origin', branch]);
}

export async function branchExistsRemote(branch: string): Promise<boolean> {
  const exitCode = await exec.exec('git', ['ls-remote', '--exit-code', '--heads', 'origin', branch], { ignoreReturnCode: true });
  return exitCode === 0;
}

export async function checkout(branch: string) {
  await exec.exec('git', ['checkout', branch]);
}

export async function execCmd(args: string[]) {
  await exec.exec('git', args);
}

export async function merge(ref: string, message: string) {
  try {
    await exec.exec('git', ['merge', '--no-edit', '-m', message, ref]);
  } catch (e) {
    throw new Error(`Conflict merging ${ref}`);
  }
}

export async function push(branch: string) {
  await exec.exec('git', ['push', 'origin', branch]);
}