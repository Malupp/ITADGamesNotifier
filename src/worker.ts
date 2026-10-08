import type {Env,QueueJob,PriceQuote,TelegramUpdate} from './types.js';
import {ApiError,ItadClient,TelegramClient} from './clients.js';
import {Store} from './store.js';
import {Scans} from './scans.js';
import {normalizeGiveaways,formatGiveaway,formatPrice} from './domain.js';
import {verifyGiveaways,confirmOfficialGiveaways} from './verification.js';
import {handleUpdate} from './bot.js';
const enabled=(env:Env)=>env.SCANS_ENABLED==='true';
const errorCode=(e:unknown)=>e instanceof ApiError?String(e.status):'internal';
const backoff=(e:unknown,attempts:number)=>Math.min(43200,Math.max(e instanceof ApiError?e.retryAfter??0:0,Math.min(1800,30*2**Math.min(attempts,6))));
async function sendJobs(env:Env,jobs:QueueJob[]):Promise<void>{for(let i=0;i<jobs.length;i+=100)await env.WORK_QUEUE.sendBatch(jobs.slice(i,i+100).map(body=>({body})));}
async function publishScans(env:Env,scans:Scans,now:number,kind:'prices'|'giveaways'|null=null):Promise<void>{
 const ids=await scans.dispatch(now,kind);
 try{await sendJobs(env,ids.map(id=>({kind:'scan',id})))}catch(e){await scans.releaseDispatch(ids,now);throw e;}
}
async function enqueueTick(env:Env,now:number,initialize=false):Promise<void>{
 if(!enabled(env)&&!initialize)return;
 await sendJobs(env,(['prices','giveaways','recover'] as const).map(part=>({kind:'tick',part,scheduledAt:now,initialize})));
}
async function flushDeliveries(env:Env,now:number):Promise<void>{
 const s=new Store(env.DB);await s.cancelInvalidPending(now);
 const ids=await s.pendingDeliveries(now,20);await sendJobs(env,ids.map(id=>({kind:'delivery',id})));
}
export async function handleRequest(request:Request,env:Env,now=Date.now()):Promise<Response>{
 const path=new URL(request.url).pathname;
 if(path==='/health'&&request.method==='GET')return Response.json({ok:true,scansEnabled:enabled(env)});
 const secret=request.headers.get('X-Telegram-Bot-Api-Secret-Token');
 if(!env.TELEGRAM_WEBHOOK_SECRET||secret!==env.TELEGRAM_WEBHOOK_SECRET)return new Response('Forbidden',{status:403});
 try{
  if(path==='/admin/status'&&request.method==='GET'){
   const s=new Store(env.DB);return Response.json({...await s.status(),pricesSeeded:await s.getSetting('prices_seeded')==='true',giveawaysSeeded:await s.getSetting('giveaways_seeded')==='true'});
  }
  if(path==='/admin/scan'&&request.method==='POST'){await enqueueTick(env,now,!enabled(env));return Response.json({accepted:true,quiet:!enabled(env)});}
  if(path==='/admin/probe'&&request.method==='POST'){
   await sendJobs(env,[{kind:'probe',scenario:'deals'},{kind:'probe',scenario:'prices'}]);return Response.json({accepted:true});
  }
  if(path!=='/telegram'||request.method!=='POST')return new Response('Not found',{status:404});
  if(Number(request.headers.get('content-length'))>65536)return new Response('Too large',{status:413});
  const text=await request.text();if(text.length>65536)return new Response('Too large',{status:413});
  let update:TelegramUpdate;try{update=JSON.parse(text)}catch{return new Response('Invalid JSON',{status:400})}
  if(!update||!Number.isSafeInteger(update.update_id)||update.update_id<0)return new Response('Invalid update',{status:400});
  const s=new Store(env.DB);await s.acceptUpdate(update,now); // commit BEFORE acknowledgement
  await env.WORK_QUEUE.send({kind:'update',id:update.update_id});
  return new Response('OK');
 }catch{return new Response('Retry later',{status:503})}
}
export async function schedule(env:Env,now:number,initialize=false,part:'all'|'prices'|'giveaways'|'recover'='all'):Promise<void>{
 if(!enabled(env)&&!initialize)return;
 const s=new Store(env.DB),scans=new Scans(env.DB);
 if(part==='all'||part==='prices'){
 const quiet=initialize||await s.getSetting('prices_seeded')!=='true';
 const gameIds=await s.gameIds();
 // Free Queues10k ops/day: cap below ~3000 messages/day incl. giveaway, commands, retries.
 // This deployment has16 games. Larger installations must explicitly resize/review quotas.
 if(gameIds.length>200)await s.setSetting('last_scan_error','prices:wishlist_capacity',now);
 const chunks=[];for(let i=0;i<gameIds.length;i+=10)chunks.push({kind:'prices' as const,gameIds:gameIds.slice(i,i+10),quiet});
 if(gameIds.length<=200)await scans.start('prices',chunks,quiet,now);
 if(part==='prices')await publishScans(env,scans,now,'prices');
 }
 if(part==='all'||part==='giveaways'){
 const baseline=initialize||await s.getSetting('giveaways_seeded')!=='true';
 await scans.start('giveaways',[{kind:'giveaways',offset:0,startedAt:now,baseline}],baseline,now);
 if(part==='giveaways')await publishScans(env,scans,now,'giveaways');
 }
 if(part==='all'||part==='recover'){
 await publishScans(env,scans,now);
 if(enabled(env)){
  await sendJobs(env,(await s.pendingUpdates(now)).map(id=>({kind:'update',id})));
  await flushDeliveries(env,now);
 }
 // Bounded retention, independent of scan integrity; delivery history lasts90d.
 await env.DB.batch([
  env.DB.prepare("DELETE FROM telegram_updates WHERE update_id IN (SELECT update_id FROM telegram_updates WHERE status='done' AND created_at<? LIMIT 100)").bind(now-7*86400000),
  env.DB.prepare("DELETE FROM deliveries WHERE id IN (SELECT id FROM deliveries WHERE status IN ('sent','expired','blocked') AND due_at<? LIMIT 100)").bind(now-90*86400000),
  env.DB.prepare("DELETE FROM scan_jobs WHERE id IN (SELECT j.id FROM scan_jobs j JOIN scan_runs r ON r.id=j.run_id WHERE r.status!='running' AND r.started_at<? LIMIT 100)").bind(now-7*86400000),
  env.DB.prepare("DELETE FROM scan_runs WHERE started_at<? AND status!='running' AND NOT EXISTS(SELECT 1 FROM scan_jobs WHERE run_id=scan_runs.id)").bind(now-7*86400000)
 ]);
 }
}
export async function processJob(job:QueueJob,env:Env,now:number,fetcher:typeof fetch=fetch):Promise<number|null>{
 const s=new Store(env.DB);
 if(job.kind==='tick'){await schedule(env,now,job.initialize,job.part);return null;}
 if(job.kind==='probe'){
  const itad=new ItadClient(env.ITAD_API_KEY,fetcher);
  const result=job.scenario==='deals'?await itad.getDeals({maxPriceCents:5000,minScore:75,limit:10}):await itad.getPrices((await s.gameIds()).slice(0,10));
  await s.setSetting('probe_'+job.scenario,JSON.stringify({at:now,count:result instanceof Map?result.size:result.length}),now);return null;
 }
 if(job.kind==='delivery'){
  const d=await s.claimDelivery(job.id,now);if(!d)return null;
  if(d.kind!=='reply'&&!enabled(env)){await s.retryDelivery(d,now+1800000,'paused');return null;}
  try{
   let text=d.text;
   // Recheck wishlist prices immediately before sending, including rebound/removal.
   if(d.kind==='price'&&d.game_id){
    const quotes=await new ItadClient(env.ITAD_API_KEY,fetcher).getPrices([d.game_id]);
    const best=(quotes.get(d.game_id)??[]).sort((a,b)=>a.priceCents-b.priceCents)[0];
    if(!best||best.priceCents!==d.price_cents||best.cut<=0||best.regularCents===null||best.regularCents<=best.priceCents){
     await s.retryDelivery(d,now,'changed');await s.invalidateMissingPrices([d.game_id],now);
     if(best)await s.ingestPrices([best],now);await s.cancelInvalidPending(now);return null;
    }
    const item=await env.DB.prepare('SELECT title FROM wishlist WHERE user_id=? AND game_id=?').bind(d.wishlist_user_id,d.game_id).first<{title:string}>();
    if(!item){await s.expireDelivery(d);return null;}
    text=formatPrice(item.title,best);
   }
   if(d.kind==='giveaway'){
    const offer=await s.deliveryOffer(d);
    const prices=offer?await new ItadClient(env.ITAD_API_KEY,fetcher).getPrices([offer.gameId]):new Map();
    const valid=offer?await confirmOfficialGiveaways(verifyGiveaways([offer],prices),fetcher,now):[];
    if(!valid.length){await s.expireDelivery(d);return null;}
    text=formatGiveaway(valid[0]);
   }
   await new TelegramClient(env.TELEGRAM_BOT_TOKEN,fetcher).sendMessage(d.chat_id,text,d.reply_markup?JSON.parse(d.reply_markup):undefined);
   await s.completeDelivery(d,Date.now());return null;
  }catch(e){
   if(e instanceof ApiError&&e.permanent){await s.blockDelivery(d,errorCode(e),e.status===403,now);return null;}
   const delay=backoff(e,d.attempts);await s.retryDelivery(d,now+delay*1000,errorCode(e));return delay;
  }
 }
 if(job.kind==='update'){
  const claim=await s.claimUpdate(job.id,now);if(!claim)return null;
  try{
   const user=claim.update.callback_query?.from??claim.update.message?.from;if(user)await s.unblockChat(String(user.id));
   await handleUpdate(env,claim.update);await s.completeUpdate(job.id,claim.token);await flushDeliveries(env,Date.now());return null;
  }catch(e){const delay=backoff(e,1);await s.retryUpdate(job.id,claim.token,now+delay*1000);return delay;}
 }
 const scans=new Scans(env.DB),claim=await scans.claim(job.id,now);
 if(!claim){
  // A previous attempt may have committed the page, then failed to publish its successor.
  await sendJobs(env,(await scans.successors(job.id,now)).map(id=>({kind:'scan',id})));
  if(enabled(env))await flushDeliveries(env,now);
  return null;
 }
 const task=claim.task;
 if(!enabled(env)&&!(task.kind==='prices'?task.quiet:task.baseline)){await scans.retry(job.id,claim.token,now+1800000);return null;}
 try{
  const itad=new ItadClient(env.ITAD_API_KEY,fetcher);
  if(task.kind==='prices'){
   const prices=await itad.getPrices(task.gameIds);
   const quotes:PriceQuote[]=task.gameIds.flatMap(id=>{const best=(prices.get(id)??[]).sort((a,b)=>a.priceCents-b.priceCents)[0];return best?[best]:[]});
   await s.cancelInvalidPending(now);
   await s.invalidateMissingPrices(task.gameIds.filter(id=>!quotes.some(q=>q.gameId===id)),now);
   await s.ingestPrices(quotes,now,task.quiet);
   await scans.complete(job.id,claim.token,claim.runId,now);
   if(enabled(env)&&!task.quiet)await flushDeliveries(env,now);
  }else{
   if(task.offset>500)throw new ApiError(502);
   const page=await itad.getGiveaways(task.offset,1);
   const candidates=normalizeGiveaways(page.items,now);
   // Reject unexpectedly large pages rather than breaching Free fetch/CPU budgets.
   const ids=[...new Set(candidates.map(o=>o.gameId))];if(ids.length>10)throw new ApiError(502);
   const verified=await confirmOfficialGiveaways(verifyGiveaways(candidates,await itad.getPrices(ids)),fetcher,now);
   await s.setSetting('giveaway_unverified_last_page',String(candidates.length-verified.length),now);
   await s.ingestGiveaways(verified,[env.TELEGRAM_CHAT_ID??'',env.TELEGRAM_CHAT_GROUP??''],now,task.baseline);
   if(page.hasMore){
    const next={...task,offset:task.offset+1};await scans.complete(job.id,claim.token,claim.runId,now,next);
    await env.WORK_QUEUE.send({kind:'scan',id:claim.runId+':'+next.offset});
   }else{
    await s.finishGiveawayScan(task.startedAt,now);
    await scans.complete(job.id,claim.token,claim.runId,now);
   }
   if(enabled(env)&&!task.baseline)await flushDeliveries(env,now);
  }
  return null;
 }catch(e){const delay=backoff(e,claim.attempts);await scans.retry(job.id,claim.token,now+delay*1000);await s.setSetting('last_scan_error',task.kind+':'+errorCode(e),now);return delay;}
}
export default {
 fetch(request:Request,env:Env){return handleRequest(request,env)},
 async scheduled(event:ScheduledController,env:Env){await enqueueTick(env,event.scheduledTime)},
 async queue(batch:MessageBatch<QueueJob>,env:Env){for(const message of batch.messages){try{const delay=await processJob(message.body,env,Date.now());if(delay===null)message.ack();else message.retry({delaySeconds:delay})}catch{console.error('job_failed',{kind:message.body.kind});message.retry({delaySeconds:60})}}}
} satisfies ExportedHandler<Env,QueueJob>;
