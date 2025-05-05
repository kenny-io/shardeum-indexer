import axios, { AxiosInstance, AxiosError } from 'axios';
import { config } from './config/config';
import { Block, RpcResponse } from './types';
import pino from 'pino';

const logger = pino({ level: config.logLevel });

const axiosInstance: AxiosInstance = axios.create({
    baseURL: config.jsonRpcUrl,
    headers: { 'Content-Type': 'application/json' },
    timeout: 10000, // 10 seconds timeout
});

async function makeRpcRequest<T>(method: string, params: any[]): Promise<T> {
    const payload = {
        jsonrpc: '2.0',
        method,
        params,
        id: 1, // Simple ID for requests
    };

    let retries = 0;
    while (retries <= config.rpcMaxRetries) {
        try {
            logger.trace({ method, params }, `Making RPC request (Attempt ${retries + 1})`);
            const response = await axiosInstance.post<RpcResponse<T>>('', payload);

            if (response.data.error) {
                logger.error({ err: response.data.error, method, params }, 'RPC Error received');
                throw new Error(`RPC Error (${response.data.error.code}): ${response.data.error.message}`);
            }

            if (response.data.result === undefined) {
                logger.warn({ method, params, response: response.data }, 'RPC returned undefined result');
                // Handle cases like block not found gracefully
                if (method === 'eth_getBlockByNumber' && response.data.result === null) {
                    // Explicitly return null for 'block not found'
                    return null as unknown as T;
                }
                throw new Error('RPC Error: Undefined result');
            }

            logger.trace({ method, params, result: response.data.result }, 'RPC request successful');
            return response.data.result;
        } catch (error) {
            const axiosError = error as AxiosError;
            logger.warn(
                { err: axiosError.message, method, params, attempt: retries + 1, maxRetries: config.rpcMaxRetries },
                'RPC request failed, retrying...' 
            );
            retries++;
            if (retries > config.rpcMaxRetries) {
                logger.error({ err: axiosError.message, method, params }, 'RPC request failed after max retries');
                throw error; // Re-throw after max retries
            }
            const delay = config.rpcRetryDelayMs * Math.pow(2, retries - 1); // Exponential backoff
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
    // Should not be reached if retries > 0, but satisfies TypeScript
    throw new Error(`RPC request ${method} failed definitively.`);
}

export async function getLatestBlockNumber(): Promise<number> {
    const result = await makeRpcRequest<string>('eth_blockNumber', []);
    return parseInt(result, 16);
}

export async function getBlockByNumber(blockNumber: number): Promise<Block | null> {
    const blockNumberHex = `0x${blockNumber.toString(16)}`;
    // Fetch full block with transaction objects
    return makeRpcRequest<Block | null>('eth_getBlockByNumber', [blockNumberHex, true]);
}