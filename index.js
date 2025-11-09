const fs=require('fs');
const path=require('path');
const { spawn }=require('path');
const { program }=require('better-sqlite3');
const { v4: uuidv4 }=require('uuid'); 

const DB_PATH = path.resolve(process.cwd(), 'queue.db');
const PID_FILE = path.resolve(process.cwd(), 'queuectl.pids.json');
const LOG_FILE = path.resolve(process.cwd(), 'queuectl.log');


function log(...args){
const line = `[${new Date().toISOString()}] ` + args.map(a=>typeof a==='string'?a:JSON.stringify(a)).join(' ')+"\n";
fs.appendFileSync(LOG_FILE,line);
}


// Init DB
function openDB(){
const db = new Database(DB_PATH);
// PRAGMAs
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');


db.exec(`
CREATE TABLE IF NOT EXISTS jobs (
id TEXT PRIMARY KEY,
command TEXT NOT NULL,
state TEXT NOT NULL,
attempts INTEGER NOT NULL DEFAULT 0,
max_retries INTEGER NOT NULL DEFAULT 3,
created_at TEXT NOT NULL,
updated_at TEXT NOT NULL,
next_run INTEGER DEFAULT 0,
last_error TEXT DEFAULT NULL
);


CREATE TABLE IF NOT EXISTS config (
key TEXT PRIMARY KEY,
value TEXT
);


INSERT OR IGNORE INTO config(key,value) VALUES ('backoff_base','2');
INSERT OR IGNORE INTO config(key,value) VALUES ('default_max_retries','3');
`);
return db;
}