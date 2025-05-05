import dotenv from 'dotenv';
import path from 'path';

// Adjust path to find .env in the parent directory (json-rpc-server/)
// Or directly in the transaction-indexer directory if preferred.
dotenv.config({ path: path.resolve(__dirname, '../../.env') }); // Assumes .env is in json-rpc-server root
// If .env is in transaction-indexer/, use: dotenv.config({ path: path.resolve(__dirname, '../.env') });

function getEnvVar(key: string, defaultValue?: string): string {
    const value = process.env[key];
    if (value === undefined) {
        if (defaultValue !== undefined) {
            return defaultValue;
        }
        throw new Error(`Environment variable ${key} is not set.`);
    }
    return value;
}

function getEnvVarAsInt(key: string, defaultValue?: number): number {
    const value = getEnvVar(key, defaultValue?.toString());
    const intValue = parseInt(value, 10);
    if (isNaN(intValue)) {
        throw new Error(`Environment variable ${key} must be an integer, but got '${value}'.`);
    }
    return intValue;
}

function getEnvVarAsBoolean(key: string, defaultValue?: boolean): boolean {
    const value = getEnvVar(key, defaultValue?.toString());
    const boolValue = value.toLowerCase() === 'true';
    if (boolValue === undefined) {
        throw new Error(`Environment variable ${key} must be a boolean, but got '${value}'.`);
    }
    return boolValue;
}

export const config = {
    jsonRpcUrl: getEnvVar('JSON_RPC_URL', 'http://localhost:8545'),
    startBlock: getEnvVarAsInt('START_BLOCK', 0),
    pollIntervalMs: getEnvVarAsInt('POLL_INTERVAL_MS', 5000),
    // Make sure data paths are relative to the new project root
    blockDataDir: getEnvVar('BLOCK_DATA_DIR', './data/blocks'),
    stateFilePath: getEnvVar('STATE_FILE_PATH', './data/indexer_state.json'),
    rpcMaxRetries: getEnvVarAsInt('RPC_MAX_RETRIES', 5),
    rpcRetryDelayMs: getEnvVarAsInt('RPC_RETRY_DELAY_MS', 1000),
    logLevel: getEnvVar('LOG_LEVEL', 'info'),
    statusServerPort: getEnvVarAsInt('STATUS_SERVER_PORT', 3001),
    databaseUrl: getEnvVar('DATABASE_URL', 'postgresql://user:password@host:port/database'),
    clearDataOnStart: getEnvVarAsBoolean('CLEAR_DATA_ON_START', false), // Flag to clear data
    backwardSyncBatchSize: getEnvVarAsInt('BACKWARD_SYNC_BATCH_SIZE', 10), // Batch size for backward sync
};
