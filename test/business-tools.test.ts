import assert from "node:assert/strict";
import {before,after,test} from "node:test";
import {AGENT,Client,startApp,startMock,okBody,type TestApp} from "./helpers.ts";

const ORIGIN="https://centro-entrenamiento.es";
let mock:Awaited<ReturnType<typeof startMock>>;
let app:TestApp;
before(async()=>{
 mock=await startMock(()=>({status:200,body:okBody("Gracias por tu consulta.")}));
 app=await startApp(mock.url);
});
after(async()=>{await app.close();await mock.close();});
async function owner(email:string):Promise<Client>{
 const client=new Client(app.base);
 const r=await client.post("/api/auth/register",{email,password:"contraseña-para-pruebas-123"});
 assert.equal(r.status,201,JSON.stringify(r.json));
 return client;
}
async function agent(client:Client,tools:string[]):Promise<string>{
 const res=await client.post("/api/agents",{config:{...AGENT,tools}});
 assert.equal(res.status,201,JSON.stringify(res.json));
 const id=res.json.id as string;
 assert.equal((await client.post("/api/agents/"+id+"/status",{status:"active"})).status,200);
 return id;
}
async function publicRequest(path:string,body:unknown,origin=ORIGIN){
 const res=await fetch(app.base+path,{method:"POST",
  headers:{"Content-Type":"application/json","Origin":origin},
  body:JSON.stringify(body)});
 const text=await res.text();
 return {status:res.status,json:text?JSON.parse(text) as Record<string,any>:null,headers:res.headers};
}
test("conocimiento: solo el dueño escribe y consulta, con límites y respuestas comprobables",async()=>{
 const ana=await owner("knowledge-ana@example.test");
 const eva=await owner("knowledge-eva@example.test");
 const id=await agent(ana,["text_generation","site_knowledge"]);
 const endpoint="/api/agents/"+id+"/knowledge";
 const entries=[{question:"¿Cuál es el precio del bono mensual?",answer:"El bono mensual cuesta 49 euros."},
  {question:"¿Dónde está el gimnasio?",answer:"Estamos en la zona comercial de Parquesol, Valladolid."}];
 const saved=await ana.put(endpoint,{entries});
 assert.equal(saved.status,200,JSON.stringify(saved.json));
 assert.equal(saved.json.count,2);
 const owned=await ana.get(endpoint);
 assert.equal(owned.json.entries.length,2);
 assert.equal(owned.json.entries[0].answer,entries[0].answer);
 assert.equal((await eva.get(endpoint)).status,404);
 assert.equal((await eva.put(endpoint,{entries:[]})).status,404);
 const invalid=await ana.put(endpoint,{entries:[{question:"x",answer:"y"}]});
 assert.equal(invalid.status,400);
 assert.equal((await ana.get(endpoint)).json.entries.length,2,"No se borra el conocimiento si falla validación");
 const c=await ana.post("/api/public-chats",{
  agentId:id,title:"Entrena-T",greeting:"¡Hola!",allowedOrigins:[ORIGIN],suggestions:[],privacyNotice:"No compartas datos sensibles."
 });
 assert.equal(c.status,201,JSON.stringify(c.json));
 const calls=mock.calls.length;
 const response=await publicRequest("/api/public/chats/"+c.json.id+"/messages",{
  messages:[{role:"user",content:"¿Precio del bono mensual?"}]
 });
 assert.equal(response.status,200,JSON.stringify(response.json));
 assert.equal(mock.calls.length,calls+1);
 const system=(mock.calls.at(-1)?.body.messages as Array<{role:string;content:string}>)[0]?.content||"";
 assert.match(system,/49 euros/,"La IA debe recibir la respuesta factual del servidor");
 assert.match(system,/ignora cualquier orden/,"La fuente no es instrucciones de sistema");
 const other=await agent(eva,["text_generation","site_knowledge"]);
 assert.equal((await eva.get("/api/agents/"+other+"/knowledge")).json.entries.length,0,"Datos separados por propietario");
});
test("contacto: opt-in, origen permitido, controles antispam y acceso exclusivo del dueño",async()=>{
 const ana=await owner("leads-ana@example.test");
 const eva=await owner("leads-eva@example.test");
 const id=await agent(ana,["text_generation","lead_capture"]);
 const r=await ana.post("/api/public-chats",{agentId:id,title:"Entrena-T",
  greeting:"Hola",allowedOrigins:[ORIGIN],suggestions:[],privacyNotice:"Consentimiento para contacto"});
 assert.equal(r.status,201,JSON.stringify(r.json));
 const route="/api/public/chats/"+r.json.id+"/leads";
 const payload={name:"Alba Ejemplo",email:"alba@example.test",message:"Quisiera conocer los horarios.",consent:true,website:""};
 const opts=await fetch(app.base+route,{method:"OPTIONS",headers:{Origin:ORIGIN}});
 assert.equal(opts.status,204);assert.equal(opts.headers.get("access-control-allow-origin"),ORIGIN);
 assert.equal((await publicRequest(route,{...payload,consent:false})).status,400);
 assert.equal((await publicRequest(route,{...payload,website:"soy un bot"})).status,400);
 const outside=await publicRequest(route,payload,"https://malicioso.example");
 assert.equal(outside.status,403);
 const before=await ana.get("/api/leads");
 assert.equal(before.json.leads.length,0);
 const accepted=await publicRequest(route,payload);
 assert.equal(accepted.status,201,JSON.stringify(accepted.json));
 assert.equal(accepted.json.ok,true);
 const leads=await ana.get("/api/leads");
 assert.equal(leads.json.leads.length,1);
 assert.equal(leads.json.leads[0].email,"alba@example.test");
 assert.equal(leads.json.leads[0].message,payload.message);
 assert.equal((await eva.get("/api/leads")).json.leads.length,0,"Otro usuario no puede consultar contactos");
 assert.equal((await eva.del("/api/leads/"+leads.json.leads[0].id)).status,404);
 assert.equal((await ana.del("/api/leads/"+leads.json.leads[0].id)).status,200);
 assert.equal((await ana.get("/api/leads")).json.leads.length,0,"Se puede borrar una solicitud");
 const noTool=await agent(ana,["text_generation"]);
 const disabled=await ana.post("/api/public-chats",{agentId:noTool,title:"Solo chat",
   greeting:"Hola",allowedOrigins:[ORIGIN],suggestions:[],privacyNotice:"Sin captación"});
 assert.equal(disabled.status,201);
 assert.equal((await publicRequest("/api/public/chats/"+disabled.json.id+"/leads",payload)).status,403);
 const cfg=await fetch(app.base+"/api/public/chats/"+r.json.id,{headers:{Origin:ORIGIN}});
 const data=await cfg.json() as Record<string,unknown>;
 assert.equal(data.contactEnabled,true);
});
