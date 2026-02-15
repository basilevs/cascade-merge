"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.runMain = runMain;
exports.runPost = runPost;
const core = __importStar(require("@actions/core"));
const github = __importStar(require("@actions/github"));
const git = __importStar(require("./git"));
// Key to store successful merges to be processed in Post
const STATE_MERGE_TASKS = 'MERGE_TASKS_JSON';
function runMain() {
    return __awaiter(this, void 0, void 0, function* () {
        var _a, _b, _c;
        const token = core.getInput('token');
        const graphRaw = core.getInput('dependency_graph');
        const octokit = github.getOctokit(token);
        // 1. Validate Workflow Trigger
        if (github.context.eventName !== 'workflow_run') {
            core.info('This action only runs on workflow_run events. Skipping.');
            return;
        }
        const payload = github.context.payload;
        const runConclusion = (_a = payload.workflow_run) === null || _a === void 0 ? void 0 : _a.conclusion;
        const headBranch = (_b = payload.workflow_run) === null || _b === void 0 ? void 0 : _b.head_branch;
        const headSha = (_c = payload.workflow_run) === null || _c === void 0 ? void 0 : _c.head_sha;
        if (runConclusion !== 'success') {
            core.info(`Original workflow concluded with '${runConclusion}'. Skipping cascade.`);
            return;
        }
        // 2. Parse Dependency Graph
        const dependencies = parseGraph(graphRaw);
        const downstreams = dependencies.get(headBranch);
        if (!downstreams || downstreams.length === 0) {
            core.info(`No downstream dependencies defined for branch '${headBranch}'. Skipping.`);
            return;
        }
        core.info(`Processing cascade for ${headBranch} -> [${downstreams.join(', ')}]`);
        // 3. Setup Git
        yield git.setupUser(core.getInput('user_name'), core.getInput('user_email'));
        // Fetch upstream specifically
        yield git.fetch(headBranch);
        const successfulTasks = [];
        // 4. Process Downstreams
        for (const downstream of downstreams) {
            const tempBranch = `merge/${headBranch}/${downstream}`;
            core.startGroup(`Preparing merge: ${tempBranch}`);
            try {
                // Fetch downstream and potential existing temp branch
                yield git.fetch(downstream);
                yield git.fetch(tempBranch).catch(() => { }); // Ignore fail if temp doesn't exist
                // Checkout Logic
                const tempExists = yield git.branchExistsRemote(tempBranch);
                if (tempExists) {
                    yield git.checkout(tempBranch);
                    // Reset to match remote exactly to avoid local divergence
                    yield git.execCmd(['reset', '--hard', `origin/${tempBranch}`]);
                }
                else {
                    // If new, start from downstream
                    yield git.execCmd(['checkout', '-b', tempBranch, `origin/${downstream}`]);
                }
                // Merge 1: Merge the specific Upstream SHA (The build artifact)
                // We assume strict merge requirements (fail on conflict)
                yield git.merge(headSha, `Merge upstream commit ${headSha} into ${tempBranch}`);
                // Merge 2: Merge the latest Downstream (Syncing)
                // This ensures we are up to date with target before pushing
                yield git.merge(`origin/${downstream}`, `Sync with ${downstream}`);
                successfulTasks.push({
                    upstream: headBranch,
                    downstream: downstream,
                    tempBranch: tempBranch,
                    originalSha: headSha
                });
                core.info(`✅ Successfully prepared ${tempBranch}`);
            }
            catch (e) {
                core.error(`Failed to merge for ${downstream}: ${e.message}`);
                // Per requirements: "Any failure of automatic merge should result in action failure"
                throw e;
            }
            finally {
                core.endGroup();
            }
        }
        // Save state for Post step
        core.saveState(STATE_MERGE_TASKS, JSON.stringify(successfulTasks));
    });
}
function runPost() {
    return __awaiter(this, void 0, void 0, function* () {
        const tasksJson = core.getState(STATE_MERGE_TASKS);
        if (!tasksJson)
            return; // Nothing to do
        const tasks = JSON.parse(tasksJson);
        const token = core.getInput('token');
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
                yield git.checkout(task.tempBranch);
                // Push
                yield git.push(task.tempBranch);
                // 2. Create Pull Request
                // Check if PR exists first to avoid duplicates
                const { data: existingPrs } = yield octokit.rest.pulls.list(Object.assign(Object.assign({}, repo), { head: `${repo.owner}:${task.tempBranch}`, base: task.downstream, state: 'open' }));
                if (existingPrs.length === 0) {
                    const title = `Cascade Merge: ${task.upstream} to ${task.downstream}`;
                    const body = `Automated cascade merge triggered by workflow run on ${task.upstream}.\n\nSource Commit: ${task.originalSha}`;
                    yield octokit.rest.pulls.create(Object.assign(Object.assign({}, repo), { title,
                        body, head: task.tempBranch, base: task.downstream }));
                    core.info(`✅ PR Created for ${task.downstream}`);
                }
                else {
                    core.info(`PR already exists for ${task.downstream}`);
                }
            }
            catch (e) {
                core.setFailed(`Failed post-action for ${task.tempBranch}: ${e.message}`);
            }
            finally {
                core.endGroup();
            }
        }
    });
}
function parseGraph(input) {
    const map = new Map();
    const lines = input.split(/[\r\n]+/);
    for (const line of lines) {
        if (!line.trim() || line.startsWith('#'))
            continue;
        const [key, values] = line.split(':');
        if (key && values) {
            const sources = values.trim().split(/\s+/);
            map.set(key.trim(), sources);
        }
    }
    return map;
}
