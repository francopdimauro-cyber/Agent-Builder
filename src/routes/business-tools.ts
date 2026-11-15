import { randomUUID } from "../util/id.ts";
import { q,q1,exec,tx } from "../db/index.ts";
import type { Ctx } from "../context.ts";
import { AppError } from "../errors.ts";
import { asObject,Checker,isRecord } from "../domain/validate.ts";
import { json,type Router } from "../http/router.ts";

export interface KnowledgeItem {id:string;question:string;answer:string;}
export function lookupKnowledge(ctx:Ctx,ownerId:string,agentId:string,input:string):KnowledgeItem[]{
 const rows=q<KnowledgeItem>(ctx.db,
  "select id,question,answer from agent_knowledge where owner_id = ? and agent_id = ? limit 30",
  ownerId,agentId);
 const words=(s:string)=>new Set((s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"")
  .match(/[\p{L}\p{N}]{3,}/gu)||[])
  .filter(x=>!["como","para","donde","cual","cuanto","desde","sobre","tienes","tienen","hola","quiero","puedo","poder"].includes(x)));
 const query=words(input);
 return rows.map(row=>{
  const terms=words(row.question);
  let score=0;
  for(const word of query)if(terms.has(word))score+=2;
  for(const word of words(row.answer))if(query.has(word))score++;
  return {row,score};
 }).filter(x=>x.score>0).sort((a,b)=>b.score-a.score).slice(0,3).map(x=>x.row);
}
export function getEnabledTools(ctx:Ctx,ownerId:string,agentId:string):string[]{
 const agent=q1<{config:string}>(ctx.db,
  "select av.config from agents a join agent_versions av on av.agent_id = a.id and av.owner_id = a.owner_id and av.version = a.current_version where a.id = ? and a.owner_id = ? and a.status = 'active'",
  agentId,ownerId);
 if(!agent)return [];
 let config:{tools?:unknown};
 try{config=JSON.parse(agent.config)}catch{return []}
 return Array.isArray(config.tools)?config.tools.filter((v):v is string=>typeof v==="string"):[];
}
export function registerBusinessToolRoutes(router:Router,ctx:Ctx):void{
 const {db}=ctx;
 function ownedAgent(ownerId:string,agentId:string):void{
  if(!q1(db,"select id from agents where owner_id = ? and id = ?",ownerId,agentId))
   throw new AppError(404,"Agente no encontrado.");
 }
 router.add("GET","/api/agents/:id/knowledge",req=>{
  const id=req.params["id"]!;
  ownedAgent(req.user.id,id);
  const entries=q<KnowledgeItem>(db,
   "select id,question,answer from agent_knowledge where owner_id = ? and agent_id = ? order by updated_at desc limit 30",
   req.user.id,id);
  return json({entries});
 });
 router.add("PUT","/api/agents/:id/knowledge",req=>{
  const id=req.params["id"]!;
  ownedAgent(req.user.id,id);
  const input=asObject(req.body);
  const c=new Checker();
  const entries=input["entries"];
  if(!Array.isArray(entries)||entries.length>30)c.issues.push("entries: máximo 30 entradas.");
  const normalized:{question:string;answer:string}[]=[];
  if(Array.isArray(entries)&&entries.length<=30){
   entries.forEach((item,index)=>{
    if(!isRecord(item)){c.issues.push("entries["+index+"]: objeto inválido.");return;}
    const question=c.string(item["question"],"entries["+index+"].question",{min:3,max:250});
    const answer=c.string(item["answer"],"entries["+index+"].answer",{min:3,max:1500});
    normalized.push({question,answer});
   });
  }
  c.done();
  tx(db,()=>{
   exec(db,"delete from agent_knowledge where owner_id = ? and agent_id = ?",req.user.id,id);
   for(const x of normalized)exec(db,
    "insert into agent_knowledge(id,owner_id,agent_id,question,answer) values(?,?,?,?,?)",
    randomUUID(),req.user.id,id,x.question,x.answer);
  });
  return json({ok:true,count:normalized.length});
 });
 router.add("GET","/api/leads",req=>{
  const leads=q<{id:string;agent_id:string;chat_id:string;name:string;email:string;message:string;consent_at:string;created_at:string}>(
   db,"select id,agent_id,chat_id,name,email,message,consent_at,created_at from contact_leads where owner_id = ? order by created_at desc limit 200",req.user.id);
  return json({leads});
 });
 router.add("DELETE","/api/leads/:id",req=>{
  const changes=exec(db,"delete from contact_leads where id = ? and owner_id = ?",req.params["id"]!,req.user.id);
  if(!changes)throw new AppError(404,"Solicitud no encontrada.");
  return json({ok:true});
 });
}
