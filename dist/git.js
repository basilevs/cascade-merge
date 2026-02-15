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
exports.setupUser = setupUser;
exports.fetch = fetch;
exports.branchExistsRemote = branchExistsRemote;
exports.checkout = checkout;
exports.execCmd = execCmd;
exports.merge = merge;
exports.push = push;
const exec = __importStar(require("@actions/exec"));
function setupUser(name, email) {
    return __awaiter(this, void 0, void 0, function* () {
        yield exec.exec('git', ['config', 'user.name', name]);
        yield exec.exec('git', ['config', 'user.email', email]);
    });
}
function fetch(branch) {
    return __awaiter(this, void 0, void 0, function* () {
        // Fetch with enough depth to allow merging. 
        // Using unshallow if needed is safer but slower. 
        // Here we assume standard fetch of specific branch.
        yield exec.exec('git', ['fetch', 'origin', branch]);
    });
}
function branchExistsRemote(branch) {
    return __awaiter(this, void 0, void 0, function* () {
        const exitCode = yield exec.exec('git', ['ls-remote', '--exit-code', '--heads', 'origin', branch], { ignoreReturnCode: true });
        return exitCode === 0;
    });
}
function checkout(branch) {
    return __awaiter(this, void 0, void 0, function* () {
        yield exec.exec('git', ['checkout', branch]);
    });
}
function execCmd(args) {
    return __awaiter(this, void 0, void 0, function* () {
        yield exec.exec('git', args);
    });
}
function merge(ref, message) {
    return __awaiter(this, void 0, void 0, function* () {
        try {
            yield exec.exec('git', ['merge', '--no-edit', '-m', message, ref]);
        }
        catch (e) {
            throw new Error(`Conflict merging ${ref}`);
        }
    });
}
function push(branch) {
    return __awaiter(this, void 0, void 0, function* () {
        yield exec.exec('git', ['push', 'origin', branch]);
    });
}
