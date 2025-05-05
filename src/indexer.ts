import pino from 'pino';
import express from 'express';
import cors from 'cors';
import http from 'http';
import { config } from './config/config';
import { getLatestBlockNumber, getBlockByNumber } from './rpcClient';
import { loadState, saveState, saveForwardHead, saveBackwardHead } from './stateManager'; 
import { saveBlockToFile, clearDataDirectory } from './fileStorage'; 
import { Block, Transaction } from './types'; 
import { initializeDatabase, insertBlockData, getBlockByNumberDB, getTransactionByHashDB, getTransactionsByAddressDB, getStatsByTimeRangeDB, getTotalUniqueAccountsDB, closeDatabasePool, clearDatabaseTables, checkBlockExistsDB, insertMultipleBlocksData, pool } from './database'; 

const logger = pino({ level: config.logLevel });

// Global state for shutdown signal
let shuttingDown = false;

// Helper function to introduce delays
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// ANSI color helpers
const color = {
  red: (msg: string) => `\x1b[31m${msg}\x1b[0m`,
  yellow: (msg: string) => `\x1b[33m${msg}\x1b[0m`,
};

/**
 * Processes a single block: fetches, saves to file, inserts into DB.
 * @param blockNumber The block number to process.
 * @param direction Indicates if processing forward ('forward') or backward ('backward').
 * @returns True if processed successfully, false otherwise.
 */
async function processBlock(blockNumber: number, direction: 'forward' | 'backward'): Promise<boolean> {
    if (shuttingDown) return false;

    // Avoid processing block 0 or negative blocks during backfill
    if (direction === 'backward' && blockNumber < config.startBlock) {
        logger.info(color.yellow(`Reached configured startBlock ${config.startBlock} during backfill. Stopping backward indexing.`));
        await saveBackwardHead(0); // Mark backfill as complete by setting head to 0
        return false; // Don't process block 0 or less
    }

    logger.info(color.yellow(`Processing block ${blockNumber} (${direction})...`));

    try {
        // Check if block already exists (e.g., if forward/backward passes meet)
        if (await checkBlockExistsDB(blockNumber)) {
            logger.info(color.yellow(`Block ${blockNumber} already exists in DB. Skipping processing.`));
            // Still need to update the corresponding head state if it wasn't updated before
            // Only update if the current head is behind this block number
            const currentState = await loadState();
            if (direction === 'forward' && currentState.forwardHead < blockNumber) {
                await saveForwardHead(blockNumber);
            }
             else if (direction === 'backward' && (currentState.backwardHead === -1 || currentState.backwardHead > blockNumber)) { // Also handle initial state
                 // If backfilling, and this block is lower than our current backfill head
                await saveBackwardHead(blockNumber);
            }
            return true; // Consider it 'processed' in terms of moving the head
        }

        // --- Fetch Block (with retry) ---
        let block = await getBlockByNumber(blockNumber);
        if (!block || !block.hash) {
            logger.warn(color.yellow(`Block ${blockNumber} not found or invalid on first attempt. Retrying after delay...`));
            await delay(1000);
            block = await getBlockByNumber(blockNumber); // Assign directly to block
            if (!block || !block.hash) {
                 logger.error(color.red(`Failed to retrieve block ${blockNumber} after retry. Skipping.`));
                 // TODO: Add a mechanism to handle persistent gaps?
                 return false; // Indicate failure to process
            }
             logger.info(color.yellow(`Successfully retrieved block ${blockNumber} on retry.`));
        }
        // --- Block fetched successfully (either first try or retry) ---

        // 1. Save raw block data (optional, good for backup/reprocessing)
        // We already confirmed block is not null above
        await saveBlockToFile(block);

        // 2. Insert block and transaction data into the database
        // We already confirmed block is not null above
        await insertBlockData(block);

        // 3. Update state *after* successful processing
        if (direction === 'forward') {
            await saveForwardHead(blockNumber);
        }
         else { // backward
             await saveBackwardHead(blockNumber);
         }

        logger.info(color.yellow(`Successfully processed block ${blockNumber} (${direction})`));
        return true;
    } catch (error: any) {
        logger.error({ err: error, blockNumber, direction }, color.red(`Failed to process block ${blockNumber}`));
        // Depending on the error, we might want to retry or halt.
        // For now, log the error and return false to potentially retry the loop.
        // Add a delay before potentially retrying
        await delay(config.pollIntervalMs / 2);
        return false;
    }
}

/**
 * The main indexing loop.
 */
async function mainLoop(): Promise<void> {
    let state = await loadState();
    logger.info(color.yellow(`Loaded state: forwardHead = ${state.forwardHead}, backwardHead = ${state.backwardHead}, initialBackwardHead = ${state.initialBackwardHead}, backwardIndexingStartTime = ${state.backwardIndexingStartTime}`));

    // Determine the latest block on the chain
    let latestBlockOnChain = await getLatestBlockNumber();
    logger.info(color.yellow(`Latest block on chain: ${latestBlockOnChain}`));

    while (!shuttingDown) {
        try {
            state = await loadState(); // Reload state each iteration
            latestBlockOnChain = await getLatestBlockNumber();
            logger.debug(color.yellow(`Loop start. State: Fwd=${state.forwardHead}, Bwd=${state.backwardHead}. Chain: ${latestBlockOnChain}`));

            let processedBlockInLoop = false;

            // --- Backward Sync (Batch Processing) ---
            // Check if backward sync is active (head > target and initial head is set)
            if (state.backwardHead > config.startBlock && state.initialBackwardHead) {
                const batchSize = config.backwardSyncBatchSize;
                const nextBlockToProcess = state.backwardHead - 1;
                const endBlockOfBatch = Math.max(config.startBlock -1, nextBlockToProcess - batchSize + 1);
                 // Clamp startBlockOfBatch to not go below the target block
                 const startBlockOfBatch = Math.max(config.startBlock, nextBlockToProcess - batchSize + 1);

                const blockNumbersToFetch: number[] = [];
                for (let i = nextBlockToProcess; i >= startBlockOfBatch; i--) {
                     // Double check we don't go below configured start block
                     if (i >= config.startBlock) { 
                         blockNumbersToFetch.push(i);
                     }
                }

                if (blockNumbersToFetch.length > 0) {
                    logger.info(color.yellow(`Backward sync: Preparing batch fetch for blocks ${nextBlockToProcess} down to ${startBlockOfBatch} (${blockNumbersToFetch.length} blocks)...`));

                    // Fetch blocks concurrently
                    const fetchPromises = blockNumbersToFetch.map(num => getBlockByNumber(num));
                    const fetchResults = await Promise.allSettled(fetchPromises);

                    const fetchedBlocks: Block[] = [];
                    const failedFetches: number[] = [];

                    fetchResults.forEach((result, index) => {
                        const blockNumber = blockNumbersToFetch[index];
                        if (result.status === 'fulfilled' && result.value && result.value.hash) {
                            fetchedBlocks.push(result.value);
                        } else {
                            failedFetches.push(blockNumber);
                            const reason = result.status === 'rejected' ? result.reason : 'Block null or missing hash';
                            logger.warn({ blockNumber, reason }, color.yellow(`Failed to fetch block ${blockNumber} in batch.`));
                             // TODO: Implement retry logic for failed fetches if necessary
                        }
                    });

                    if (fetchedBlocks.length > 0) {
                        // Sort blocks descending by number before inserting (optional, but might be slightly better for DB)
                        fetchedBlocks.sort((a, b) => parseInt(b.number, 16) - parseInt(a.number, 16));

                        logger.info(color.yellow(`Backward sync: Fetched ${fetchedBlocks.length} blocks successfully. Inserting batch...`));
                        try {
                            // Check existence before inserting (optional, could rely on ON CONFLICT)
                            // For simplicity now, rely on insertMultipleBlocksData's ON CONFLICT
                            await insertMultipleBlocksData(fetchedBlocks);

                            // Update state ONLY after successful batch insert
                            // The new backwardHead is the lowest block number successfully fetched *and* inserted
                            // which corresponds to the startBlockOfBatch if all blocks in the range were processed
                             // Or more precisely, the lowest number in the *successfully fetched* batch
                             const lowestProcessedBlock = Math.min(...fetchedBlocks.map(b => parseInt(b.number, 16)));

                             // The *next* head should be this lowest processed block number
                             // because backwardHead represents the *next* block to process (going down)
                            await saveBackwardHead(lowestProcessedBlock);
                             logger.info(color.yellow(`Backward sync: Successfully processed batch down to block ${lowestProcessedBlock}. New backwardHead: ${lowestProcessedBlock}`));
                            processedBlockInLoop = true;
                        } catch (dbError) {
                            logger.error({ err: dbError }, color.red(`Backward sync: Database error during batch insert for blocks ${nextBlockToProcess} - ${startBlockOfBatch}. Retrying loop.`));
                            // Don't update state, loop will retry
                        }
                    } else if (failedFetches.length > 0) {
                        logger.warn(color.yellow(`Backward sync: No blocks fetched successfully in batch ${nextBlockToProcess} - ${startBlockOfBatch}. Retrying loop.`));
                        // Maybe add a delay here if fetches consistently fail
                    } else {
                        // No blocks to fetch, potentially means we reached the start block exactly
                        logger.info(color.yellow(`Backward sync: No blocks to fetch in range ${nextBlockToProcess} - ${startBlockOfBatch}. Assuming backfill completion check needed.`));
                        // Explicitly set head to target if we are exactly at the boundary? 
                        if (nextBlockToProcess < config.startBlock) {
                            await saveBackwardHead(config.startBlock);
                        }
                    }
                } else {
                     // No block numbers to fetch likely means state.backwardHead <= config.startBlock
                     logger.info(color.yellow(`Backward sync: Reached target block ${config.startBlock} or head is invalid. Finalizing.`));
                     await saveBackwardHead(config.startBlock); // Ensure state reflects completion
                }

             } else if (state.backwardHead === 0) {
                 logger.debug(color.yellow('Backward sync complete.'));
             }
             // If state.backwardHead is -1 (or null initial) -> backfill hasn't started or isn't configured correctly

            // --- Forward Sync ---
            if (state.forwardHead < latestBlockOnChain) {
                const nextForwardBlock = state.forwardHead + 1;
                logger.info(color.yellow(`New blocks detected. Current head: ${state.forwardHead}, Latest: ${latestBlockOnChain}. Processing next forward: ${nextForwardBlock}`));
                const success = await processBlock(nextForwardBlock, 'forward');
                if (success) {
                    processedBlockInLoop = true;
                } else {
                    logger.warn(color.yellow(`Failed to process forward block ${nextForwardBlock}. Will retry.`));
                }
            } else {
                logger.debug(color.yellow(`Forward head ${state.forwardHead} is up-to-date with chain ${latestBlockOnChain}.`));
            }

            // If no blocks were processed in this loop iteration, pause before the next check
            if (!processedBlockInLoop && !shuttingDown) {
                logger.trace(color.yellow(`No new blocks processed. Waiting for ${config.pollIntervalMs}ms...`));
                await delay(config.pollIntervalMs);
            } else if (!shuttingDown) {
                 // If we processed something, check again immediately (or with minimal delay)
                 await delay(50); // Small delay to prevent CPU spinning if chain is very active
             }

        } catch (error: any) {
            logger.error({ err: error }, color.red('Error in main loop. Retrying after delay...'));
            if (!shuttingDown) {
                await delay(config.pollIntervalMs); // Wait longer after an error
            }
        }
    }
    logger.info(color.yellow('Main loop exited.'));
}

/**
 * Creates and starts the HTTP status/API server.
 * @param port Port number to listen on.
 * @returns The created HTTP server instance.
 */
function startStatusServer(port: number): http.Server {
    const app = express();

    // Configure CORS
    app.use(cors({
        origin: ['http://localhost:3000', 'http://localhost:5173'], // Allow our Next.js frontend and Vite dev server
        methods: ['GET'], // Only allow GET requests
        allowedHeaders: ['Content-Type'],
    }));

    // Simple status endpoint
    app.get('/status', async (req, res) => {
        try {
            const state = await loadState();
            const latest = await getLatestBlockNumber(); // Get fresh latest block

            let backfillStatus: any = {
                complete: state.backwardHead === 0 || (state.backwardHead === -1 && !state.initialBackwardHead),
                 active: state.backwardHead > 0 && !!state.initialBackwardHead,
                 blocksProcessed: null,
                 blocksRemaining: null,
                 percentageComplete: null,
                 startTime: state.backwardIndexingStartTime,
                 elapsedTimeMs: null,
                 elapsedTimeFormatted: null,
                 blocksPerSecond: null,
                 estimatedTimeRemainingMs: null,
                 estimatedTimeRemainingFormatted: null,
                 etaTimestamp: null,
            };

            if (backfillStatus.active && state.initialBackwardHead && state.backwardIndexingStartTime) {
                const targetBlock = config.startBlock; // Target is usually block 0 or config.startBlock
                const initialHead = state.initialBackwardHead;
                const currentHead = state.backwardHead;
                const startTime = state.backwardIndexingStartTime;

                const blocksProcessed = initialHead - currentHead;
                const blocksRemaining = currentHead - targetBlock;
                 // Ensure totalBlocks is never zero to avoid division by zero
                 const totalBlocks = Math.max(1, initialHead - targetBlock);
                 const percentageComplete = totalBlocks > 0 ? (blocksProcessed / totalBlocks) * 100 : (backfillStatus.complete ? 100 : 0);

                const elapsedTimeMs = Date.now() - startTime;
                 const blocksPerSecond = elapsedTimeMs > 0 ? (blocksProcessed / (elapsedTimeMs / 1000)) : 0;

                let estimatedTimeRemainingMs = Infinity;
                if (blocksPerSecond > 0 && blocksRemaining > 0) {
                    estimatedTimeRemainingMs = (blocksRemaining / blocksPerSecond) * 1000;
                }
                const etaTimestamp = Number.isFinite(estimatedTimeRemainingMs) ? new Date(Date.now() + estimatedTimeRemainingMs).toISOString() : null;

                backfillStatus = {
                    ...backfillStatus,
                    initialHead: initialHead,
                    currentTarget: targetBlock, 
                    blocksProcessed: blocksProcessed,
                    blocksRemaining: blocksRemaining,
                     percentageComplete: parseFloat(percentageComplete.toFixed(2)),
                    startTime: startTime,
                    elapsedTimeMs: elapsedTimeMs,
                    elapsedTimeFormatted: formatDuration(elapsedTimeMs),
                    blocksPerSecond: parseFloat(blocksPerSecond.toFixed(2)),
                    estimatedTimeRemainingMs: estimatedTimeRemainingMs,
                    estimatedTimeRemainingFormatted: formatDuration(estimatedTimeRemainingMs),
                    etaTimestamp: etaTimestamp
                };
            } else if (backfillStatus.complete) {
                 // If complete, set percentage to 100
                 backfillStatus.percentageComplete = 100;
             }

            res.json({
                status: shuttingDown ? 'shutting down' : 'running',
                latestBlockOnChain: latest,
                currentForwardHead: state.forwardHead,
                currentBackwardHead: state.backwardHead,
                backfill: backfillStatus,
                config: {
                    startBlock: config.startBlock,
                    pollIntervalMs: config.pollIntervalMs,
                    clearDataOnStart: config.clearDataOnStart,
                 }
            });
        } catch (error) {
            logger.error({ err: error }, color.red('Error fetching status'));
            res.status(500).json({ error: 'Failed to retrieve indexer status' });
        }
    });


    // New endpoint for block production metrics
    app.get('/blocks/metrics', async (req, res) => {
        const range = req.query.range as string;
        let interval: string;

        // Basic validation and mapping
        switch (range) {
            case '1h': interval = '1 hour'; break;
            case '6h': interval = '6 hours'; break;
            case '1d': interval = '1 day'; break;
            case '7d': interval = '7 days'; break;
            case '30d': interval = '30 days'; break;
            default:
                return res.status(400).json({ error: 'Invalid range parameter. Use 1h, 6h, 1d, 7d, or 30d.' });
        }

        try {
            // Use a subquery to compute block_time, then aggregate in the outer query
            const query = `
                SELECT
                  COUNT(*) as total_blocks,
                  COUNT(DISTINCT miner) as unique_miners,
                  AVG(transaction_count) as avg_tx_per_block,
                  MIN(timestamp) as first_block_time,
                  MAX(timestamp) as last_block_time,
                  AVG(block_time) as avg_block_time
                FROM (
                  SELECT
                    block_number,
                    miner,
                    transaction_count,
                    timestamp,
                    timestamp - LAG(timestamp) OVER (ORDER BY block_number) as block_time
                  FROM blocks
                  WHERE timestamp >= EXTRACT(EPOCH FROM (NOW() - INTERVAL '${interval}'))
                ) sub
                WHERE block_time IS NOT NULL;
            `;
            const result = await pool.query(query);
            const metrics = result.rows[0];

            res.json({
                range,
                interval,
                totalBlocks: parseInt(metrics.total_blocks || '0', 10),
                uniqueMiners: parseInt(metrics.unique_miners || '0', 10),
                averageTransactionsPerBlock: parseFloat(metrics.avg_tx_per_block || '0'),
                averageBlockTime: parseFloat(metrics.avg_block_time || '0'),
                timeRange: {
                    start: parseInt(metrics.first_block_time || '0', 10),
                    end: parseInt(metrics.last_block_time || '0', 10)
                }
            });
        } catch (error) {
            logger.error({ err: error, query: req.query }, color.red('Error querying block metrics'));
            res.status(500).json({ error: 'Internal server error' });
        }
    });

    // Endpoint to get details for a specific block from DB
    app.get('/blocks/:blockNumber', async (req, res) => {
        const blockNumberStr = req.params.blockNumber;
        const blockNumber = parseInt(blockNumberStr, 10);
        if (isNaN(blockNumber)) {
            return res.status(400).json({ error: 'Invalid block number format' });
        }
        try {
            const block = await getBlockByNumberDB(blockNumber);
            if (block) {
                res.json(block);
            } else {
                res.status(404).json({ error: `Block ${blockNumber} not found in indexer database` });
            }
        } catch (error) {
            logger.error({ err: error, blockNumber }, color.red('Error fetching block from DB'));
            res.status(500).json({ error: 'Internal server error fetching block' });
        }
    });

    // New endpoint for transaction count by time range
    app.get('/transactions/count', async (req, res) => {
        const range = req.query.range as string;
        let interval: string;

        // Basic validation and mapping
        switch (range) {
            case '1h': interval = '1 hour'; break;
            case '6h': interval = '6 hours'; break;
            case '1d': interval = '1 day'; break;
            case '7d': interval = '7 days'; break;
            case '30d': interval = '30 days'; break;
            default:
                return res.status(400).json({ error: 'Invalid range parameter. Use 1h, 6h, 1d, 7d, or 30d.' });
        }

        try {
            // Embed interval directly into the query string
            const query = `
                SELECT COUNT(t.*) AS transaction_count
                FROM transactions t
                JOIN blocks b ON t.block_number = b.block_number
                WHERE b.timestamp >= EXTRACT(EPOCH FROM (NOW() - INTERVAL '${interval}'));
            `;
            const result = await pool.query(query); // No parameters needed now
            const count = result.rows[0]?.transaction_count || 0;

            res.json({ range: range, interval: interval, count: parseInt(count, 10) });
        } catch (error) {
            logger.error({ err: error, query: req.query }, color.red('Error querying transaction count'));
            res.status(500).json({ error: 'Internal server error' });
        }
    });

    // Enhanced endpoint for transaction type distribution with contract interaction decoding
    app.get('/transactions/types', async (req, res) => {
        const range = req.query.range as string;
        let interval: string;

        // Basic validation and mapping
        switch (range) {
            case '1h': interval = '1 hour'; break;
            case '6h': interval = '6 hours'; break;
            case '1d': interval = '1 day'; break;
            case '7d': interval = '7 days'; break;
            case '30d': interval = '30 days'; break;
            default:
                return res.status(400).json({ error: 'Invalid range parameter. Use 1h, 6h, 1d, 7d, or 30d.' });
        }

        try {
            // Fetch all transactions in the range
            const query = `
                SELECT t.input_data
                FROM transactions t
                JOIN blocks b ON t.block_number = b.block_number
                WHERE b.timestamp >= EXTRACT(EPOCH FROM (NOW() - INTERVAL '${interval}'));
            `;
            const result = await pool.query(query);
            const distribution: Record<string, number> = {};

            for (const row of result.rows) {
                const input = row.input_data;
                if (input === '0x') {
                    distribution['transfer'] = (distribution['transfer'] || 0) + 1;
                } else {
                    // Try to decode as UTF-8 and parse as JSON
                    let decoded = '';
                    try {
                        // Remove 0x and decode hex to buffer
                        const hex = input.startsWith('0x') ? input.slice(2) : input;
                        const buf = Buffer.from(hex, 'hex');
                        decoded = buf.toString('utf8');
                        // Try to parse as JSON
                        let parsed;
                        try {
                            parsed = JSON.parse(decoded);
                        } catch {
                            parsed = null;
                        }
                        if (parsed && typeof parsed === 'object' && parsed.internalTXType !== undefined) {
                            if (parsed.internalTXType === 6) {
                                distribution['stake'] = (distribution['stake'] || 0) + 1;
                            } else if (parsed.internalTXType === 7) {
                                distribution['unstake'] = (distribution['unstake'] || 0) + 1;
                            } else {
                                distribution['other_contract_interaction'] = (distribution['other_contract_interaction'] || 0) + 1;
                            }
                        } else {
                            distribution['contract_interaction'] = (distribution['contract_interaction'] || 0) + 1;
                        }
                    } catch {
                        distribution['contract_interaction'] = (distribution['contract_interaction'] || 0) + 1;
                    }
                }
            }

            res.json({
                range,
                interval,
                distribution
            });
        } catch (error) {
            logger.error({ err: error, query: req.query }, color.red('Error querying transaction type distribution'));
            res.status(500).json({ error: 'Internal server error' });
        }
    });

    // Endpoint to get transaction details by hash from DB (keep this below /transactions/types)
    app.get('/transactions/:hash', async (req, res) => {
        const txHash = req.params.hash;
        // Basic hash validation (length, prefix)
        if (!/^0x[a-fA-F0-9]{64}$/.test(txHash)) {
             return res.status(400).json({ error: 'Invalid transaction hash format' });
        }
        try {
            const transaction = await getTransactionByHashDB(txHash);
            if (transaction) {
                res.json(transaction);
            } else {
                res.status(404).json({ error: `Transaction ${txHash} not found in indexer database` });
            }
        } catch (error) {
            logger.error({ err: error, txHash }, color.red('Error fetching transaction from DB'));
            res.status(500).json({ error: 'Internal server error fetching transaction' });
        }
    });

    // New endpoint for top accounts by value held (add detailed error logging)
    app.get('/accounts/top', async (req, res) => {
        const range = req.query.range as string;
        const limit = parseInt(req.query.limit as string || '10', 10);
        let interval: string;

        // Basic validation and mapping
        switch (range) {
            case '1h': interval = '1 hour'; break;
            case '6h': interval = '6 hours'; break;
            case '1d': interval = '1 day'; break;
            case '7d': interval = '7 days'; break;
            case '30d': interval = '30 days'; break;
            default:
                return res.status(400).json({ error: 'Invalid range parameter. Use 1h, 6h, 1d, 7d, or 30d.' });
        }

        try {
            const query = `
                WITH address_balances AS (
                    SELECT 
                        address,
                        SUM(
                            CASE 
                                WHEN address = from_address THEN -value::numeric
                                WHEN address = to_address THEN value::numeric
                                ELSE 0
                            END
                        ) as net_value
                    FROM (
                        SELECT from_address as address, value, block_number
                        FROM transactions
                        UNION ALL
                        SELECT to_address as address, value, block_number
                        FROM transactions
                        WHERE to_address IS NOT NULL
                    ) t
                    JOIN blocks b ON t.block_number = b.block_number
                    WHERE b.timestamp >= EXTRACT(EPOCH FROM (NOW() - INTERVAL '${interval}'))
                    GROUP BY address
                )
                SELECT 
                    address,
                    net_value
                FROM address_balances
                WHERE net_value > 0 AND address IS NOT NULL
                ORDER BY net_value DESC
                LIMIT $1;
            `;
            const result = await pool.query(query, [limit]);
            
            res.json({
                range,
                interval,
                topAccounts: result.rows.map(row => ({
                    address: row.address,
                    netValue: row.net_value.toString()
                }))
            });
        } catch (error) {
            logger.error({ err: error, params: { range, limit } }, color.red('Error querying top accounts (SQL/database error)'));
            res.status(500).json({ error: 'Internal server error' });
        }
    });

    // Endpoint to get transactions for a specific address from DB
    app.get('/addresses/:address/transactions', async (req, res) => {
        const address = req.params.address.toLowerCase(); // Normalize address
        // Basic address validation
        if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
            return res.status(400).json({ error: 'Invalid address format' });
        }
        try {
            // TODO: Add pagination support here (query params: page, pageSize)
            const transactions = await getTransactionsByAddressDB(address);
            res.json({ address, transactions });
        } catch (error) {
            logger.error({ err: error, address }, color.red('Error fetching transactions for address from DB'));
            res.status(500).json({ error: 'Internal server error fetching transactions' });
        }
    });

    // Endpoint for time-range statistics
    app.get('/stats', async (req, res) => {
        const range = req.query.range as string | undefined;
        if (!range) {
            return res.status(400).json({ error: 'Missing required query parameter: range (e.g., 24h, 7d, 30d)' });
        }

        try {
            const { startTime, endTime } = parseTimeRange(range); // Use internal helper
            const stats = await getStatsByTimeRangeDB(startTime, endTime);
            res.json({ range, startTime, endTime, ...stats });
        } catch (error: any) {
            logger.error({ err: error, range }, color.red('Error parsing time range or fetching stats'));
            // Distinguish between bad range format and DB error
            if (error.message.includes('Invalid range format')) {
                 res.status(400).json({ error: error.message });
            } else {
                res.status(500).json({ error: 'Internal server error fetching statistics' });
            }
        }
    });

    // Endpoint for total unique accounts
    app.get('/stats/accounts/unique-count', async (req, res) => {
        const range = req.query.range as string;
        if (!range) {
            return res.status(400).json({ error: 'Missing required query parameter: range (e.g., 1h, 1d, 7d, 30d, 1m, 1y)' });
        }

        try {
            const { startTime, endTime } = parseTimeRange(range);
            const count = await getTotalUniqueAccountsDB(startTime, endTime);
            res.json({ 
                range,
                startTime,
                endTime,
                uniqueAccountCount: count 
            });
        } catch (error: any) {
            logger.error({ err: error, range }, color.red('Error fetching unique account count'));
            // Distinguish between bad range format and DB error
            if (error.message.includes('Invalid range format')) {
                res.status(400).json({ error: error.message });
            } else {
                res.status(500).json({ error: 'Internal server error fetching unique account count' });
            }
        }
    }); 

    // New endpoint for total value transferred by time range
    app.get('/value', async (req, res) => {
        const range = req.query.range as string;
        let interval: string;

        // Basic validation and mapping (same as /transactions)
        switch (range) {
            case '1h': interval = '1 hour'; break;
            case '6h': interval = '6 hours'; break;
            case '1d': interval = '1 day'; break;
            case '7d': interval = '7 days'; break;
            case '30d': interval = '30 days'; break;
            default:
                return res.status(400).json({ error: 'Invalid range parameter. Use 1h, 6h, 1d, 7d, or 30d.' });
        }

        try {
            // Embed interval directly into the query string
            const query = `
                SELECT SUM(t.value) AS total_value
                FROM transactions t
                JOIN blocks b ON t.block_number = b.block_number
                WHERE b.timestamp >= EXTRACT(EPOCH FROM (NOW() - INTERVAL '${interval}'));
            `;
            const result = await pool.query(query); // No parameters needed now
            // SUM returns NULL if no rows match, default to '0'. Value is NUMERIC, return as string.
            const totalValue = result.rows[0]?.total_value || '0';

            res.json({ range: range, interval: interval, totalValue: totalValue });
        } catch (error) {
            logger.error({ err: error, query: req.query }, color.red('Error querying total value'));
            res.status(500).json({ error: 'Internal server error' });
        }
    });

    // New endpoint for gas spent by time range
    app.get('/gas', async (req, res) => {
        const range = req.query.range as string;
        let interval: string;

        // Basic validation and mapping
        switch (range) {
            case '1h': interval = '1 hour'; break;
            case '6h': interval = '6 hours'; break;
            case '1d': interval = '1 day'; break;
            case '7d': interval = '7 days'; break;
            case '30d': interval = '30 days'; break;
            default:
                return res.status(400).json({ error: 'Invalid range parameter. Use 1h, 6h, 1d, 7d, or 30d.' });
        }

        try {
            const query = `
                SELECT 
                    SUM(b.gas_used) as total_gas_used,
                    AVG(b.gas_used) as avg_gas_per_block,
                    COUNT(DISTINCT b.block_number) as total_blocks
                FROM blocks b
                WHERE b.timestamp >= EXTRACT(EPOCH FROM (NOW() - INTERVAL '${interval}'));
            `;
            const result = await pool.query(query);
            const stats = result.rows[0];

            res.json({
                range,
                interval,
                totalGasUsed: parseInt(stats.total_gas_used || '0', 10),
                averageGasPerBlock: parseFloat(stats.avg_gas_per_block || '0'),
                totalBlocks: parseInt(stats.total_blocks || '0', 10)
            });
        } catch (error) {
            logger.error({ err: error, query: req.query }, color.red('Error querying gas statistics'));
            res.status(500).json({ error: 'Internal server error' });
        }
    });

    const server = http.createServer(app);
    server.listen(port);
    return server;
}

/**
 * Initializes and starts the indexer.
 */
async function runIndexer(): Promise<void> {
    logger.info(color.yellow('Starting Transaction Indexer...'));

    // --- Data Clearing --- Check if flag is set
    if (config.clearDataOnStart) {
        logger.warn(color.yellow('CLEAR_DATA_ON_START is true. Clearing data...'));
        try {
            await clearDatabaseTables();
            await clearDataDirectory();
            // Reset state file: Start backward from latest, forward also from latest
            const latestBlock = await getLatestBlockNumber();
             // Start backward head *after* latest block, so first processed is latest block
            const initialState = {
                forwardHead: latestBlock,
                backwardHead: latestBlock + 1,
                initialBackwardHead: latestBlock + 1, // Record where backfill started
                backwardIndexingStartTime: Date.now() // Record when backfill started
            };
            await saveState(initialState);
            logger.info(color.yellow(`Data cleared. Initial state set: forwardHead=${initialState.forwardHead}, backwardHead=${initialState.backwardHead}`));
        } catch (error) {
            logger.fatal({ err: error }, color.red('Failed to clear data on startup. Exiting.'));
            process.exit(1);
        }
    } else {
         logger.info(color.yellow('CLEAR_DATA_ON_START is false. Skipping data clearing.'));
    }
    // --- End Data Clearing ---

    try {
        await initializeDatabase();
        logger.info(color.yellow('Database schema initialization complete.'));

        // Start the status/API server *after* potential clearing and DB init
        const server = startStatusServer(config.statusServerPort);
        server.on('listening', () => {
             logger.info(color.yellow(`Status & API server listening on http://localhost:${config.statusServerPort}`));
        });
        server.on('error', (err) => {
            logger.fatal({ err }, color.red('Failed to start status server. Exiting.'));
            // Attempt to close DB pool before exiting
             closeDatabasePool().finally(() => process.exit(1));
        });

        // Start the main indexing loop
        await mainLoop();

    } catch (error: any) {
        logger.fatal({ err: error }, color.red('Fatal error during indexer initialization or main loop.'));
        await closeDatabasePool();
        process.exit(1);
    }
}

// Graceful shutdown handler
async function gracefulShutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(color.yellow('Shutting down indexer...'));

    // wait briefly for the current block processing to finish
    await new Promise(resolve => setTimeout(resolve, 2000)); 
    // Close the database pool
    await closeDatabasePool();

    logger.info(color.yellow('Indexer shutdown complete.'));
    process.exit(0);
}

// Listen for termination signals
process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

// Start the indexer
runIndexer().catch(error => {
    logger.fatal({ err: error }, color.red('Unhandled error in runIndexer.'));
    process.exit(1);
});


// --- Time Range Parsing Helper --- (Keep it here as it's used by the API endpoint defined above)
function parseTimeRange(range: string): { startTime: number; endTime: number } {
    const now = Math.floor(Date.now() / 1000);
    let startTime = now;
    const endTime = now;

    const durationMatch = range.match(/^(\d+)([hdwmy])$/); // h, d, w, m, y
    if (!durationMatch) {
        throw new Error('Invalid range format. Use e.g., 24h, 7d, 1m, 1y');
    }

    const value = parseInt(durationMatch[1], 10);
    const unit = durationMatch[2];

    switch (unit) {
        case 'h':
            startTime = now - value * 60 * 60;
            break;
        case 'd':
            startTime = now - value * 24 * 60 * 60;
            break;
        case 'w':
            startTime = now - value * 7 * 24 * 60 * 60;
             break;
        case 'm': // Assuming 30 days for a month
            startTime = now - value * 30 * 24 * 60 * 60;
            break;
        case 'y': // Assuming 365 days for a year
            startTime = now - value * 365 * 24 * 60 * 60;
            break;
         default: // Should be caught by regex, but belts and braces
             throw new Error('Invalid time unit in range.');
    }

    return { startTime, endTime };
}

// Helper function to format duration in milliseconds to a readable string
function formatDuration(ms: number): string {
    if (ms < 0 || !Number.isFinite(ms)) return 'N/A';

    const seconds = Math.floor(ms / 1000) % 60;
    const minutes = Math.floor(ms / (1000 * 60)) % 60;
    const hours = Math.floor(ms / (1000 * 60 * 60)) % 24;
    const days = Math.floor(ms / (1000 * 60 * 60 * 24));

    let str = '';
    if (days > 0) str += `${days}d `;
    if (hours > 0) str += `${hours}h `;
    if (minutes > 0) str += `${minutes}m `;
    if (seconds >= 0) str += `${seconds}s`; // Always show seconds if other units are 0

    return str.trim() || '0s'; // Handle case where ms < 1000
}