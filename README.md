queuectl

queuectl is a CLI-based background job queue system built in Node.js with persistent storage in SQLite. It supports:

Enqueueing and managing background jobs

Running multiple worker processes

Automatic retries with exponential backoff

Dead Letter Queue (DLQ) for permanently failed jobs

Job priority queues

Metrics such as execution duration, average duration, and job logs

📦 Setup Instructions

Clone the repository

git clone <your-repo-url>
cd queuectl


Install dependencies

npm install


Run CLI commands

Example: Enqueue a job

node index.js enqueue '{"command":"echo hello","priority":1}'


Start workers (e.g., 2 workers)

node index.js worker start --count 2


Stop workers

node index.js worker stop

⚡ Usage Examples
1. Enqueue a job
node index.js enqueue '{"command":"sleep 2","priority":3}'


Output:

enqueued 5f7e1d2a-9b0c-4b6d-8f5e-123456789abc

2. Start worker(s)
node index.js worker start --count 2


Output:

worker started pid = 12345
worker started pid = 12346

3. Check status
node index.js status


Output:

--- Queue Status ---
Total jobs: 10
Pending: 4
Processing: 2
Completed: 4
Dead: 0
Average duration (ms) of completed jobs: 201.5

--- Worker Status ---
Worker count: 2
PIDs: 12345, 12346

4. Dead Letter Queue (DLQ)

List failed jobs:

node index.js dlq list


Retry a failed job:

node index.js dlq retry <jobId>

5. Job Configuration

Get configuration:

node index.js config get


Set max retries or backoff:

node index.js config set max-retries 5
node index.js config set backoff_base 3

🏗 Architecture Overview
Job Lifecycle

Pending: Job is waiting to be picked by a worker.

Processing: Job is currently executed by a worker.

Completed: Job executed successfully.

Failed: Job failed but can be retried.

Dead: Job failed after all retries and moved to DLQ.

Worker Logic

Workers claim one pending job at a time using atomic DB update to prevent duplicates.

Execution is done via Node.js child_process.spawn.

On failure, the job is retried with exponential backoff:
next_run = current_time + base^attempts

After exceeding max_retries, job moves to DLQ.

Metrics such as execution duration, exit code, and output are saved in the DB.

Priority Queues

Jobs with lower priority value are executed first.

ORDER BY priority ASC, created_at ASC ensures higher priority jobs are picked first.

Persistence

Job data is stored in SQLite (queue.db).

Worker PIDs are persisted to queuectl.pids.json.

⚖️ Assumptions & Trade-offs

SQLite chosen for simplicity; for production, a full-featured queue like RabbitMQ/Redis may be better.

Only basic retry backoff implemented; no distributed locking (assumes single machine).

Job output is saved as plain text; large logs may grow DB size.

Worker shutdown is graceful but may leave long-running jobs partially completed.

🧪 Testing Instructions

Basic Job Completion

node index.js enqueue '{"command":"echo test"}'
node index.js worker start
node index.js list --state completed


Failed Job Retries & DLQ

node index.js enqueue '{"command":"invalidcmd","max_retries":2}'


Check retries and eventual DLQ:

node index.js dlq list


Priority Jobs

node index.js enqueue '{"command":"echo low","priority":5}'
node index.js enqueue '{"command":"echo high","priority":1}'


Ensure high-priority job runs first.

Metrics & Output Logging

node index.js list --state completed


See duration and output fields populated.