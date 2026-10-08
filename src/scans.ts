import { Store } from './store.js';
export type ScanTask =
  | { kind: 'giveaways'; offset: number; startedAt: number; baseline: boolean }
  | { kind: 'prices'; gameIds: string[]; quiet: boolean };
export class Scans {
  constructor(readonly db: D1Database) {}
  async start(kind: 'giveaways'|'prices', tasks: ScanTask[], baseline: boolean, now: number): Promise<void> {
    const id = `${kind}:${crypto.randomUUID()}`;
    await this.db.batch([
      this.db.prepare("UPDATE scan_runs SET status='abandoned' WHERE kind=? AND status='running' AND started_at<=?").bind(kind,now-25*60*1000),
      this.db.prepare("INSERT OR IGNORE INTO scan_runs(id,kind,started_at,baseline) VALUES(?,?,?,?)").bind(id,kind,now,Number(baseline)),
      this.db.prepare(`INSERT INTO scan_jobs(id,run_id,payload,due_at)
        SELECT ?||':'||key,?,value,? FROM json_each(?) WHERE EXISTS(SELECT 1 FROM scan_runs WHERE id=?)`)
        .bind(id,id,now,JSON.stringify(tasks),id),
    ]);
    if (!tasks.length) await this.finish(id,now);
  }
  async pending(now: number,limit=50): Promise<string[]> {
    const rows=await this.db.prepare(`SELECT j.id FROM scan_jobs j JOIN scan_runs r ON r.id=j.run_id
      WHERE r.status='running' AND j.due_at<=? AND (j.status='pending' OR (j.status='processing' AND j.lease_until<=?))
      ORDER BY r.started_at,j.id LIMIT ?`).bind(now,now,limit).all<{id:string}>();
    return rows.results.map(r=>r.id);
  }
  async dispatch(now:number,kind:'prices'|'giveaways'|null=null):Promise<string[]>{
    const rows=await this.db.prepare(`UPDATE scan_jobs SET enqueued_at=? WHERE id IN (
      SELECT j.id FROM scan_jobs j JOIN scan_runs r ON r.id=j.run_id WHERE r.status='running'
      AND (? IS NULL OR r.kind=?) AND j.due_at<=? AND (j.enqueued_at IS NULL OR j.enqueued_at<=?)
      AND (j.status='pending' OR (j.status='processing' AND j.lease_until<=?)) LIMIT 50) RETURNING id`)
      .bind(now,kind,kind,now,now-120000,now).all<{id:string}>();
    return rows.results.map(r=>r.id);
  }
  async releaseDispatch(ids:string[],now:number):Promise<void>{
    if(!ids.length)return;
    await this.db.prepare(`UPDATE scan_jobs SET enqueued_at=NULL WHERE status='pending' AND enqueued_at=?
      AND id IN (SELECT value FROM json_each(?))`).bind(now,JSON.stringify(ids)).run();
  }
  async claim(id:string,now:number):Promise<{task:ScanTask;token:string;runId:string;attempts:number}|null> {
    const row=await this.db.prepare(`UPDATE scan_jobs SET status='processing',lease_token=?,lease_until=?,attempts=attempts+1
      WHERE id=? AND due_at<=? AND (status='pending' OR (status='processing' AND lease_until<=?))
        AND EXISTS(SELECT 1 FROM scan_runs WHERE id=run_id AND status='running') RETURNING *`)
      .bind(crypto.randomUUID(),now+120000,id,now,now).first<any>();
    return row?{task:JSON.parse(row.payload),token:row.lease_token,runId:row.run_id,attempts:row.attempts}:null;
  }
  async successors(id:string,now:number):Promise<string[]>{
    const rows=await this.db.prepare(`SELECT j.id FROM scan_jobs j JOIN scan_runs r ON r.id=j.run_id
      WHERE j.run_id=(SELECT run_id FROM scan_jobs WHERE id=?) AND r.status='running' AND j.status='pending' AND j.due_at<=? LIMIT 50`).bind(id,now).all<{id:string}>();
    return rows.results.map(r=>r.id);
  }
  async complete(id:string,token:string,runId:string,now:number,next?:ScanTask):Promise<void> {
    const statements: D1PreparedStatement[]=[];
    if(next) statements.push(this.db.prepare(`INSERT INTO scan_jobs(id,run_id,payload,due_at)
      SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM scan_jobs WHERE id=? AND lease_token=? AND status='processing')
      ON CONFLICT(id) DO NOTHING`).bind(`${runId}:${next.kind==='giveaways'?next.offset:'next'}`,runId,JSON.stringify(next),now,id,token));
    statements.push(this.db.prepare("UPDATE scan_jobs SET status='done',lease_until=NULL WHERE id=? AND lease_token=? AND status='processing'").bind(id,token));
    await this.db.batch(statements);
    await this.finish(runId,now);
  }
  async finish(runId:string,now:number):Promise<void> {
    const finished=await this.db.prepare(`UPDATE scan_runs SET status='done',finished_at=? WHERE id=? AND status='running'
      AND NOT EXISTS(SELECT 1 FROM scan_jobs WHERE run_id=? AND status!='done') RETURNING kind,baseline`).bind(now,runId,runId).first<{kind:string;baseline:number}>();
    if(finished){const store=new Store(this.db);await store.setSetting(`last_${finished.kind==='prices'?'price':'giveaway'}_scan`,String(now),now);
      if(finished.baseline)await store.setSetting(`${finished.kind}_seeded`,'true',now);}
  }
  async retry(id:string,token:string,dueAt:number):Promise<void>{
    await this.db.prepare("UPDATE scan_jobs SET status='pending',lease_until=NULL,due_at=? WHERE id=? AND lease_token=? AND status='processing'").bind(dueAt,id,token).run();
  }
}
