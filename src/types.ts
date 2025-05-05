// Basic structure based on common Ethereum JSON-RPC responses

export interface Transaction {
    hash: string;
    nonce: string; // hex
    blockHash: string | null; // hex, null when pending
    blockNumber: string | null; // hex, null when pending
    transactionIndex: string | null; // hex, null when pending
    from: string; // address hex
    to: string | null; // address hex, null for contract creation
    value: string; // hex of wei value
    gasPrice: string; // hex
    gas: string; // hex
    input: string; // hex
    // Add other fields as needed (v, r, s, type, chainId, etc.)
}

export interface Block {
    number: string; // hex
    hash: string; // hex
    parentHash: string; // hex
    nonce: string; // hex (block nonce, PoW)
    sha3Uncles: string; // hex
    logsBloom: string; // hex
    transactionsRoot: string; // hex
    stateRoot: string; // hex
    receiptsRoot: string; // hex
    miner: string; // address hex
    difficulty: string; // hex
    totalDifficulty: string; // hex
    extraData: string; // hex
    size: string; // hex
    gasLimit: string; // hex
    gasUsed: string; // hex
    timestamp: string; // hex (unix timestamp)
    transactions: string[] | Transaction[]; // Array of tx hashes or full tx objects
    uncles: string[]; // Array of uncle block hashes
    // Add other fields as needed (baseFeePerGas for EIP-1559)
}

export interface RpcResponse<T> {
    jsonrpc: '2.0';
    id: number | string;
    result?: T;
    error?: {
        code: number;
        message: string;
        data?: any;
    };
}
