import * as core from '@actions/core';
import { runMain } from './logic';
import { runPost } from './logic';

const STATE_KEY_IS_POST = 'IS_POST_PROCESS';

async function run(): Promise<void> {
  try {
    const isPost = core.getState(STATE_KEY_IS_POST);
    
    // Determine if we are in the 'main' phase or 'post' phase
    if (!isPost) {
      core.saveState(STATE_KEY_IS_POST, 'true');
      await runMain();
    } else {
      await runPost();
    }
  } catch (error) {
    if (error instanceof Error) core.setFailed(error.message);
  }
}

run();