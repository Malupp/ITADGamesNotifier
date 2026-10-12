export interface NewsJob {
  id: string;
  feed_id: string;
  cycle_at: number;
  status: string;
  due_at: number;
  lease_token: string | null;
  lease_until: number | null;
  attempts: number;
}
export const NEWS_LEASE = 300000;
export class NewsJobs {
  constructor(private db: D1Database) {}
  async startCycle(feeds: string[], now: number) {
    const cycle = Math.floor(now / 1800000) * 1800000;
    await this.db
      .prepare(
        `INSERT OR IGNORE INTO news_jobs(id,feed_id,cycle_at,due_at)
      SELECT value || ':' || ?,value,?,? FROM json_each(?)`,
      )
      .bind(cycle, cycle, now, JSON.stringify(feeds))
      .run();
  }
  get(id: string) {
    return this.db
      .prepare("SELECT * FROM news_jobs WHERE id=?")
      .bind(id)
      .first<NewsJob>();
  }
  async dispatch(now: number) {
    const rows = await this.db
      .prepare(
        `UPDATE news_jobs SET enqueued_at=? WHERE id IN (
      SELECT id FROM news_jobs WHERE ((status='pending' AND due_at<=?) OR (status='processing' AND lease_until<=?))
      AND (enqueued_at IS NULL OR enqueued_at<=?) ORDER BY cycle_at LIMIT 20) RETURNING id`,
      )
      .bind(now, now, now, now - NEWS_LEASE)
      .all<{ id: string }>();
    return rows.results.map((x) => x.id);
  }
  async releaseDispatch(ids: string[], now: number) {
    await this.db
      .prepare(
        "UPDATE news_jobs SET enqueued_at=NULL WHERE id IN (SELECT value FROM json_each(?)) AND enqueued_at=?",
      )
      .bind(JSON.stringify(ids), now)
      .run();
  }
  claim(id: string, now: number) {
    return this.db
      .prepare(
        `UPDATE news_jobs SET status='processing',lease_token=?,lease_until=?,attempts=attempts+1
      WHERE id=? AND due_at<=? AND (status='pending' OR (status='processing' AND lease_until<=?))
      AND NOT EXISTS(SELECT 1 FROM news_jobs j WHERE j.feed_id=news_jobs.feed_id AND j.id!=news_jobs.id AND j.status='processing' AND j.lease_until>?)
      RETURNING *`,
      )
      .bind(crypto.randomUUID(), now + NEWS_LEASE, id, now, now, now)
      .first<NewsJob>();
  }
  async complete(id: string, token: string, now: number) {
    await this.db
      .prepare(
        "UPDATE news_jobs SET status='done',lease_until=NULL,lease_token=NULL WHERE id=? AND lease_token=? AND status='processing'",
      )
      .bind(id, token)
      .run();
  }
  async retry(id: string, token: string, due: number, error: string) {
    await this.db
      .prepare(
        "UPDATE news_jobs SET status='pending',due_at=?,last_error=?,enqueued_at=NULL,lease_until=NULL,lease_token=NULL WHERE id=? AND lease_token=? AND status='processing'",
      )
      .bind(due, error, id, token)
      .run();
  }
  async cycleSettled(cycle: number) {
    return !(await this.db
      .prepare(
        "SELECT 1 FROM news_jobs WHERE cycle_at=? AND (attempts=0 OR status='processing') LIMIT 1",
      )
      .bind(cycle)
      .first());
  }
}
