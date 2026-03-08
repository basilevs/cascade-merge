import { runPost } from './logic.js'
import { githubContext } from './github.js'

if (githubContext) {
  await runPost(githubContext)
}
