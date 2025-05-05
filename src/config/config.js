"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.config = void 0;
const dotenv_1 = __importDefault(require("dotenv"));
const path_1 = __importDefault(require("path"));
// Adjust path to find .env in the parent directory (json-rpc-server/)
// Or directly in the transaction-indexer directory if preferred.
dotenv_1.default.config({ path: path_1.default.resolve(__dirname, '../../.env') }); // Assumes .env is in json-rpc-server root
// If .env is in transaction-indexer/, use: dotenv.config({ path: path.resolve(__dirname, '../.env') });
function getEnvVar(key, defaultValue) {
    const value = process.env[key];
    if (value === undefined) {
        if (defaultValue !== undefined) {
            return defaultValue;
        }
        throw new Error(`Environment variable ${key} is not set.`);
    }
    return value;
}
function getEnvVarAsInt(key, defaultValue) {
    const value = getEnvVar(key, defaultValue?.toString());
    const intValue = parseInt(value, 10);
    if (isNaN(intValue)) {
        throw new Error(`Environment variable ${key} must be an integer, but got '${value}'.`);
    }
    return intValue;
}
exports.config = {
    jsonRpcUrl: getEnvVar('JSON_RPC_URL', 'http://localhost:8545'),
    startBlock: getEnvVarAsInt('START_BLOCK', 0),
    pollIntervalMs: getEnvVarAsInt('POLL_INTERVAL_MS', 5000),
    // Make sure data paths are relative to the new project root
    blockDataDir: getEnvVar('BLOCK_DATA_DIR', './data/blocks'),
    stateFilePath: getEnvVar('STATE_FILE_PATH', './data/indexer_state.json'),
    rpcMaxRetries: getEnvVarAsInt('RPC_MAX_RETRIES', 5),
    rpcRetryDelayMs: getEnvVarAsInt('RPC_RETRY_DELAY_MS', 1000),
    logLevel: getEnvVar('LOG_LEVEL', 'info'),
};
//# sourceMappingURL=config.js.map