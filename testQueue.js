import { execSync } from "child_process";
import fs from "fs";

console.log("\nRunning queuectl test...\n");

// Clean DB if exists (cross-platform)
if (fs.existsSync("queue.db")) {
  fs.unlinkSync("queue.db");
  console.log("Deleted old queue.db");
}

// Enqueue one successful job
console.log("Enqueueing successful job...");
execSync('node index.js enqueue "{\\"command\\":\\"echo success\\"}"', { stdio: 'inherit' });

// Enqueue one failing job with max_retries=0 (goes straight to DLQ)
console.log("Enqueueing failing job (will go to DLQ)...");
execSync('node index.js enqueue "{\\"command\\":\\"exit 1\\", \\"max_retries\\":0}"', { stdio: 'inherit' });

// Run a single worker to process all jobs
console.log("\nRunning worker...");
execSync("node index.js worker run", { stdio: 'inherit' });

// Show DLQ contents
console.log("\nDLQ contents:");
execSync("node index.js dlq list", { stdio: 'inherit' });
