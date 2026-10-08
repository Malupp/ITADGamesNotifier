import {readFile} from 'node:fs/promises';
import {ItadClient,ApiError} from '../src/clients.js';
const values=await readFile(process.argv[2],'utf8');
const key=values.match(/^ITAD_API_KEY\s*=\s*([^\r\n]+)/m)?.[1]?.trim().replace(/^['"]|['"]$/g,'');
if(!key)throw Error('Missing configuration');
try{const results=await new ItadClient(key,(async(url,init)=>{const r=await fetch(url,init);console.log({endpoint:new URL(String(url)).pathname,status:r.status});return r}) as typeof fetch).getDeals({maxPriceCents:5000,minScore:75,limit:10});console.log({count:results.length})}catch(e){console.error({status:e instanceof ApiError?e.status:undefined,kind:e instanceof Error?e.name:'unknown'});process.exitCode=1}
