import { FormError, length } from './validation.js';
interface Metrics {llmCalls:number;toolCalls:number;tokens:number;seconds:number}
export type ShareData = {v:1;type:'compare';model:string;pi:Metrics & {capabilities:number};dsh:Metrics;dshOnly:string[]} | {v:1;type:'achievement';id:string;name:string;unlocked:number;total:number};
export function parseShare(raw:string):ShareData|null {
  if(!raw)return null;
  const invalid=()=>{throw new FormError('分享数据无效，请重新从 App 分享');};
  if(Buffer.byteLength(raw)>4096)return invalid();
  let data:unknown;try{data=JSON.parse(raw);}catch{return invalid();}
  const record=(v:unknown,keys:string[]):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v)&&Object.keys(v).sort().join()===keys.sort().join();
  const number=(v:unknown,max:number,integer=true):v is number=>typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=max&&(!integer||Number.isInteger(v));
  const text=(v:unknown,max:number):v is string=>typeof v==='string'&&length(v)>0&&length(v)<=max&&[...v].every(c=>c.charCodeAt(0)>=32&&c.charCodeAt(0)!==127);
  if(typeof data!=='object'||data===null||!('type' in data))return invalid();
  const input=data as Record<string,unknown>;
  if(input.type==='compare' && record(input,['v','type','model','pi','dsh','dshOnly']) && input.v===1 && text(input.model,80) && record(input.pi,['capabilities','llmCalls','toolCalls','tokens','seconds']) && record(input.dsh,['llmCalls','toolCalls','tokens','seconds']) && number(input.pi.capabilities,100) && Array.isArray(input.dshOnly) && input.dshOnly.length<=8 && input.dshOnly.every(x=>text(x,12))) {
    for(const row of [input.pi,input.dsh])if(!number(row.llmCalls,100000)||!number(row.toolCalls,100000)||!number(row.tokens,1e9)||!number(row.seconds,604800,false))return invalid();
    return input as unknown as ShareData;
  }
  if(input.type==='achievement'&&record(input,['v','type','id','name','unlocked','total'])&&input.v===1&&text(input.id,64)&&/^[a-z0-9-]+$/.test(input.id)&&text(input.name,40)&&number(input.unlocked,1000)&&number(input.total,1000)&&input.total>=1&&input.unlocked<=input.total)return input as unknown as ShareData;
  return invalid();
}
