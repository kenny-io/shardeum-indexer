import { Pool, QueryResult } from 'pg';
import pino from 'pino';
import { config } from './config/config';
import { Block, Transaction } from './types';

const logger = pino({ level: config.logLevel });

// Create a connection pool
export const pool = new Pool({
    connectionString: config.databaseUrl, // Use a connection string
    // Or individual parameters:
    // user: config.dbUser,
    // host: config.dbHost,
    // database: config.dbName,
    // password: config.dbPassword,
    // port: config.dbPort,
    max: 20, // Max number of clients in the pool
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
});

pool.on('error', (err, client) => {
    logger.error({ err, client }, 'Unexpected error on idle client');
    // Optionally try to exit or handle restart
});

// Function to initialize database schema
export async function initializeDatabase(): Promise<void> {
    const client = await pool.connect();
    try {
        logger.info('Initializing database schema...');

        // Create blocks table
        await client.query(`
            CREATE TABLE IF NOT EXISTS blocks (
                block_number BIGINT PRIMARY KEY,
                block_hash VARCHAR(66) UNIQUE NOT NULL,
                parent_hash VARCHAR(66) NOT NULL,
                timestamp BIGINT NOT NULL,
                miner VARCHAR(42) NOT NULL,
                gas_used BIGINT NOT NULL,
                gas_limit BIGINT NOT NULL,
                size BIGINT NOT NULL,
                transaction_count INTEGER NOT NULL,
                created_at TIMESTAMPTZ DEFAULT NOW()
            );
        `);
        logger.info('Table "blocks" checked/created.');

        // Create transactions table
        await client.query(`
            CREATE TABLE IF NOT EXISTS transactions (
                tx_hash VARCHAR(66) PRIMARY KEY,
                block_number BIGINT NOT NULL REFERENCES blocks(block_number) ON DELETE CASCADE,
                tx_index INTEGER NOT NULL,
                from_address VARCHAR(42) NOT NULL,
                to_address VARCHAR(42), -- Null for contract creation
                value NUMERIC(38, 0) NOT NULL, -- Using NUMERIC for large values
                gas BIGINT NOT NULL,
                gas_price NUMERIC(38, 0) NOT NULL, -- Using NUMERIC for large values
                input_data TEXT, -- Use TEXT for potentially large input data
                nonce BIGINT NOT NULL,
                created_at TIMESTAMPTZ DEFAULT NOW()
            );
        `);
        logger.info('Table "transactions" checked/created.');

        // Add indexes for faster lookups
        await client.query('CREATE INDEX IF NOT EXISTS idx_transactions_block_number ON transactions(block_number);');
        await client.query('CREATE INDEX IF NOT EXISTS idx_transactions_from_address ON transactions(from_address);');
        await client.query('CREATE INDEX IF NOT EXISTS idx_transactions_to_address ON transactions(to_address);');
        logger.info('Indexes checked/created.');

        logger.info('Database schema initialization complete.');
    } catch (err) {
        logger.error({ err }, 'Error initializing database schema');
        throw err;
    } finally {
        client.release();
    }
}

// Function to insert a block and its transactions atomically
export async function insertBlockData(block: Block): Promise<void> {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Insert block data
        const blockInsertQuery = `
            INSERT INTO blocks (
                block_number, block_hash, parent_hash, timestamp, miner, gas_used, gas_limit, size, transaction_count
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            ON CONFLICT (block_number) DO NOTHING;
        `;
        await client.query(blockInsertQuery, [
            parseInt(block.number, 16),
            block.hash,
            block.parentHash,
            parseInt(block.timestamp, 16), // Ensure this is the numeric timestamp
            block.miner.toLowerCase(),
            parseInt(block.gasUsed, 16),
            parseInt(block.gasLimit, 16),
            parseInt(block.size, 16),
            block.transactions.length
        ]);

        // Insert transactions if they exist
        if (block.transactions && block.transactions.length > 0) {
            const transactionValues: any[] = [];
            const queryParams: any[] = [];
            let paramIndex = 1;

            block.transactions.forEach(tx => {
                // Type guard to ensure tx is an object and not just a hash string
                if (typeof tx === 'object' && tx !== null) {
                    const values: any[] = [
                        tx.hash, // Now safe to access
                        parseInt(block.number, 16),
                        tx.transactionIndex ? parseInt(tx.transactionIndex, 16) : null, // Safe
                        tx.from.toLowerCase(), // Safe
                        tx.to ? tx.to.toLowerCase() : null, // Safe
                        BigInt(tx.value).toString(), // Convert hex value to decimal string
                        parseInt(tx.gas, 16), // Safe
                        BigInt(tx.gasPrice).toString(), // Convert hex gasPrice to decimal string
                        tx.input, // Safe
                        parseInt(tx.nonce, 16) // Safe
                    ];
                    const valuePlaceholders = values.map((_, i) => `$${paramIndex + i}`).join(', ');
                    transactionValues.push(`(${valuePlaceholders})`);
                    queryParams.push(...values);
                    paramIndex += values.length;
                }
            });

            const queryText = `
                INSERT INTO transactions (
                    tx_hash, block_number, tx_index, from_address, to_address, 
                    value, gas, gas_price, input_data, nonce
                )
                VALUES ${transactionValues.join(', ')}
                ON CONFLICT (tx_hash) DO NOTHING`; // Avoid errors if tx somehow exists

            await client.query(queryText, queryParams);
        }

        await client.query('COMMIT');
        logger.trace(`Inserted block ${parseInt(block.number, 16)} and ${block.transactions.length} transactions.`);
    } catch (error) {
        await client.query('ROLLBACK');
        logger.error({ err: error, blockNumber: parseInt(block.number, 16) }, 'Error inserting block data, rolled back transaction');
        throw error; // Re-throw to allow handling upstream
    } finally {
        client.release();
    }
}

/**
 * Inserts data for multiple blocks and their transactions efficiently within a single transaction.
 * @param blocks An array of Block objects to insert.
 */
export async function insertMultipleBlocksData(blocks: Block[]): Promise<void> {
    if (blocks.length === 0) {
        return;
    }
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // --- Prepare Block Insert --- 
        const blockValues: string[] = [];
        const blockQueryParams: any[] = [];
        let blockParamIndex = 1;

        blocks.forEach(block => {
            const values = [
                parseInt(block.number, 16),
                block.hash,
                block.parentHash,
                parseInt(block.timestamp, 16), // Ensure this is the numeric timestamp
                block.miner.toLowerCase(),
                parseInt(block.gasUsed, 16),
                parseInt(block.gasLimit, 16),
                parseInt(block.size, 16),
                block.transactions.length
            ];
            const valuePlaceholders = values.map((_, i) => `$${blockParamIndex + i}`).join(', ');
            blockValues.push(`(${valuePlaceholders})`);
            blockQueryParams.push(...values);
            blockParamIndex += values.length;
        });

        const blockQueryText = `
            INSERT INTO blocks (block_number, block_hash, parent_hash, timestamp, miner, gas_used, gas_limit, size, transaction_count)
            VALUES ${blockValues.join(', ')}
            ON CONFLICT (block_number) DO NOTHING`;

        if (blockValues.length > 0) {
            await client.query(blockQueryText, blockQueryParams);
            logger.trace(`Prepared insert for ${blocks.length} blocks.`);
        } else {
             logger.trace(`No blocks to insert.`);
        }

        // --- Prepare Transaction Insert --- 
        const transactionValues: string[] = [];
        const transactionQueryParams: any[] = [];
        let transactionParamIndex = 1;
        let totalTransactions = 0;

        blocks.forEach(block => {
            if (block.transactions && block.transactions.length > 0) {
                block.transactions.forEach(tx => {
                    // Type guard to ensure tx is an object
                    if (typeof tx === 'object' && tx !== null) {
                        const values: any[] = [
                            tx.hash,
                            parseInt(block.number, 16),
                            tx.transactionIndex ? parseInt(tx.transactionIndex, 16) : null,
                            tx.from.toLowerCase(),
                            tx.to ? tx.to.toLowerCase() : null,
                            BigInt(tx.value).toString(), // Convert hex value to decimal string
                            parseInt(tx.gas, 16),
                            BigInt(tx.gasPrice).toString(), // Convert hex gasPrice to decimal string
                            tx.input,
                            parseInt(tx.nonce, 16)
                        ];
                        const valuePlaceholders = values.map((_, i) => `$${transactionParamIndex + i}`).join(', ');
                        transactionValues.push(`(${valuePlaceholders})`);
                        transactionQueryParams.push(...values);
                        transactionParamIndex += values.length;
                        totalTransactions++;
                    }
                });
            }
        });

        if (transactionValues.length > 0) {
            const transactionQueryText = `
                INSERT INTO transactions (
                    tx_hash, block_number, tx_index, from_address, to_address, 
                    value, gas, gas_price, input_data, nonce
                )
                VALUES ${transactionValues.join(', ')}
                ON CONFLICT (tx_hash) DO NOTHING`;
            await client.query(transactionQueryText, transactionQueryParams);
             logger.trace(`Prepared insert for ${totalTransactions} transactions from ${blocks.length} blocks.`);
        } else {
            logger.trace(`No transactions to insert from ${blocks.length} blocks.`);
        }

        await client.query('COMMIT');
        const blockNumbers = blocks.map(b => parseInt(b.number, 16)).sort((a, b) => a - b);
        logger.debug(`Committed batch insert for blocks ${blockNumbers[0]} to ${blockNumbers[blockNumbers.length - 1]} (${blocks.length} blocks, ${totalTransactions} txns).`);
    } catch (error) {
        await client.query('ROLLBACK');
        const blockNumbers = blocks.map(b => parseInt(b.number, 16)).sort((a, b) => a - b);
        logger.error({ err: error, blockNumbers: `${blockNumbers[0]}-${blockNumbers[blockNumbers.length - 1]}` }, 'Error inserting block batch data, rolled back transaction');
        throw error; // Re-throw
    } finally {
        client.release();
    }
}

// Check if a block number exists in the database
export async function checkBlockExistsDB(blockNumber: number): Promise<boolean> {
    const client = await pool.connect();
    try {
        const result = await client.query('SELECT 1 FROM blocks WHERE block_number = $1 LIMIT 1;', [blockNumber]);
        return (result.rowCount ?? 0) > 0; // Use ?? 0 to handle potential null
    } catch (err) {
        logger.error({ err, blockNumber }, 'Error checking if block exists in DB');
        throw err; // Re-throw errors for caller to handle
    } finally {
        client.release();
    }
}

// Function to clear (truncate) database tables
export async function clearDatabaseTables(): Promise<void> {
    const client = await pool.connect();
    try {
        logger.warn('Clearing database tables (TRUNCATE)...');
        // Truncate tables - faster than DELETE and resets sequences if any
        // Use CASCADE if there are foreign key references from other tables not being truncated
        await client.query('TRUNCATE TABLE transactions RESTART IDENTITY CASCADE;'); // Clear transactions first due to FK
        await client.query('TRUNCATE TABLE blocks RESTART IDENTITY CASCADE;');
        logger.info('Database tables "transactions" and "blocks" truncated.');
    } catch (err) {
        logger.error({ err }, 'Error clearing database tables');
        throw err;
    } finally {
        client.release();
    }
}

// Function to gracefully close the pool
export async function closeDatabasePool(): Promise<void> {
    logger.info('Closing database connection pool...');
    await pool.end();
    logger.info('Database connection pool closed.');
}

// --- Query Functions (for API endpoints) ---

export async function getBlockByNumberDB(blockNumber: number): Promise<any | null> {
    try {
        const result = await pool.query('SELECT * FROM blocks WHERE block_number = $1', [blockNumber]);
        return result.rows.length > 0 ? result.rows[0] : null;
    } catch (err) {
        logger.error({ err, blockNumber }, 'Error querying block by number');
        throw err;
    }
}

export async function getTransactionByHashDB(txHash: string): Promise<any | null> {
     try {
        const result = await pool.query('SELECT * FROM transactions WHERE tx_hash = $1', [txHash]);
        return result.rows.length > 0 ? result.rows[0] : null;
    } catch (err) {
        logger.error({ err, txHash }, 'Error querying transaction by hash');
        throw err;
    }
}

export async function getTransactionsByAddressDB(address: string, page: number = 1, pageSize: number = 10): Promise<{ transactions: any[], total: number }> {
    const offset = (page - 1) * pageSize;
    const lowerCaseAddress = address.toLowerCase(); // Ensure case-insensitivity if needed
    
    try {
        // Query for the transactions page
        const txQuery = `
            SELECT * FROM transactions 
            WHERE lower(from_address) = $1 OR lower(to_address) = $1
            ORDER BY block_number DESC, tx_index DESC
            LIMIT $2 OFFSET $3;
        `;
        const txResult = await pool.query(txQuery, [lowerCaseAddress, pageSize, offset]);

        // Query for the total count
        const countQuery = `
            SELECT COUNT(*) FROM transactions
            WHERE lower(from_address) = $1 OR lower(to_address) = $1;
        `;
        const countResult = await pool.query(countQuery, [lowerCaseAddress]);
        const total = parseInt(countResult.rows[0].count, 10);

        return { transactions: txResult.rows, total };

    } catch (err) {
        logger.error({ err, address, page, pageSize }, 'Error querying transactions by address');
        throw err;
    }
}

// --- Statistics/Aggregation Functions (Refactored) ---

// Get aggregate stats (tx count, total value) within a specific time range (based on block timestamp)
export async function getStatsByTimeRangeDB(startTime: number, endTime: number): Promise<{ transactionCount: number; totalValueWei: string }> {
    try {
        // Use Common Table Expression (CTE) for clarity or join directly
        const query = `
            SELECT 
                COUNT(t.tx_hash) as tx_count,
                COALESCE(SUM(t.value::numeric), 0) as total_value
            FROM transactions t
            JOIN blocks b ON t.block_number = b.block_number
            WHERE b.timestamp >= $1 AND b.timestamp <= $2;
        `;
        const result = await pool.query(query, [startTime, endTime]);

        const row = result.rows[0];
        return {
            transactionCount: parseInt(row.tx_count, 10),
            totalValueWei: row.total_value.toString() // Ensure value is returned as string
        };
    } catch (err) {
        logger.error({ err, startTime, endTime }, 'Error querying stats by time range');
        throw err;
    }
}

// Get total unique accounts (from/to addresses) within a time range
export async function getTotalUniqueAccountsDB(startTime: number, endTime: number): Promise<number> {
    try {
        // Use UNION to get distinct addresses from both columns
        const query = `
            SELECT COUNT(DISTINCT address) 
            FROM (
                SELECT lower(from_address) as address 
                FROM transactions t
                JOIN blocks b ON t.block_number = b.block_number
                WHERE b.timestamp >= $1 AND b.timestamp <= $2
                UNION
                SELECT lower(to_address) as address 
                FROM transactions t
                JOIN blocks b ON t.block_number = b.block_number
                WHERE to_address IS NOT NULL
                AND b.timestamp >= $1 AND b.timestamp <= $2
            ) unique_addresses;
        `;
        const result = await pool.query(query, [startTime, endTime]);
        return parseInt(result.rows[0].count, 10);
    } catch (err) {
        logger.error({ err, startTime, endTime }, 'Error querying total unique accounts');
        throw err;
    }
}
