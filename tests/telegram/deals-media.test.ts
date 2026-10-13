import test from "node:test";
import assert from "node:assert/strict";
import { testDatabase } from "../helpers/sqlite.js";
import { createContext } from "../../src/application/context.js";
import { handleUpdate } from "../../src/application/update.js";
import { processDelivery } from "../../src/application/delivery.js";
import type { Env, QueueJob } from "../../src/runtime/bindings.js";

function fixture() {
  const h = testDatabase(), calls: {method:string;body:any}[] = [], jobs: QueueJob[] = [];
  let now = Date.now() + 100, failImage = false, actualPhoto = false, enforcePhotoType = false;
  const c = createContext({DB:h.db,TELEGRAM_BOT_TOKEN:"fixture",TELEGRAM_WEBHOOK_SECRET:"fixture",ITAD_API_KEY:"fixture",WORK_QUEUE:{sendBatch:async(items:any[])=>{jobs.push(...items.map(x=>x.body));}}} as unknown as Env, {
    now:()=>now,recordTiming:()=>{},fetcher:async(url,init)=>{
      const method=String(url).split("/").at(-1)!;
      calls.push({method,body:JSON.parse(String(init?.body))});
      if(failImage && ["sendPhoto","editMessageMedia"].includes(method)) return Response.json({ok:false,error_code:400,description:"Bad Request: failed to get HTTP URL content"},{status:400});
      if (enforcePhotoType && actualPhoto && method === "editMessageText") return Response.json({ok:false,error_code:400,description:"Bad Request: there is no text in the message to edit"},{status:400});
      if (["sendPhoto","editMessageMedia"].includes(method)) actualPhoto = true;
      return Response.json({ok:true,result:{message_id:42}});
    },
  });
  const rows=()=>h.sqlite.prepare("SELECT * FROM deliveries ORDER BY rowid").all() as any[];
  const buttons=(row:any)=>JSON.parse(row.reply_markup).inline_keyboard.flat() as any[];
  const command=()=>handleUpdate(c,{update_id:1,message:{message_id:1,text:"/deals",from:{id:7},chat:{id:7,type:"private"}}});
  const callback=(data:string,id=2,photo=true)=>handleUpdate(c,{update_id:id,callback_query:{id:"button",data,from:{id:7},message:{message_id:42,chat:{id:7},...(photo?{photo:[{file_id:"existing"}]}:{})} as any}});
  const seed=(image=true)=>c.giveaways.ingestGiveaways([0,1].map(i=>({id:"gift"+i,gameId:"g"+i,title:"Game "+i,slug:"g"+i,shop:"Epic Game Store",url:"https://store.epicgames.com/p/game-"+i,expiry:now+60000,description:"Descrizione del gioco "+i,imageUrl:image?"https://cdn.example.com/game-"+i+".jpg":null})),[],now,true);
  return {h,c,calls,jobs,rows,buttons,command,callback,seed,get now(){return now},advance(){now+=61000},fail(){failImage=true},recover(){failImage=false},modelPhotoType(){enforcePhotoType=true}};
}

test("/deals sends a cover with description and navigates every game in the same photo message", async(t)=>{
  const f=fixture();t.after(f.h.close);await f.seed();await f.command();
  await processDelivery(f.rows()[0].id,f.c,f.now);
  assert.equal(f.calls[0].method,"sendPhoto");
  assert.equal(f.calls[0].body.photo,"https://cdn.example.com/game-0.jpg");
  assert.match(f.calls[0].body.caption,/Descrizione del gioco 0/);
  const next=f.buttons(f.rows()[0]).find(x=>/Avanti/.test(x.text));assert.ok(next);
  await f.callback(next.callback_data);
  await processDelivery(f.rows()[1].id,f.c,f.now);
  const edit=f.calls.find(x=>x.method==="editMessageMedia");assert.ok(edit);
  assert.equal(edit.body.message_id,42);
  assert.equal(edit.body.media.media,"https://cdn.example.com/game-1.jpg");
  assert.match(edit.body.media.caption,/Descrizione del gioco 1/);
  assert.ok(f.buttons(f.rows()[1]).some(x=>/Indietro/.test(x.text)));
  assert.equal(f.calls.filter(x=>["sendMessage","sendPhoto"].includes(x.method)).length,1);
});

test("/deals without store artwork requests a large native preview for each selected game", async(t)=>{
  const f=fixture();t.after(f.h.close);await f.seed(false);await f.command();
  await processDelivery(f.rows()[0].id,f.c,f.now);
  assert.equal(f.calls[0].method,"sendMessage");
  assert.equal(f.calls[0].body.link_preview_options.is_disabled,false);
  assert.equal(f.calls[0].body.link_preview_options.url,"https://store.epicgames.com/p/game-0");
  const next=f.buttons(f.rows()[0]).find(x=>/Avanti/.test(x.text));assert.ok(next);
  await f.callback(next.callback_data,2,false);await processDelivery(f.rows()[1].id,f.c,f.now);
  const edit=f.calls.find(x=>x.method==="editMessageText");assert.ok(edit);
  assert.equal(edit.body.link_preview_options.url,"https://store.epicgames.com/p/game-1");
  assert.equal(edit.body.link_preview_options.is_disabled,false);
});

test("rejected /deals cover falls back to text with preview and keeps navigation", async(t)=>{
  const f=fixture();t.after(f.h.close);await f.seed();await f.command();f.fail();
  await processDelivery(f.rows()[0].id,f.c,f.now);
  assert.deepEqual(f.calls.map(x=>x.method),["sendPhoto","sendMessage"]);
  assert.equal(f.calls[1].body.link_preview_options.is_disabled,false);
  assert.ok(f.calls[1].body.reply_markup.inline_keyboard.flat().some((x:any)=>/Avanti/.test(x.text)));
});

test("expired photo gallery updates the caption and clears its navigation", async(t)=>{
  const f=fixture();t.after(f.h.close);await f.seed();await f.command();
  const next=f.buttons(f.rows()[0]).find(x=>/Avanti/.test(x.text));assert.ok(next);
  f.advance();await f.callback(next.callback_data);
  await processDelivery(f.rows()[1].id,f.c,f.now);
  const edit=f.calls.find(x=>x.method==="editMessageCaption");assert.ok(edit);
  assert.match(edit.body.caption,/scaduta/);
  assert.deepEqual(edit.body.reply_markup,{inline_keyboard:[]});
});

test("a rejected next cover replaces no photo with the wrong game's caption", async(t)=>{
  const f=fixture();t.after(f.h.close);await f.seed();await f.command();
  const next=f.buttons(f.rows()[0]).find(x=>/Avanti/.test(x.text));assert.ok(next);
  await f.callback(next.callback_data);f.fail();
  await processDelivery(f.rows()[1].id,f.c,f.now);
  assert.ok(f.calls.some(x=>x.method==="editMessageMedia"));
  assert.ok(!f.calls.some(x=>x.method==="editMessageCaption"));
  const fallback=f.jobs.find(x=>x.kind==="delivery");assert.ok(fallback && fallback.kind==="delivery");
  await processDelivery(fallback.id,f.c,f.now);
  const text=f.calls.find(x=>x.method==="sendMessage");assert.ok(text);
  assert.match(text.body.text,/Descrizione del gioco 1/);
  assert.equal(text.body.link_preview_options.is_disabled,false);
});


test("queued media fallback expires when newer navigation selects another game", async(t)=>{
  const f=fixture();t.after(f.h.close);await f.seed();await f.command();
  await f.callback(f.buttons(f.rows()[0]).find(x=>/Avanti/.test(x.text)).callback_data);f.fail();
  await processDelivery(f.rows()[1].id,f.c,f.now);
  const fallback=f.jobs.find(x=>x.kind==="delivery");assert.ok(fallback && fallback.kind==="delivery");
  await f.callback(f.buttons(f.rows()[1]).find(x=>/Indietro/.test(x.text)).callback_data,3);
  await processDelivery(fallback.id,f.c,f.now);
  assert.ok(!f.calls.some(x=>x.method==="sendMessage"));
  assert.equal(f.rows().find(x=>x.id===fallback.id).status,"expired");
});

test("stale text callback recovers if a previous edit has already converted the message to photo", async(t)=>{
  const f=fixture();t.after(f.h.close);f.modelPhotoType();await f.seed();await f.command();f.fail();
  await processDelivery(f.rows()[0].id,f.c,f.now);f.recover();
  await f.callback(f.buttons(f.rows()[0]).find(x=>/Avanti/.test(x.text)).callback_data,2,false);
  await processDelivery(f.rows()[1].id,f.c,f.now);f.fail();
  await f.callback(f.buttons(f.rows()[1]).find(x=>/Indietro/.test(x.text)).callback_data,3,false);
  const edit=f.rows()[2];await processDelivery(edit.id,f.c,f.now);
  assert.notEqual(f.rows().find(x=>x.id===edit.id).status,"blocked");
  const fallback=f.jobs.find(x=>x.kind==="delivery");assert.ok(fallback && fallback.kind==="delivery");
  await processDelivery(fallback.id,f.c,f.now);
  const sent=f.calls.filter(x=>x.method==="sendMessage").at(-1)!;
  assert.match(sent.body.text,/Descrizione del gioco 0/);
});


test("expired gallery clears photo controls even when callback still describes a text message", async(t)=>{
  const f=fixture();t.after(f.h.close);f.modelPhotoType();await f.seed();await f.command();f.fail();
  await processDelivery(f.rows()[0].id,f.c,f.now);f.recover();
  await f.callback(f.buttons(f.rows()[0]).find(x=>/Avanti/.test(x.text)).callback_data,2,false);
  await processDelivery(f.rows()[1].id,f.c,f.now);
  f.advance();await f.callback(f.buttons(f.rows()[1]).find(x=>/Indietro/.test(x.text)).callback_data,3,false);
  await processDelivery(f.rows()[2].id,f.c,f.now);
  const edited=f.calls.find(x=>x.method==="editMessageCaption");assert.ok(edited);
  assert.match(edited.body.caption,/scaduta/);
  assert.deepEqual(edited.body.reply_markup,{inline_keyboard:[]});
  assert.equal(f.rows()[2].status,"sent");
});
