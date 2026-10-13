import test from "node:test";
import assert from "node:assert/strict";
import { testDatabase } from "../helpers/sqlite.js";
import { createContext } from "../../src/application/context.js";
import { handleUpdate } from "../../src/application/update.js";
import { processNewsDelivery } from "../../src/application/news.js";
import { NewsFeedClient } from "../../src/infrastructure/news/client.js";
import { NEWS_FEEDS } from "../../src/infrastructure/news/sources.js";
import { confirmOfficialGiveaways } from "../../src/infrastructure/stores/verification.js";
import { formatGiveaway, formatNews } from "../../src/telegram/formatters.js";
import { TelegramClient } from "../../src/infrastructure/telegram/client.js";
import { ApiError } from "../../src/infrastructure/http.js";
import { processDelivery } from "../../src/application/delivery.js";
import { revalidateKeyDelivery } from "../../src/application/keys.js";
import type { Env } from "../../src/runtime/bindings.js";

function fixture() {
  const h = testDatabase();
  let time = Date.parse("2026-10-12T12:00:00Z"), update = 1, photoStatus = 200;
  const calls: {method: string; body: any}[] = [];
  const c = createContext({ DB: h.db, NEWS_ENABLED: "true", SCANS_ENABLED: "true", TELEGRAM_BOT_TOKEN: "fake", ITAD_API_KEY: "fake" } as Env, {
    now: () => time, recordTiming: () => {},
    fetcher: async (url, init) => {
      const method = String(url).split("/").at(-1)!;
      const body = JSON.parse(String(init?.body));
      calls.push({method, body});
      const status = method === "sendPhoto" ? photoStatus : 200;
      return Response.json(status === 200 ? {ok:true,result:true} : {ok:false,error_code:status}, {status});
    },
  });
  const command = (text: string, user = 7, chat = user, type = "private") => handleUpdate(c, {
    update_id: update++, message: {message_id: 1, from: {id:user}, chat: {id:chat,type}, text},
  }, time);
  const toggle = (data: string, user = 7, chat = user) => handleUpdate(c, {
    update_id: update++, callback_query: {id:"toggle", from:{id:user}, data, message:{message_id:1,chat:{id:chat}}},
  }, time);
  return {h,c,calls,command,toggle,get time(){return time}, advance(){time+=1000}, set photoStatus(value: number){photoStatus=value}};
}

test("private news are opt-in and group commands cannot activate or send replies", async (t) => {
  const f = fixture(); t.after(f.h.close);
  await f.command("/start");
  await f.command("/news on", 7, -10, "supergroup");
  assert.equal(f.h.sqlite.prepare("SELECT count(*) AS n FROM deliveries WHERE chat_id='-10'").get()!.n, 0);
  await f.command("/news on");
  const active = await f.c.news.activeSubscribers();
  assert.deepEqual(active.map((x: any) => x.chat_id), ["7"]);
  await f.command("/news off",8);
  assert.equal((await f.c.news.subscriber("7")).enabled,1);
});

test("private use registers a recipient with recent-deal notifications off; foreign and stale buttons cannot enable them", async (t) => {
  const f = fixture(); t.after(f.h.close);
  await f.command("/start");
  assert.deepEqual(await f.c.preferences.recentDealTargets(), []);
  await f.toggle("recent|on|0",7,-10);
  assert.deepEqual(await f.c.preferences.recentDealTargets(), []);
  await f.toggle("recent|on|0");
  assert.deepEqual(await f.c.preferences.recentDealTargets(), ["7"]);
  await f.toggle("recent|off|1");
  await f.toggle("recent|on|0");
  assert.deepEqual(await f.c.preferences.recentDealTargets(), []);
  await f.command("/news on");
  assert.equal((await f.c.news.subscriber("7")).enabled,1);
  assert.deepEqual(await f.c.preferences.recentDealTargets(), []);
});

test("recent bargains queue only for opted-in private users and shutdown invalidates a claimed delivery", async (t) => {
  const f = fixture(); t.after(f.h.close);
  await f.command("/start"); await f.toggle("recent|on|0"); await f.command("/start",8);
  await f.c.keys.map("game","Nuovo gioco",123,f.time,2026);
  const price = {appId:123,title:"Nuovo gioco",keyCents:1000,retailCents:4000,regularCents:6000,historicalKeyCents:null,historicalRetailCents:null,url:"https://gg.deals/game/new/"};
  await f.c.keys.observe("game",price,4000,f.time,false,["7","8","-10"]);
  const rows = f.h.sqlite.prepare("SELECT * FROM deliveries WHERE source='keydeal'").all();
  assert.deepEqual(rows.map(x=>x.chat_id),["7"]);
  const claimed = await f.c.deliveries.claimDelivery(String(rows[0].id),f.time); assert.ok(claimed);
  await f.toggle("recent|off|1");
  assert.equal(f.h.sqlite.prepare("SELECT status FROM deliveries WHERE source='keydeal'").get()!.status,"expired");
  await f.toggle("recent|on|2");
  assert.equal(await f.c.deliveries.claimDelivery(claimed.id,f.time),null);
});

test("RSS descriptions and media are sanitized and retained, including HTML image fallback", async () => {
  const now=Date.parse("2026-10-12T12:00:00Z");
  for (const extra of ['<media:content url="https://cdn.example.com/game.jpg" medium="image"/>', '']) {
    const xml=`<rss xmlns:media="http://search.yahoo.com/mrss/"><channel><item><title>Nuovo gioco</title><link>https://multiplayer.it/notizie/game.html</link><pubDate>${new Date(now-1000).toUTCString()}</pubDate><description><![CDATA[<p>Una nuova <b>avventura</b> &amp; novità.</p><script>bad()</script><img src="https://cdn.example.com/game.jpg">]]></description>${extra}</item></channel></rss>`;
    const result=await new NewsFeedClient(async()=>new Response(xml)).load(NEWS_FEEDS[0],now);
    assert.equal(result.articles[0].summary,"Una nuova avventura & novità.");
    assert.equal(result.articles[0].imageUrl,"https://cdn.example.com/game.jpg");
  }
});

test("official free-game metadata provides a description and cover for the expanded notification", async () => {
  const offers=await confirmOfficialGiveaways([{id:"steam:123",gameId:"game",slug:"game",title:"Game",shop:"Steam",url:"https://store.steampowered.com/app/123/",expiry:null}],async()=>Response.json({123:{success:true,data:{type:"game",is_free:false,short_description:"<b>Un'avventura</b> da scoprire.",header_image:"https://cdn.example.com/game.jpg",genres:[{description:"Avventura"}],price_overview:{currency:"EUR",final:0,initial:3000,discount_percent:100}}}}));
  assert.equal(offers[0].description,"Un'avventura da scoprire.");
  assert.equal(offers[0].imageUrl,"https://cdn.example.com/game.jpg");
  assert.match(formatGiveaway(offers[0]),/da scoprire/);
});

test("news send a real photo and rich caption; off invalidates pending articles", async (t) => {
  const f=fixture();t.after(f.h.close);await f.command("/news on");
  const article={id:"a",publisher:"multiplayer",sourceName:"Multiplayer.it",topic:"games" as const,title:"Nuovo gioco",url:"https://multiplayer.it/notizie/a",publishedAt:f.time+1,summary:"Una nuova avventura per PC.",imageUrl:"https://cdn.example.com/game.jpg"};
  await f.c.news.ingest("multiplayer",{articles:[],notModified:false},f.time);
  f.advance();await f.c.news.ingest("multiplayer",{articles:[article],notModified:false},f.time);
  await f.c.news.queueForSubscribers(f.time);
  const row=f.h.sqlite.prepare("SELECT id FROM news_deliveries").get()!;
  await processNewsDelivery(String(row.id),f.c,f.time);
  const photo=f.calls.find(x=>x.method==="sendPhoto");assert.ok(photo);
  assert.equal(photo.body.photo,article.imageUrl);assert.match(photo.body.caption,/Una nuova avventura/);
  assert.match(photo.body.caption,/Multiplayer/);
  await f.command("/news off");
  assert.equal((await f.c.news.subscriber("7")).enabled,0);
});

test("a failed news image retries as text and each Telegram call consumes hourly budget", async (t) => {
  const f=fixture();t.after(f.h.close);await f.command("/news on");
  await f.c.news.ingest("multiplayer",{articles:[],notModified:false},f.time);
  f.advance();await f.c.news.ingest("multiplayer",{notModified:false,articles:[{id:"a",publisher:"multiplayer",sourceName:"Multiplayer.it",topic:"games",title:"News",url:"https://multiplayer.it/notizie/a",publishedAt:f.time,summary:"Descrizione",imageUrl:"https://cdn.example.com/game.jpg"} as any]},f.time);
  await f.c.news.queueForSubscribers(f.time);
  const id=String(f.h.sqlite.prepare("SELECT id FROM news_deliveries").get()!.id);
  f.photoStatus=400; assert.equal(await processNewsDelivery(id,f.c,f.time),1);
  f.advance();await processNewsDelivery(id,f.c,f.time);
  assert.deepEqual(f.calls.filter(x=>["sendPhoto","sendMessage"].includes(x.method)).map(x=>x.method),["sendPhoto","sendMessage"]);
  assert.equal(f.h.sqlite.prepare("SELECT count(*) AS n FROM news_send_attempts").get()!.n,2);
  assert.equal(f.h.sqlite.prepare("SELECT status FROM news_deliveries").get()!.status,"sent");
});

test("blocked private subscribers expire pending news without consuming a send attempt", async (t) => {
  const f=fixture();t.after(f.h.close);await f.command("/news on");
  await f.c.news.ingest("feed",{articles:[],notModified:false},f.time);
  f.advance();await f.c.news.ingest("feed",{articles:[{id:"a",publisher:"test",sourceName:"Test",topic:"games",title:"News",url:"https://multiplayer.it/a",publishedAt:f.time}],notModified:false},f.time);
  await f.c.news.queueForSubscribers(f.time);
  const id=String(f.h.sqlite.prepare("SELECT id FROM news_deliveries").get()!.id);
  f.h.sqlite.prepare("INSERT INTO blocked_chats(chat_id,blocked_at) VALUES('7',?)").run(f.time);
  await processNewsDelivery(id,f.c,f.time);
  assert.equal(f.h.sqlite.prepare("SELECT status FROM news_deliveries").get()!.status,"expired");
  assert.equal(f.calls.length,0);
  assert.equal(f.h.sqlite.prepare("SELECT count(*) AS n FROM news_send_attempts").get()!.n,0);
});

test("switching news in the notifications panel retains both independent controls", async (t) => {
  const f=fixture();t.after(f.h.close);await f.command("/notifiche");
  await f.toggle("news|on|0");
  const reply=f.h.sqlite.prepare("SELECT reply_markup FROM deliveries ORDER BY rowid DESC LIMIT 1").get()!;
  const buttons=JSON.parse(String(reply.reply_markup)).inline_keyboard.flat();
  assert.ok(buttons.some((x:any)=>x.callback_data.startsWith("news|off|")));
  assert.ok(buttons.some((x:any)=>x.callback_data.startsWith("recent|on|")));
});

test("general-deal shutdown during external price validation prevents delivery", async (t) => {
  const f=fixture();t.after(f.h.close);await f.command("/start");await f.toggle("recent|on|0");
  await f.c.keys.map("g","Game",123,f.time,2026);
  const p={appId:123,title:"Game",keyCents:1000,regularCents:6000,retailCents:4000,historicalKeyCents:null,historicalRetailCents:null,url:"https://gg.deals/game/g/"};
  await f.c.keys.observe("g",p,4000,f.time,false,["7"]);
  const [id]=await f.c.deliveries.pendingDeliveries(f.time);
  const delivery=await f.c.deliveries.claimDelivery(id,f.time);assert.ok(delivery);
  f.c.gg.getPrices=async()=>{await f.toggle("recent|off|1");return new Map([[123,p]]);};
  f.c.itad.getPrices=async()=>new Map([["g",[{gameId:"g",shop:"Steam",shopId:61,url:"https://store.steampowered.com/app/123/",priceCents:4000,regularCents:6000,cut:30,currency:"EUR",expiry:null}]]]);
  assert.equal(await revalidateKeyDelivery(f.c,delivery,f.time),null);
  assert.ok(!f.calls.some(x=>x.method==="sendMessage"));
});

test("a group configured as giveaway destination receives no publication", async (t) => {
  const f=fixture();t.after(f.h.close);
  f.c.env.TELEGRAM_CHAT_ID="-10";
  f.c.telegram.getChatType=async()=>"supergroup";
  await f.c.giveaways.ingestGiveaways([{id:"gift",gameId:"g",slug:"g",title:"G",shop:"Steam",url:"https://store.steampowered.com/app/123/",expiry:f.time+10000}],["-10"],f.time,false);
  const [id]=await f.c.deliveries.pendingDeliveries(f.time);
  await processDelivery(id,f.c,f.time);
  assert.equal(f.calls.length,0);
  assert.equal(f.h.sqlite.prepare("SELECT status FROM deliveries").get()!.status,"expired");
});

test("an old private update cannot undo a later blocked-chat marker", async (t) => {
  const f=fixture();t.after(f.h.close);await f.command("/start");
  const oldReceipt=f.time;
  f.advance();f.h.sqlite.prepare("INSERT INTO blocked_chats(chat_id,blocked_at) VALUES('7',?)").run(f.time);
  await handleUpdate(f.c,{update_id:99,message:{message_id:99,from:{id:7},chat:{id:7,type:"private"},text:"/news on"}},oldReceipt);
  assert.equal(f.h.sqlite.prepare("SELECT count(*) AS n FROM blocked_chats WHERE chat_id='7'").get()!.n,1);
  assert.equal((await f.c.news.subscriber("7")).enabled,0);
  f.advance();await f.command("/news on");
  assert.equal(f.h.sqlite.prepare("SELECT count(*) AS n FROM blocked_chats WHERE chat_id='7'").get()!.n,0);
  assert.equal((await f.c.news.subscriber("7")).enabled,1);
});

test("illustrated giveaway delivery falls back after a rejected image but retains transient failures", async () => {
  for(const status of [400,429,503]) {
    const calls:string[]=[];
    const client=new TelegramClient("fixture",async(url)=>{
      const method=String(url).split("/").at(-1)!;calls.push(method);
      return method==="sendPhoto"?Response.json({ok:false,error_code:status},{status}):Response.json({ok:true,result:true});
    });
    const result=client.sendIllustrated("-100","Giveaway","https://cdn.example.com/game.jpg","https://store.steampowered.com/app/123/");
    if(status===400) {await result;assert.deepEqual(calls,["sendPhoto","sendMessage"]);}
    else {await assert.rejects(result);assert.deepEqual(calls,["sendPhoto"]);}
  }
});

test("expanded captions fit Telegram limits after HTML parsing even with maximum metadata", () => {
  const visible=(text:string)=>text.replace(/<[^>]*>/g,"").replace(/&(?:amp|lt|gt|quot|#39);/g,"x");
  const caption=formatGiveaway({id:"a",gameId:"g",slug:"g",title:"&".repeat(300),description:"&".repeat(900),genres:"&".repeat(300),shop:"Steam".repeat(40),url:"https://store.steampowered.com/app/123/",expiry:Date.parse("2026-10-13T12:00:00Z")});
  assert.ok(visible(caption).length<=1024);
  const news=formatNews({id:"a",publisher:"test",sourceName:"&".repeat(200),topic:"anime_manga",title:"&".repeat(400),summary:"&".repeat(900),url:"https://multiplayer.it/notizie/game",publishedAt:Date.parse("2026-10-13T12:00:00Z")});
  assert.ok(visible(news).length<=1024);
});

test("an older failed photo cannot block or disable a freshly reactivated news subscription", async (t) => {
  const f=fixture();t.after(f.h.close);await f.command("/news on");
  await f.c.news.ingest("feed",{articles:[],notModified:false},f.time);
  f.advance();await f.c.news.ingest("feed",{articles:[{id:"a",publisher:"test",sourceName:"Test",topic:"games",title:"News",url:"https://multiplayer.it/a",publishedAt:f.time,imageUrl:"https://cdn.example.com/game.jpg"}],notModified:false},f.time);
  await f.c.news.queueForSubscribers(f.time);
  const id=String(f.h.sqlite.prepare("SELECT id FROM news_deliveries").get()!.id);
  f.c.telegram.sendPhoto=async()=>{
    await f.command("/news off");await f.command("/news on");
    throw new ApiError(403,undefined,true);
  };
  await processNewsDelivery(id,f.c,f.time);
  assert.equal((await f.c.news.subscriber("7")).enabled,1);
  assert.equal(f.h.sqlite.prepare("SELECT count(*) AS n FROM blocked_chats").get()!.n,0);
  assert.equal(await f.c.preferences.isAvailable("7"),true);
});

test("a failed wishlist request cannot block newer private activity", async (t) => {
  const f=fixture();t.after(f.h.close);await f.command("/news on");
  const game={id:"g",title:"Game",slug:"g",type:"game"};
  const quote={gameId:"g",shop:"Steam",shopId:61,url:"https://store.steampowered.com/app/123/",priceCents:2000,regularCents:4000,cut:50,currency:"EUR",expiry:null};
  await f.c.wishlist.addWishlist("7",null,game,quote,f.time);
  await f.c.wishlist.ingestPrices([{...quote,priceCents:1500}],f.time);
  const id=String(f.h.sqlite.prepare("SELECT id FROM deliveries WHERE kind='price'").get()!.id);
  f.c.itad.getPrices=async()=>new Map([["g",[{...quote,priceCents:1500}]]]);
  f.c.telegram.sendMessage=async()=>{await f.command("/start");throw new ApiError(403,undefined,true);};
  await processDelivery(id,f.c,f.time);
  assert.equal(f.h.sqlite.prepare("SELECT count(*) AS n FROM blocked_chats").get()!.n,0);
  assert.equal((await f.c.news.subscriber("7")).enabled,1);
});

test("blocked users free news capacity and resuming private use cannot silently exceed the cap", async (t) => {
  const f=fixture();t.after(f.h.close);
  for(let user=1;user<=10;user++) await f.command("/news on",user);
  f.h.sqlite.prepare("INSERT INTO blocked_chats(chat_id,blocked_at) VALUES('1',?)").run(f.time);
  await f.command("/news on",11);
  assert.equal((await f.c.news.subscriber("11")).enabled,1);
  await f.command("/start",1);
  assert.equal((await f.c.news.subscriber("1")).enabled,0);
  assert.equal((await f.c.news.activeSubscribers()).length,10);
  await f.command("/news on",1);
  assert.equal((await f.c.news.subscriber("1")).enabled,0);
});

test("channel verification accepts its configured username while rejecting mismatched identities", async () => {
  const client=new TelegramClient("fixture",async()=>Response.json({ok:true,result:{id:-100,type:"channel",username:"GameChannel"}}));
  assert.equal(await client.getChatType("@gamechannel"),"channel");
  assert.equal(await client.getChatType("-100"),"channel");
  await assert.rejects(client.getChatType("@otherchannel"));
  await assert.rejects(client.getChatType("-200"));
});

test("private activation atomically clears a failure arriving just before activity registration", async (t) => {
  const f=fixture();t.after(f.h.close);await f.command("/news on");
  await f.c.news.ingest("feed",{articles:[],notModified:false},f.time);
  f.advance();await f.c.news.ingest("feed",{articles:[{id:"a",publisher:"test",sourceName:"Test",topic:"games",title:"News",url:"https://multiplayer.it/a",publishedAt:f.time}],notModified:false},f.time);
  await f.c.news.queueForSubscribers(f.time);
  const id=String(f.h.sqlite.prepare("SELECT id FROM news_deliveries").get()!.id);
  const delivery=await f.c.news.claimDelivery(id,f.time);assert.ok(delivery);
  const subscriber=await f.c.news.subscriber("7"),activity=await f.c.preferences.privateActivity("7");
  const register=f.c.preferences.registerPrivateUser.bind(f.c.preferences);
  f.c.preferences.registerPrivateUser=async(user,at)=>{
    await f.c.news.failDelivery(delivery,delivery.lease_token!,subscriber.revision,activity,f.time,true);
    return register(user,at);
  };
  await f.command("/start");
  assert.equal(await f.c.preferences.isAvailable("7"),true);
  assert.equal(f.h.sqlite.prepare("SELECT count(*) AS n FROM blocked_chats").get()!.n,0);
});

test("a queued private update newer than the send attempt can clear its late failure", async (t) => {
  const f=fixture();t.after(f.h.close);await f.command("/news on");
  await f.c.news.ingest("feed",{articles:[],notModified:false},f.time);
  f.advance();await f.c.news.ingest("feed",{articles:[{id:"a",publisher:"test",sourceName:"Test",topic:"games",title:"News",url:"https://multiplayer.it/a",publishedAt:f.time}],notModified:false},f.time);
  await f.c.news.queueForSubscribers(f.time);
  const id=String(f.h.sqlite.prepare("SELECT id FROM news_deliveries").get()!.id);
  const delivery=await f.c.news.claimDelivery(id,f.time);assert.ok(delivery);
  const subscriber=await f.c.news.subscriber("7"),activity=await f.c.preferences.privateActivity("7");
  const attemptAt=f.time;
  await f.c.news.failDelivery(delivery,delivery.lease_token!,subscriber.revision,activity,attemptAt+1000,true,attemptAt);
  assert.equal(await f.c.preferences.registerPrivateUser("7",attemptAt+500),true);
  assert.equal(await f.c.preferences.isAvailable("7"),true);
});

test("out-of-order failures cannot move the blocked timestamp backwards", async (t) => {
  const f=fixture();t.after(f.h.close);await f.command("/start");
  f.h.sqlite.prepare("INSERT INTO deliveries(id,kind,chat_id,text,due_at) VALUES('early','reply','7','Early',0),('late','reply','7','Late',0)").run();
  const early=await f.c.deliveries.claimDelivery("early",f.time+100);
  const late=await f.c.deliveries.claimDelivery("late",f.time+200);
  assert.ok(early);assert.ok(late);
  const activity=await f.c.preferences.privateActivity("7");
  await f.c.deliveries.blockDelivery(late,"403",true,f.time+250,activity,f.time+200);
  await f.c.deliveries.blockDelivery(early,"403",true,f.time+300,activity,f.time+100);
  assert.equal(f.h.sqlite.prepare("SELECT blocked_at FROM blocked_chats WHERE chat_id='7'").get()!.blocked_at,f.time+200);
  assert.equal(await f.c.preferences.registerPrivateUser("7",f.time+150),false);
});
