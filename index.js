
import fs from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { spawn } from 'child_process';
import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { Command } from 'commander';

const program = new Command();



const DB_PATH = path.resolve(process.cwd(), 'queue.db');
const PID_FILE = path.resolve(process.cwd(), 'queuectl.pids.json');
const LOG_FILE = path.resolve(process.cwd(), 'queuectl.log');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);


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

function getPendingJob(db) {
  const now = Date.now();
  const select = db.prepare(`
    SELECT id, command, attempts, max_retries 
    FROM jobs 
    WHERE state='pending' AND next_run <= ? 
    ORDER BY created_at 
    LIMIT 1
  `);
  const row = select.get(now);
  if (!row) return null;

  const tx = db.transaction((id) => {
    const r = db.prepare('SELECT state FROM jobs WHERE id=?').get(id);
    if (!r || r.state !== 'pending') return false;
    db.prepare('UPDATE jobs SET state=?, updated_at=? WHERE id=?')
      .run('processing', new Date().toISOString(), id);
    return true;
  });
  const ok = tx(row.id);
  if (!ok) return null;

  return db.prepare('SELECT * FROM jobs WHERE id=?').get(row.id);
}

function getConfig(db) {
  const rows = db.prepare('SELECT key, value FROM config').all();
  const cfg = {};
  for (const row of rows) {
    const val = Number(row.value);
    cfg[row.key] = isNaN(val) ? row.value : val;
  }
  return cfg;

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
let idleCycles = 0;
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
idleCycles++;
      if (idleCycles > 10) {  // ~2 seconds of no jobs (10 * 200ms)
        log('no more jobs — exiting');
        break;
      }
      await new Promise(r => setTimeout(r, 200));
      continue;
}

idleCycles=0;

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
        const max_retries = (job.max_retries !== undefined) ? job.max_retries : Number(cfg.default_max_retries || 3);

        const next_run=Date.now();

        db.prepare(`INSERT INTO jobs(id,command,state,attempts,max_retries,created_at,updated_at,next_run) VALUES(?,?,?,?,?,?,?,?)`).run(id,command,'pending',0,max_retries,now,now,next_run);
        console.log('enqueued',id);
        db.close();
    })
program
  .command('worker')
  .description('Worker management')
  .argument('<action>')
  .option('--count <n>', 'number of workers', '1')
  .action((action, opts) => {
    if (action === 'start') {
      const count = Number(opts.count || 1);
      const pids = [];
      for (let i = 0; i < count; i++) {
        const child = spawn(process.execPath, [__filename, 'worker', 'run'], {
          stdio: 'inherit',
        });
        pids.push(child.pid);
        console.log('worker started pid =', child.pid);
        log('started worker pid=' + child.pid);
      }
      // persist pids
      fs.writeFileSync(PID_FILE, JSON.stringify({ pids, started_at: Date.now() }));
    }

    else if (action === 'stop') {
      if (!fs.existsSync(PID_FILE)) {
        console.log('No PID file found.');
        return;
      }

      const data = JSON.parse(fs.readFileSync(PID_FILE, 'utf8'));
      if (!data.pids || !data.pids.length) {
        console.log('No worker PIDs found.');
        return;
      }

      for (const pid of data.pids) {
        try {
          // check if process exists before killing
          process.kill(pid, 0);
          process.kill(pid, 'SIGTERM');
          console.log(`Sent SIGTERM to worker ${pid}`);
        } catch (err) {
          if (err.code === 'ESRCH') {
            console.warn(`Worker ${pid} already stopped (no such process)`);
          } else {
            console.error(`Failed to kill ${pid}: ${err.message}`);
          }
        }
      }

      // remove PID file after attempting to stop all workers
      try {
        fs.unlinkSync(PID_FILE);
        console.log('PID file removed.');
      } catch (e) {
        console.warn('Could not remove PID file:', e.message);
      }
    }

    else if (action === 'run') {
      workerLoop().catch((e) => {
        log('worker error', e.message);
        process.exit(1);
      });
    }

    else {
      console.log('Unknown worker action. Use start|stop|run');
    }
  });


program
    .command('dlq')
    .description('DLQ operations')
    .argument('<action>')
    .argument('[jobId]')
    .action((action, jobId)=>{
    const db = openDB();
    if(action==='list'){
        const rows = db.prepare("SELECT * FROM jobs WHERE state='dead' ORDER BY updated_at").all();
        for(const r of rows) console.log(r.id, r.command, 'attempts='+r.attempts, r.last_error||'');
    } else if(action==='retry'){
        if(!jobId){ console.error('jobId required'); process.exit(1); }
        const now = Date.now();
        db.prepare("UPDATE jobs SET state='pending', attempts=0, next_run=?, updated_at=? WHERE id=?").run(now, new Date().toISOString(), jobId);
        console.log('retried',jobId);
    } else {
        console.log('unknown dlq action');
    }
db.close();
});

program
  .command('status')
  .description('Show current queue and worker status')
  .action(() => {
    const db = openDB();
    const total = db.prepare("SELECT COUNT(*) AS c FROM jobs").get().c;
    const pending = db.prepare("SELECT COUNT(*) AS c FROM jobs WHERE state='pending'").get().c;
    const processing = db.prepare("SELECT COUNT(*) AS c FROM jobs WHERE state='processing'").get().c;
    const completed = db.prepare("SELECT COUNT(*) AS c FROM jobs WHERE state='completed'").get().c;
    const dead = db.prepare("SELECT COUNT(*) AS c FROM jobs WHERE state='dead'").get().c;

    console.log('--- Queue Status ---');
    console.log('Total jobs:', total);
    console.log('Pending:', pending);
    console.log('Processing:', processing);
    console.log('Completed:', completed);
    console.log('Dead:', dead);

    if (fs.existsSync(PID_FILE)) {
      const data = JSON.parse(fs.readFileSync(PID_FILE, 'utf8'));
      console.log('\n--- Worker Status ---');
      console.log('Worker count:', data.pids?.length || 0);
      console.log('PIDs:', data.pids?.join(', ') || 'none');
    } else {
      console.log('\nNo workers currently running.');
    }

    db.close();
  });

program
.command('config')
.description('Get/set config')
.argument('<action>')
.argument('[key]')
.argument('[value]')
.action((action,key,value)=>{
const db = openDB();
if(action==='set'){
if(!key||value===undefined){ console.error('key value required'); process.exit(1); }
db.prepare('INSERT OR REPLACE INTO config(key,value) VALUES(?,?)').run(key,String(value));
console.log('set',key,value);
} else if(action==='get'){
const rows = db.prepare('SELECT key,value FROM config').all();
for(const r of rows) console.log(r.key, r.value);
} else {
console.log('unknown config action');
}
db.close();
});

program
  .command('list')
  .option('--state <state>', 'filter by state (pending, processing, completed, dead)', 'pending')
  .description('List jobs by state')
  .action((opts) => {
    const db = openDB();
    const rows = db
      .prepare('SELECT * FROM jobs WHERE state=? ORDER BY created_at DESC')
      .all(opts.state);

    if (rows.length === 0) {
      console.log(`No jobs found with state='${opts.state}'`);
    } else {
      for (const r of rows) {
        console.log(
          `${r.id} | ${r.command} | attempts=${r.attempts} | state=${r.state} | updated_at=${r.updated_at}`
        );
      }
    }
    db.close();
  });


program.parse(process.argv);