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

// Worker loop (single worker process)
async function workerLoop(){
const db = openDB();
const cfg = getConfig(db);
log('worker starting');
let shuttingDown = false;
process.on('SIGTERM', ()=>{ log('worker SIGTERM'); shuttingDown=true; });
process.on('SIGINT', ()=>{ log('worker SIGINT'); shuttingDown=true; });


while(true){
if(shuttingDown){ log('worker shutting down gracefully'); break; }
let job = null;
try{
const tx = db.transaction(()=>{
const now = Date.now();
// select id where pending and next_run <= now
const row = db.prepare(`SELECT id FROM jobs WHERE state='pending' AND next_run<=? ORDER BY created_at LIMIT 1`).get(now);
if(!row) return null;
// try to claim
const ok = db.prepare(`UPDATE jobs SET state='processing', updated_at=? WHERE id=? AND state='pending'`).run(new Date().toISOString(), row.id);
if(ok.changes===0) return null;
return db.prepare('SELECT * FROM jobs WHERE id=?').get(row.id);
});
job = tx();
}catch(err){
log('claim error',err.message);
}


if(!job){
// sleep a bit
await new Promise(r=>setTimeout(r,200));
continue;
}


log('processing', job.id, job.command);
const code = await execCommand(job.command);
const now = new Date().toISOString();
if(code===0){
db.prepare('UPDATE jobs SET state=?, updated_at=? WHERE id=?').run('completed', now, job.id);
log('completed',job.id);
} else {
// failure: increment attempts
const attempts = job.attempts + 1;
const max_retries = job.max_retries;
if(attempts>max_retries){
db.prepare('UPDATE jobs SET state=?, attempts=?, updated_at=?, last_error=? WHERE id=?').run('dead', attempts, now, `exit(${code})`, job.id);
log('moved to DLQ', job.id);
} else {
// compute backoff delay = base ^ attempts seconds
const base = cfg.backoff_base || 2;
const delaySec = Math.pow(base, attempts);
const nextRun = Date.now() + Math.floor(delaySec*1000);
db.prepare('UPDATE jobs SET attempts=?, state=?, next_run=?, updated_at=?, last_error=? WHERE id=?').run(attempts, 'pending', nextRun, now, `exit(${code})`, job.id);
log('retry scheduled', job.id, 'in', delaySec, 's');
}
}
}
db.close();
}
//CLI commands

program 
    .name('queuectl')
    .description('CLI background job queue controller')
    .version('0.1.0')


program
    .command('enqueue')
    .argument('<jobJson>')
    .description('Enqueu a new job (JSON string)')
    .action((jobJson)=>{

        const db=openDB();
        const cfg=getConfig(db);
        let job;
        try{job =JSON.parse(jobJson);} catch(e){console.error('Invalid JSON'); process.exit(1);}
        const id =job.id || uuidv4();
        const command=job.command;
        if(!command){console.error('command required'); process.exit(1);}
        const now =new Date().toISOString();
        const max_retires=(job.max_retires!==undefined)?job.max_retires:cfg.default_max_retires;
        const next_run=Date.now();

        db.prepare(`INSERT INTO jobs(id,command,state,attempts,max_retries,created_at,updated_at,next_run) VALUES(?,?,?,?,?,?,?,?)`).run(id,command,'pending',0,max_retries,now,now,next_run);
        console.log('enqueued',id);
        db.close();
    })