import * as fs from 'fs/promises';
import * as path from 'path';
import pino from 'pino';
import { config } from './config/config';
import { Block } from './types';

const logger = pino({ level: config.logLevel });
const blockDataDir = path.resolve(__dirname, '..', config.blockDataDir); // Ensure absolute path

// Ensure directory exists
async function ensureDataDirectory(): Promise<void> {
    try {
        await fs.mkdir(blockDataDir, { recursive: true });
    } catch (error: any) {
        if (error.code !== 'EEXIST') {
            logger.error({ err: error, directory: blockDataDir }, 'Failed to create block data directory');
            throw error;
        }
    }
}

export async function saveBlockToFile(block: Block): Promise<void> {
    await ensureDataDirectory();
    if (!block || !block.number || !block.hash) {
        logger.warn({ block }, 'Attempted to save invalid block data to file');
        return;
    }
    const blockNumber = parseInt(block.number, 16);
    const filename = path.join(blockDataDir, `${blockNumber}.json`);
    try {
        await fs.writeFile(filename, JSON.stringify(block, null, 2));
        logger.trace(`Saved block ${blockNumber} to ${filename}`);
    } catch (error) {
        logger.error({ err: error, filename, blockNumber }, 'Failed to save block data to file');
        throw error;
    }
}

// Function to clear the block data directory
export async function clearDataDirectory(): Promise<void> {
    logger.warn(`Clearing block data directory: ${blockDataDir}`);
    try {
        await ensureDataDirectory(); // Ensure it exists before trying to read/remove
        const files = await fs.readdir(blockDataDir);
        for (const file of files) {
            if (file.endsWith('.json')) { // Only remove our block files
                await fs.unlink(path.join(blockDataDir, file));
            }
        }
        logger.info(`Cleared ${files.length} files from ${blockDataDir}`);
    } catch (error) {
        logger.error({ err: error, directory: blockDataDir }, 'Error clearing block data directory');
        // Decide if this should be fatal? For now, just log.
        throw error; // Re-throw to indicate failure
    }
}