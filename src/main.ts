import { getState, saveState, setFailed } from '@actions/core';
import { runMain, runPost } from './logic.js';

const STATE_KEY_IS_POST = 'IS_POST_PROCESS';

async function run(): Promise<void> {
  try {
    const isPost = getState(STATE_KEY_IS_POST);
    
    // Determine if we are in the 'main' phase or 'post' phase
    if (!isPost) {
        saveState(STATE_KEY_IS_POST, 'true');
      await runMain();
    } else {
      await runPost();
    }
  } catch (error) {
    if (error instanceof Error) setFailed(error.message);
  }
}

run();