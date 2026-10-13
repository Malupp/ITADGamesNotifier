import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync,readdirSync } from "node:fs";

test("private notification migration disables old groups and deals, preserving wishlist and queued channel giveaways", (t) => {
  const db=new DatabaseSync(":memory:");t.after(()=>db.close());
  const directory=new URL("../../migrations/",import.meta.url);
  for(const name of readdirSync(directory).filter(n=>n.endsWith(".sql") && n<"0010").sort()) db.exec(readFileSync(new URL(name,directory),"utf8"));
  db.exec(`INSERT INTO user_prefs(user_id) VALUES('7');
    INSERT INTO news_groups(chat_id,chat_type,enabled,updated_at) VALUES('-10','supergroup',1,100);
    INSERT INTO news_deliveries(id,chat_id,article_id,generation,due_at) VALUES('old-news','-10','a',1,100);
    INSERT INTO deliveries(id,kind,source,chat_id,text,due_at) VALUES
      ('old-deal','price','keydeal','-100','Deal',100),
      ('queued-gift','giveaway','itad','-100','Gift',100),
      ('group-reply','reply','itad','-10','Reply',100),
      ('wishlist-alert','price','itad','7','Wishlist',100);`);
  db.exec(readFileSync(new URL("0010_private_notifications.sql",directory),"utf8"));
  assert.equal(db.prepare("SELECT enabled FROM news_groups").get()!.enabled,0);
  assert.equal(db.prepare("SELECT status FROM news_deliveries").get()!.status,"expired");
  assert.equal(db.prepare("SELECT count(*) AS n FROM news_subscribers").get()!.n,0);
  assert.equal(db.prepare("SELECT recent_deals_enabled FROM private_users WHERE user_id='7'").get()!.recent_deals_enabled,0);
  assert.deepEqual(db.prepare("SELECT id,status FROM deliveries ORDER BY id").all().map(x=>[x.id,x.status]),[
    ["group-reply","expired"],["old-deal","expired"],["queued-gift","pending"],["wishlist-alert","pending"],
  ]);
});
