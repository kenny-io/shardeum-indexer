# Shardeum Transaction Indexer

A robust Ethereum transaction indexer that processes and stores blockchain data, providing a rich set of APIs for querying historical metrics and transaction data.

## Features

- Real-time blockchain data indexing
- Historical metrics and analytics
- RESTful API endpoints for data access
- Support for both forward and backward indexing
- Efficient batch processing
- PostgreSQL database backend
- Configurable time ranges for metrics

## Prerequisites

- Node.js (v14 or higher)
- PostgreSQL database
- Access to an Ethereum node (JSON-RPC endpoint)

## Configuration

The indexer can be configured using environment variables:

```env
JSON_RPC_URL=http://localhost:8545
START_BLOCK=0
POLL_INTERVAL_MS=5000
BLOCK_DATA_DIR=./data/blocks
STATE_FILE_PATH=./data/indexer_state.json
RPC_MAX_RETRIES=5
RPC_RETRY_DELAY_MS=1000
LOG_LEVEL=info
STATUS_SERVER_PORT=3001
DATABASE_URL=postgresql://user:password@host:port/database
CLEAR_DATA_ON_START=false
BACKWARD_SYNC_BATCH_SIZE=10
```

## API Endpoints

All endpoints support the following time ranges:
- `1h`: Last hour
- `1d`: Last 24 hours
- `7d`: Last 7 days
- `1m`: Last 1 month
- `all`: All available data

### Indexer Status

Get the current status of the indexer, including forward and backward sync progress.

```http
GET /status
```

Response:
```json
{
  "status": "running",
  "latestBlockOnChain": 12345678,
  "currentForwardHead": 12345670,
  "currentBackwardHead": 12345600,
  "backfill": {
    "complete": false,
    "active": true,
    "blocksProcessed": 1000,
    "blocksRemaining": 500,
    "percentageComplete": 66.67,
    "startTime": 1678900000,
    "elapsedTimeMs": 3600000,
    "elapsedTimeFormatted": "1h 0m 0s",
    "blocksPerSecond": 0.28,
    "estimatedTimeRemainingMs": 1800000,
    "estimatedTimeRemainingFormatted": "30m 0s",
    "etaTimestamp": "2024-03-15T12:00:00.000Z"
  },
  "config": {
    "startBlock": 0,
    "pollIntervalMs": 5000,
    "clearDataOnStart": false
  }
}
```

### Transaction Count

Get the number of transactions in a time range.

```http
GET /transactions/count?range=1d
GET /transactions/count?range=all
```

Response:
```json
{
  "range": "1d",
  "interval": "1 day",
  "count": 150000
}
```

### Transaction Value

Get the total value transferred in a time range.

```http
GET /value?range=7d
GET /value?range=all
```

Response:
```json
{
  "range": "7d",
  "interval": "7 days",
  "totalValue": "1000000000000000000"
}
```

### Gas Usage

Get gas usage statistics for a time range.

```http
GET /gas?range=1d
GET /gas?range=all
```

Response:
```json
{
  "range": "1d",
  "interval": "1 day",
  "totalGasUsed": 1500000000,
  "averageGasPerBlock": 15000000,
  "totalBlocks": 100
}
```

### Transaction Types

Get the distribution of transaction types in a time range. For contract interactions, the input data is decoded as UTF-8 and parsed as JSON. If the JSON contains an `internalTXType` field:
- `6` → `stake`
- `7` → `unstake`
- any other value → `other_contract_interaction`
If the input data is not JSON or does not contain `internalTXType`, it is classified as `contract_interaction`.

```http
GET /transactions/types?range=7d
GET /transactions/types?range=all
```

Example response:
```json
{
  "range": "7d",
  "interval": "7 days",
  "distribution": {
    "transfer": 1000,
    "stake": 120,
    "unstake": 30,
    "other_contract_interaction": 15,
    "contract_interaction": 50
  }
}
```

### Top Accounts

Get the top accounts by net value in a time range.

```http
GET /accounts/top?range=1d&limit=20
GET /accounts/top?range=all&limit=20
```

Response:
```json
{
  "range": "1d",
  "interval": "1 day",
  "topAccounts": [
    {
      "address": "0x123...",
      "netValue": "1000000000000000000"
    },
    // ... more accounts
  ]
}
```

### Top Accounts (All-Time)

Get the top accounts by net value for all time (no time filter).

```http
GET /accounts/top-alltime?limit=20
```

Response:
```json
{
  "topAccounts": [
    {
      "address": "0x123...",
      "netValue": "1000000000000000000"
    },
    // ... more accounts
  ]
}
```
- `limit` (optional): Number of top accounts to return (default: 10)

### Block Metrics

Get block production statistics for a time range.

```http
GET /blocks/metrics?range=1h
GET /blocks/metrics?range=all
```

Response:
```json
{
  "range": "1h",
  "interval": "1 hour",
  "totalBlocks": 7200,
  "uniqueMiners": 50,
  "averageTransactionsPerBlock": 150,
  "averageBlockTime": 12.5,
  "timeRange": {
    "start": 1678900000,
    "end": 1678986400
  }
}
```

### Transaction Details

Get details for a specific transaction.

```http
GET /transactions/0x123...
```

Response:
```json
{
  "tx_hash": "0x123...",
  "block_number": 12345678,
  "tx_index": 0,
  "from_address": "0xabc...",
  "to_address": "0xdef...",
  "value": "1000000000000000000",
  "gas": 21000,
  "gas_price": "20000000000",
  "input_data": "0x",
  "nonce": 0
}
```

### Address Transactions

Get transactions for a specific address.

```http
GET /addresses/0x123.../transactions
```

Response:
```json
{
  "address": "0x123...",
  "transactions": [
    {
      "tx_hash": "0xabc...",
      "block_number": 12345678,
      // ... transaction details
    },
    // ... more transactions
  ]
}
```

### Block Details

Get details for a specific block.

```http
GET /blocks/12345678
```

Response:
```json
{
  "block_number": 12345678,
  "block_hash": "0x123...",
  "parent_hash": "0xabc...",
  "timestamp": 1678900000,
  "miner": "0xdef...",
  "gas_used": 15000000,
  "gas_limit": 30000000,
  "size": 1000,
  "transaction_count": 150
}
```

### Time-Range Statistics

Get comprehensive statistics for a time range.

```http
GET /stats?range=24h
GET /stats?range=all
```

Response:
```json
{
  "range": "24h",
  "startTime": 1678900000,
  "endTime": 1678986400,
  "totalTransactions": 150000,
  "totalValue": "1000000000000000000",
  "totalGasUsed": 1500000000,
  "uniqueAddresses": 50000
}
```

### Unique Account Count

Get the total number of unique accounts in the indexer.

```http
GET /stats/accounts/unique-count
```

Response:
```json
{
  "uniqueAccountCount": 12345
}
```

## Error Responses

All endpoints return standard HTTP status codes and error messages in the following format:

```json
{
  "error": "Error message description"
}
```

Common status codes:
- `200`: Success
- `400`: Invalid request parameters
- `404`: Resource not found
- `500`: Internal server error

## Development

1. Clone the repository
2. Install dependencies:
   ```bash
   npm install
   ```
3. Set up environment variables
4. Start the indexer:
   ```bash
   npm start
   ```

## Deployment Guide

### Prerequisites

1. Google Cloud Platform (GCP) account
2. Google Cloud SDK installed
3. Docker installed
4. Node.js and npm installed

### Local Development Setup

1. Clone the repository:
   ```bash
   git clone <repository-url>
   cd transaction-indexer
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Set up environment variables:
   ```bash
   cp .env.example .env
   # Edit .env with your configuration
   ```

4. Start the application locally:
   ```bash
   npm start
   ```

### Docker Local Testing

1. Build and run using Docker Compose:
   ```bash
   docker-compose up --build
   ```

2. Access the API at `http://localhost:3000`

### GCP Deployment

#### 1. Initial Setup

1. Create a new GCP project:
   ```bash
   gcloud projects create [PROJECT_ID]
   gcloud config set project [PROJECT_ID]
   ```

2. Enable required APIs:
   ```bash
   gcloud services enable \
     cloudbuild.googleapis.com \
     run.googleapis.com \
     containerregistry.googleapis.com
   ```

3. Create a Cloud SQL instance for PostgreSQL:
   ```bash
   gcloud sql instances create transaction-indexer-db \
     --database-version=POSTGRES_15 \
     --tier=db-f1-micro \
     --region=us-central1
   ```

4. Create a database:
   ```bash
   gcloud sql databases create indexer --instance=transaction-indexer-db
   ```

5. Create a database user:
   ```bash
   gcloud sql users create indexer \
     --instance=transaction-indexer-db \
     --password=[PASSWORD]
   ```

#### 2. Configure Cloud Build

1. Set up Cloud Build trigger:
   ```bash
   gcloud builds triggers create github \
     --repo-name=[REPO_NAME] \
     --branch-pattern="^main$" \
     --build-config=cloudbuild.yaml
   ```

2. Set up Cloud Build variables:
   ```bash
   gcloud builds triggers update [TRIGGER_ID] \
     --substitutions=_DATABASE_URL="postgresql://indexer:[PASSWORD]@/indexer?host=/cloudsql/[PROJECT_ID]:us-central1:transaction-indexer-db"
   ```

#### 3. Deploy to Cloud Run

1. Build and push the container:
   ```bash
   gcloud builds submit --config cloudbuild.yaml
   ```

2. Deploy to Cloud Run:
   ```bash
   gcloud run deploy transaction-indexer \
     --image gcr.io/[PROJECT_ID]/transaction-indexer \
     --platform managed \
     --region us-central1 \
     --allow-unauthenticated \
     --set-env-vars="DATABASE_URL=[DATABASE_URL],LOG_LEVEL=info,START_BLOCK=0,POLL_INTERVAL_MS=1000,CLEAR_DATA_ON_START=false,STATUS_SERVER_PORT=3000"
   ```

#### 4. Monitoring and Maintenance

1. View logs:
   ```bash
   gcloud logging read "resource.type=cloud_run_revision AND resource.labels.service_name=transaction-indexer"
   ```

2. Monitor metrics in Cloud Console:
   - Navigate to Cloud Run > transaction-indexer
   - View metrics, logs, and revisions

3. Scale the service:
   ```bash
   gcloud run services update transaction-indexer \
     --min-instances=1 \
     --max-instances=10
   ```

### Production Considerations

1. **Database Backup**
   - Set up automated backups for Cloud SQL
   - Configure backup retention period
   - Test restore procedures

2. **Security**
   - Use Secret Manager for sensitive data
   - Enable VPC Service Controls
   - Configure IAM roles and permissions
   - Enable Cloud Audit Logs

3. **Monitoring**
   - Set up Cloud Monitoring alerts
   - Configure uptime checks
   - Monitor resource usage

4. **Scaling**
   - Configure auto-scaling based on load
   - Set appropriate resource limits
   - Monitor performance metrics

5. **Cost Optimization**
   - Use appropriate machine types
   - Monitor resource usage
   - Set up budget alerts

### Troubleshooting

1. **Database Connection Issues**
   - Verify database credentials
   - Check network connectivity
   - Review Cloud SQL logs

2. **Deployment Failures**
   - Check Cloud Build logs
   - Verify environment variables
   - Review container logs

3. **Performance Issues**
   - Monitor resource usage
   - Check database performance
   - Review application logs

For more detailed information about any of these steps, refer to the [GCP documentation](https://cloud.google.com/docs).

## License

MIT 

## Running Multiple Environments (Testnet & Mainnet)

This project supports running separate indexers for testnet and mainnet, each with its own configuration and database. This is achieved using separate Docker Compose files and environment files.

### 1. Environment Files

- `.env.testnet` — configuration for testnet (uses `https://api-testnet.shardeum.org`)
- `.env.mainnet` — configuration for mainnet (uses `https://api.shardeum.org`)

Each file sets its own `DATABASE_URL` and other environment variables.

### 2. Docker Compose Files

- `docker-compose.testnet.yml` — runs the testnet indexer and a dedicated Postgres instance
- `docker-compose.mainnet.yml` — runs the mainnet indexer and a dedicated Postgres instance

### 3. How to Run

**Testnet:**
```bash
docker-compose -f docker-compose.testnet.yml up --build
```
- API available at [http://localhost:3001](http://localhost:3001)
- Database on port 5433

**Mainnet:**
```bash
docker-compose -f docker-compose.mainnet.yml up --build
```
- API available at [http://localhost:3002](http://localhost:3002)
- Database on port 5434

**You can run both at the same time** since they use different ports and database volumes.

### 4. Customization
- Edit `.env.testnet` and `.env.mainnet` to adjust settings for each environment.
- You can further customize the compose files for scaling, resource limits, etc. 