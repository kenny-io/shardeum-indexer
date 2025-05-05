import * as fs from 'fs/promises';
import * as path from 'path';
import pino from 'pino';
import { config } from './config/config';

const logger = pino({ level: config.logLevel });
const stateFilePath = path.resolve(__dirname, '..', config.stateFilePath); // Ensure absolute path

// Define the structure of the state
interface IndexerState {
    forwardHead: number; // Highest block processed going forward
    backwardHead: number; // Lowest block processed going backward (-1 if backfill hasn't started/finished)
    initialBackwardHead: number | null; // The block number where backward indexing started (or null)
    backwardIndexingStartTime: number | null; // Timestamp (ms) when backward indexing started (or null)
}

// Ensure state file directory exists
async function ensureStateDirectory(): Promise<void> {
    const dir = path.dirname(stateFilePath);
    try {
        await fs.mkdir(dir, { recursive: true });
    } catch (error: any) {
        if (error.code !== 'EEXIST') {
            logger.error({ err: error, directory: dir }, 'Failed to create state file directory');
            throw error;
        }
    }
}

// Load the last indexed block number from the state file
export async function loadState(): Promise<IndexerState> {
    await ensureStateDirectory();
    try {
        const data = await fs.readFile(stateFilePath, 'utf-8');
        const state = JSON.parse(data) as IndexerState;
        // Ensure both keys exist, provide defaults if loading older state file
        if (state.forwardHead === undefined) state.forwardHead = config.startBlock > 0 ? config.startBlock -1 : 0; // Or adjust default
        if (state.backwardHead === undefined) state.backwardHead = -1; // Default if not present
        if (state.initialBackwardHead === undefined) state.initialBackwardHead = null;
        if (state.backwardIndexingStartTime === undefined) state.backwardIndexingStartTime = null;
        logger.info(`Loaded state: forwardHead = ${state.forwardHead}, backwardHead = ${state.backwardHead}, initialBackwardHead = ${state.initialBackwardHead}, backwardIndexingStartTime = ${state.backwardIndexingStartTime}`);
        return state;
    } catch (error: any) {
        if (error.code === 'ENOENT') {
            logger.warn(`State file not found at ${stateFilePath}. Initializing default state.`);
            // Return initial state (or state based on latest block later)
            return { forwardHead: config.startBlock > 0 ? config.startBlock -1 : 0, backwardHead: -1, initialBackwardHead: null, backwardIndexingStartTime: null };
        } else {
            logger.error({ err: error, file: stateFilePath }, 'Failed to load state file');
            throw error;
        }
    }
}

// Save the current state to the file
export async function saveState(state: IndexerState): Promise<void> {
    await ensureStateDirectory();
    try {
        const data = JSON.stringify(state, null, 2);
        await fs.writeFile(stateFilePath, data, 'utf-8');
        logger.trace(`Saved state: ${JSON.stringify(state)} to ${stateFilePath}`);
    } catch (error) {
        logger.error({ err: error, file: stateFilePath, state }, 'Failed to save state file');
        throw error;
    }
}

// Helper to specifically save only the forward head
export async function saveForwardHead(blockNumber: number): Promise<void> {
    const currentState = await loadState();
    await saveState({ ...currentState, forwardHead: blockNumber });
}

// Helper to specifically save only the backward head
export async function saveBackwardHead(blockNumber: number): Promise<void> {
    const currentState = await loadState();
    await saveState({ ...currentState, backwardHead: blockNumber });
}