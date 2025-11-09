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

function getConfig(db){
const now = Date.now();
// pick pending job with next_run <= now
const select = db.prepare(`SELECT id,command,attempts,max_retries FROM jobs WHERE state='pending' AND next_run<=? ORDER BY created_at LIMIT 1`);
const row = select.get(now);
if(!row) return null;
// try to atomically set it to processing only if still pending
const upd = db.prepare(`UPDATE jobs SET state='processing', updated_at=?, updated_at=updated_at WHERE id=? AND state='pending'`);
// Note: better-sqlite3 supports transaction
const tx = db.transaction((id)=>{
const r = db.prepare('SELECT state FROM jobs WHERE id=?').get(id);
if(!r || r.state!=='pending') return false;
db.prepare('UPDATE jobs SET state=? , updated_at=? WHERE id=?').run('processing', new Date().toISOString(), id);
return true;
});
const ok = tx(row.id);
if(!ok) return null;
// fetch updated row
const job = db.prepare('SELECT * FROM jobs WHERE id=?').get(row.id);
return job;
}


// Execute command and return exit code via promise
function execCommand(command){
return new Promise((resolve)=>{
const child = spawn(command, { shell: true, stdio: 'inherit' });
child.on('close', (code) => {
resolve(code);
});
child.on('error',(err)=>{
resolve(127);
});
});
}