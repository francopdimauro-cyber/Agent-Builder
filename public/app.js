/* Agent Builder · interfaz (sin dependencias). */
const $ = id => document.getElementById(id);
let TOOLS = [{id:"text_generation",name:"Generación de texto",description:"Razonamiento y redacción mediante el proveedor de IA.",availability:"available"}];
let agents = [], current = null, currentStatus = null, fromAi = false, registering = false;

async function api(method, path, body){
  let res;
  try { res = await fetch(path, {method, credentials:"same-origin", headers: body ? {"Content-Type":"application/json"} : {}, body: body ? JSON.stringify(body) : undefined}); }
  catch { throw new Error("No se pudo conectar con el servidor."); }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.startsWith("/api/auth/login")) { showAuth(); throw new Error("Necesitas iniciar sesión."); }
  if (!res.ok) throw new Error((data.error || "Error " + res.status) + (Array.isArray(data.issues) ? ": " + data.issues.join("; ") : ""));
  return data;
}
function say(id, msg, kind){ const e=$(id); e.textContent=msg||""; e.className="status"+(kind?" "+kind:""); }

/* ---- Acceso ---- */
function showAuth(){ $("appRoot").hidden = true; $("auth").hidden = false; }
function setMode(reg){
  registering = reg;
  $("authT").textContent = reg ? "Crear cuenta" : "Iniciar sesión";
  $("authGo").textContent = reg ? "Crear cuenta" : "Entrar";
  $("authSwap").textContent = reg ? "Ya tengo cuenta" : "Crear cuenta";
  $("nameRow").hidden = !reg; $("pwHint").textContent = reg ? "(mínimo 10 caracteres)" : "";
  $("pw").autocomplete = reg ? "new-password" : "current-password"; say("authSt");
}
$("authSwap").onclick = () => setMode(!registering);
$("authGo").onclick = async () => {
  say("authSt","Un momento…");
  try{
    const body = {email:$("email").value.trim(), password:$("pw").value};
    if (registering) body.displayName = $("dn").value.trim();
    const d = await api("POST", registering ? "/api/auth/register" : "/api/auth/login", body);
    $("pw").value = ""; start(d.user);
  }catch(e){ say("authSt", e.message, "err"); }
};
$("pw").addEventListener("keydown", e => { if (e.key === "Enter") $("authGo").click(); });
$("logout").onclick = async () => { clearInterval(execTimer); setView("agents"); try{ await api("POST","/api/auth/logout"); }catch{} showAuth(); };

async function start(user){
  $("auth").hidden = true; $("appRoot").hidden = false;
  $("who").textContent = user ? user.display_name : ""; $("logout").hidden = false;
  try{ const s = await api("GET","/api/system/status"); if (Array.isArray(s.tools)) TOOLS = s.tools; }catch{}
  fill({}, null); load();
}

/* ---- Formulario ---- */
function renderTools(selected){
  $("tools").innerHTML = TOOLS.map(t => {
    const ok = t.availability === "available";
    return `<label class="tool ${ok?"":"off"}" style="font-weight:400;margin:0">
      <input type="checkbox" value="${t.id}" ${ok?"":"disabled"} ${selected.includes(t.id)?"checked":""}>
      <span><b></b> ${ok?"":'<span class="tag">no disponible</span>'}<small></small></span></label>`;
  }).join("");
  document.querySelectorAll("#tools .tool").forEach((el,i) => {
    el.querySelector("b").textContent = TOOLS[i].name;
    el.querySelector("small").textContent = TOOLS[i].availability === "available" ? TOOLS[i].description : (TOOLS[i].unavailableReason || TOOLS[i].description);
  });
}
const LABEL = {draft:"Borrador", active:"Activo", inactive:"Inactivo"};
function fill(cfg, id, agent, suggested){
  cfg = cfg || {};
  $("name").value = cfg.name || ""; $("description").value = cfg.description || "";
  $("role").value = cfg.role || ""; $("objective").value = cfg.objective || "";
  $("instructions").value = cfg.instructions || "";
  $("capabilities").value = (cfg.capabilities || []).join("\n");
  const l = cfg.limits || {};
  $("maxOutputTokens").value = l.maxOutputTokens || 1500; $("timeoutSeconds").value = l.timeoutSeconds || 45;
  $("reasoning").value = l.reasoning || "default"; $("requiresApproval").checked = !!cfg.requiresApproval;
  renderTools(cfg.tools || []);
  const sug = (suggested || []).filter(x => x !== "text_generation");
  $("suggested").hidden = !sug.length;
  if (sug.length) $("suggested").textContent = "La IA sugirió: " + sug.join(", ") + ". Aún no están disponibles.";
  current = id || null; currentStatus = agent ? agent.status : null; fromAi = false;
  $("title").textContent = id ? (cfg.name || "Agente") : "Nuevo agente";
  $("meta").textContent = agent ? `${LABEL[agent.status] || agent.status} · versión ${agent.current_version}` : "";
  $("sub").textContent = id ? "Cada cambio que guardes crea una versión nueva." : "Describe qué necesitas y la IA propone una configuración. Tú la revisas antes de guardar.";
  $("genBox").hidden = !!id; $("del").hidden = !id; $("runBox").hidden = !id;
  $("exportBox").hidden = !id;
  $("exportZip").disabled = !id || agent?.status !== "active";
  $("exportDomain").value = "";
  say("exportStatus");
  $("toggle").hidden = !id; if (id) $("toggle").textContent = agent.status === "active" ? "Desactivar" : "Activar";
  $("save").textContent = id ? "Guardar nueva versión" : "Guardar agente";
  $("out").hidden = true; say("saveSt"); say("genSt"); say("runSt");
  document.querySelectorAll(".item").forEach(b => b.setAttribute("aria-current", String(b.dataset.id === id)));
}
function collect(){
  return {
    name: $("name").value.trim(), description: $("description").value.trim(),
    role: $("role").value.trim(), objective: $("objective").value.trim(), instructions: $("instructions").value.trim(),
    capabilities: $("capabilities").value.split("\n").map(s=>s.trim()).filter(Boolean),
    tools: [...document.querySelectorAll("#tools input:checked")].map(i=>i.value),
    limits: { maxOutputTokens:+$("maxOutputTokens").value, timeoutSeconds:+$("timeoutSeconds").value, reasoning:$("reasoning").value },
    requiresApproval: $("requiresApproval").checked
  };
}

/* ---- Entrega independiente por cliente ---- */
$("exportZip").onclick = async () => {
  if (!current) return;
  $("exportZip").disabled = true;
  say("exportStatus", "Preparando paquete independiente...");
  try {
    const d = await api("GET", "/api/agents/" + encodeURIComponent(current));
    const version = d.versions.find(x => x.version === d.agent.current_version) || d.versions[0];
    if (!version) throw Error("No se ha encontrado la configuración del agente.");
    const { downloadStandaloneZip } = await import("./export/exporter.mjs");
    const result = await downloadStandaloneZip({
      agent: d.agent,
      config: version.config,
      siteOrigin: $("exportDomain").value.trim()
    });
    say("exportStatus", "ZIP generado: " + result.workerName + ".zip. Descomprímelo y sigue su README.md.", "ok");
  } catch (e) {
    say("exportStatus", e.message || "No se pudo generar el ZIP.", "err");
  } finally {
    $("exportZip").disabled = currentStatus !== "active";
  }
};

/* ---- Lista y detalle ---- */
async function load(selectId){
  try{
    agents = (await api("GET","/api/agents")).agents || [];
    $("list").innerHTML = agents.length ? agents.map(a => '<button class="item"><b></b><span></span></button>').join("") : '<div class="empty">Aún no tienes agentes. Crea el primero.</div>';
    document.querySelectorAll(".item").forEach((b,i) => {
      const a = agents[i]; b.dataset.id = a.id;
      b.querySelector("b").textContent = a.name;
      b.querySelector("span").textContent = (LABEL[a.status] || a.status) + (a.description ? " · " + a.description : "");
      b.onclick = () => open(a.id);
      b.setAttribute("aria-current", String(a.id === selectId));
    });
  }catch(e){ $("list").innerHTML = '<div class="empty"></div>'; $("list").firstChild.textContent = e.message; }
}
async function open(id){
  try{
    const d = await api("GET","/api/agents/" + id);
    const v = d.versions.find(x => x.version === d.agent.current_version) || d.versions[0];
    fill(v.config, id, d.agent);
  }catch(e){ say("saveSt", e.message, "err"); }
}
$("new").onclick = () => fill({}, null);

$("gen").onclick = async () => {
  const p = $("prompt").value.trim();
  if (p.length < 10) return say("genSt","Escribe al menos 10 caracteres.","err");
  $("gen").disabled = true; say("genSt","Generando… puede tardar unos segundos.");
  try{
    const d = await api("POST","/api/agents/generate",{prompt:p});
    fill(d.config, null, null, d.suggestedTools); fromAi = true; $("genBox").hidden = false;
    say("genSt","Propuesta lista. Activa «Generación de texto» y guarda cuando estés conforme.","ok");
  }catch(e){ say("genSt", e.message, "err"); }
  $("gen").disabled = false;
};

$("importBtn").onclick = () => $("importFile").click();
$("importFile").onchange = async () => {
  const f = $("importFile").files[0]; $("importFile").value = "";
  if (!f) return;
  try{
    const data = JSON.parse(await f.text());
    const cfg = data && typeof data === "object" && data.config ? data.config : data;
    if (!cfg || typeof cfg !== "object" || !cfg.name) throw new Error("El archivo no parece la configuración de un agente.");
    fill(cfg, null);
    say("genSt","Configuración de «" + cfg.name + "» cargada. Revísala y pulsa «Guardar agente».","ok");
  }catch(e){ say("genSt", e instanceof SyntaxError ? "El archivo no es un JSON válido." : e.message, "err"); }
};

$("save").onclick = async () => {
  $("save").disabled = true; say("saveSt","Guardando…");
  try{
    const cfg = collect();
    if (current){ await api("POST","/api/agents/"+current+"/versions",{config:cfg}); await load(current); await open(current); say("saveSt","Versión guardada.","ok"); }
    else { const d = await api("POST","/api/agents",{config:cfg, source: fromAi ? "ai" : "manual"}); await load(d.id); await open(d.id); say("saveSt","Agente guardado. Actívalo para poder ejecutarlo.","ok"); }
  }catch(e){ say("saveSt", e.message, "err"); }
  $("save").disabled = false;
};
$("toggle").onclick = async () => {
  try{
    await api("POST","/api/agents/"+current+"/status",{status: currentStatus === "active" ? "inactive" : "active"});
    await load(current); await open(current); say("saveSt","Estado actualizado.","ok");
  }catch(e){ say("saveSt", e.message, "err"); }
};
$("del").onclick = async () => {
  if (!current || !confirm("¿Eliminar este agente? Esta acción no se puede deshacer.")) return;
  try{ await api("DELETE","/api/agents/"+current); await load(); fill({}, null); }catch(e){ say("saveSt", e.message, "err"); }
};

$("run").onclick = async () => {
  const input = $("input").value.trim();
  if (!input) return say("runSt","Escribe un mensaje de entrada.","err");
  $("run").disabled = true; say("runSt","Ejecutando…"); $("out").hidden = true;
  try{
    const r = await api("POST","/api/executions",{agentId:current, input});
    const d = await api("GET","/api/executions/"+r.id);
    const ex = d.execution;
    if (ex.status === "awaiting_approval"){ say("runSt","Esperando aprobación: este agente requiere que apruebes antes de ejecutar.","ok"); }
    else {
      $("out").textContent = ex.status === "completed" ? ex.output : (ex.error || "La ejecución terminó con estado " + ex.status + ".");
      $("out").hidden = false;
      say("runSt", ex.status === "completed" ? "Completada" + (ex.model ? " con " + ex.model : "") + "." : "Falló.", ex.status === "completed" ? "ok" : "err");
    }
  }catch(e){ say("runSt", e.message, "err"); }
  $("run").disabled = false;
};

/* ---- Centro de ejecución ---- */
const ST = {draft:"Borrador",queued:"En cola",running:"Ejecutando",awaiting_approval:"Esperando aprobación",completed:"Completada",failed:"Fallida",cancelled:"Cancelada"};
const TERMINAL = ["completed","failed","cancelled"];
const openIds = new Set(); let view = "agents", execTimer = null;
const mk = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const fmt = s => s ? new Date(s).toLocaleString("es-ES",{dateStyle:"short",timeStyle:"medium"}) : "";

for (const k of Object.keys(ST)) { const o = document.createElement("option"); o.value = k; o.textContent = ST[k]; $("fStatus").appendChild(o); }

function setView(v){
  view = v;
  $("viewAgents").hidden = v !== "agents"; $("viewExec").hidden = v !== "exec"; $("viewChat").hidden = v !== "chat";
  $("agentSide").style.display = v === "agents" ? "contents" : "none";
  $("navA").setAttribute("aria-current", String(v === "agents")); $("navE").setAttribute("aria-current", String(v === "exec"));
  $("navC").setAttribute("aria-current", String(v === "chat"));
  clearInterval(execTimer);
  if (v === "chat") loadChats();
  if (v === "exec"){
    const cur = $("fAgent").value;
    $("fAgent").innerHTML = '<option value="">Todos los agentes</option>';
    agents.forEach(a => { const o = document.createElement("option"); o.value = a.id; o.textContent = a.name; $("fAgent").appendChild(o); });
    $("fAgent").value = cur;
    loadExec(); execTimer = setInterval(() => { if (!document.hidden) loadExec(true); }, 4000);
  }
}
$("navA").onclick = () => setView("agents"); $("navE").onclick = () => setView("exec");
$("fStatus").onchange = () => loadExec(); $("fAgent").onchange = () => loadExec(); $("exRefresh").onclick = () => loadExec();

async function loadExec(quiet){
  if (!quiet) say("exSt","Cargando…");
  try{
    const p = new URLSearchParams({limit:"100"});
    if ($("fStatus").value) p.set("status", $("fStatus").value);
    if ($("fAgent").value) p.set("agentId", $("fAgent").value);
    const [ex, ap] = await Promise.all([api("GET","/api/executions?"+p), api("GET","/api/approvals?status=pending")]);
    const pending = {}; (ap.approvals || []).forEach(a => { if (a.execution_id) pending[a.execution_id] = a.id; });
    const list = ex.executions || [];
    const box = $("exList"); box.textContent = "";
    if (!list.length) box.appendChild(mk("p","empty","Aún no hay ejecuciones. Lanza un agente desde la pestaña Agentes y aparecerá aquí."));
    for (const e of list) box.appendChild(await row(e, pending[e.id]));
    say("exSt", list.length + (list.length === 1 ? " ejecución" : " ejecuciones"));
  }catch(e){ say("exSt", e.message, "err"); }
}

async function row(e, approvalId){
  const name = (agents.find(a => a.id === e.agent_id) || {}).name || "Agente eliminado";
  const wrap = mk("div","ex"), head = mk("div","exh");
  const isOpen = openIds.has(e.id);
  const tg = mk("button","tg", isOpen ? "▾" : "▸"); tg.setAttribute("aria-label", isOpen ? "Ocultar detalle" : "Ver detalle"); tg.setAttribute("aria-expanded", String(isOpen));
  tg.onclick = () => { isOpen ? openIds.delete(e.id) : openIds.add(e.id); loadExec(true); };
  head.append(tg, mk("span","badge b-"+e.status, ST[e.status] || e.status), mk("b","",name),
    mk("span","hint","v"+e.agent_version+" · intento "+e.attempt+(e.workflow_run_id ? " · flujo" : "")), mk("span","when",fmt(e.created_at)));
  const act = (label, cls, fn, okMsg) => { const b = mk("button","mini "+cls,label); b.onclick = async () => { b.disabled = true; try{ await fn(); say("exSt",okMsg,"ok"); }catch(er){ say("exSt",er.message,"err"); } loadExec(true); }; head.appendChild(b); };
  if (e.status === "awaiting_approval" && approvalId){
    act("Aprobar","ok",() => api("POST","/api/approvals/"+approvalId+"/decision",{approve:true}),"Aprobada y ejecutada.");
    act("Rechazar","no",() => api("POST","/api/approvals/"+approvalId+"/decision",{approve:false}),"Rechazada.");
  }
  if (!TERMINAL.includes(e.status)) act("Cancelar","no",() => api("POST","/api/executions/"+e.id+"/cancel"),"Cancelada.");
  if ((e.status === "failed" || e.status === "cancelled") && !e.workflow_run_id) act("Reintentar","ok",() => api("POST","/api/executions/"+e.id+"/retry"),"Reintento lanzado.");
  wrap.appendChild(head);
  if (isOpen){
    let events = []; try{ events = (await api("GET","/api/executions/"+e.id)).events || []; }catch{}
    const body = mk("div","exb"), l = mk("div"), r = mk("div");
    l.append(mk("h3","","Entrada"), mk("pre","",e.input));
    l.append(mk("h3","","Salida"+(e.model ? " · "+e.model : "")));
    if (e.error) l.appendChild(mk("pre","e",e.error));
    if (e.output) l.appendChild(mk("pre","",e.output)); else if (!e.error) l.appendChild(mk("p","hint","Sin salida todavía."));
    r.appendChild(mk("h3","","Eventos"));
    const ol = mk("ol","evs");
    events.forEach(ev => { const li = mk("li"); li.append(mk("span","t",new Date(ev.created_at).toLocaleTimeString("es-ES")), mk("span","k",ev.type), mk("span","",ev.message)); ol.appendChild(li); });
    r.appendChild(ol); body.append(l, r); wrap.appendChild(body);
  }
  return wrap;
}

/* ---- Chat para tu web ---- */
let chats = [], editingChat = null;
$("navC").onclick = () => setView("chat");
const lines = id => $(id).value.split("\n").map(s => s.trim()).filter(Boolean);
const snippet = c => `<script src="${location.origin}/widget.js" data-chat="${c.id}" defer></` + `script>`;

function fillAgentsSelect(selected){
  const sel = $("cAgent"); sel.textContent = "";
  const usable = agents.filter(a => a.status === "active" || a.id === selected);
  if (!usable.length){ const o = mk("option","", "No hay agentes activos: activa uno en la pestaña Agentes"); o.value = ""; sel.appendChild(o); }
  usable.forEach(a => { const o = mk("option","", a.name + (a.status === "active" ? "" : " (inactivo)")); o.value = a.id; sel.appendChild(o); });
  if (selected) sel.value = selected;
}

function chatForm(c){
  editingChat = c ? c.id : null;
  fillAgentsSelect(c && c.agentId);
  $("chatFormT").textContent = c ? "Editar «" + c.title + "»" : "Nuevo chat";
  $("cTitle").value = c ? c.title : ""; $("cGreeting").value = c ? c.greeting : "";
  $("cSuggestions").value = c ? c.suggestions.join("\n") : ""; $("cPrivacy").value = c ? c.privacyNotice : "";
  $("cOrigins").value = c ? c.allowedOrigins.join("\n") : "";
  $("cPerVisitor").value = c ? c.perVisitorLimit : 15; $("cDaily").value = c ? c.dailyLimit : 500;
  $("cEnabled").checked = c ? c.enabled : true;
  $("cSave").textContent = c ? "Guardar cambios" : "Publicar chat"; $("cCancel").hidden = !c; say("cSt");
}
$("cCancel").onclick = () => chatForm(null);

async function loadChats(){
  try{
    agents = (await api("GET","/api/agents")).agents || agents;
    chats = (await api("GET","/api/public-chats")).chats || [];
  }catch(e){ return say("cSt", e.message, "err"); }
  if (!editingChat) fillAgentsSelect($("cAgent").value);
  const box = $("chatList"); box.textContent = "";
  if (!chats.length) box.appendChild(mk("p","empty","Aún no has publicado ningún chat. Rellena el formulario de abajo."));
  for (const c of chats){
    const card = mk("div","chat"), head = mk("div","exh");
    head.append(mk("span","badge " + (c.enabled ? "b-completed" : "b-cancelled"), c.enabled ? "Activo" : "Pausado"), mk("b","",c.title), mk("span","hint","con " + (c.agentName || "agente")));
    const ed = mk("button","mini ok","Editar"); ed.onclick = () => { chatForm(c); $("cTitle").focus(); };
    const del = mk("button","mini no","Eliminar");
    del.onclick = async () => {
      if (!confirm("¿Eliminar el chat «" + c.title + "»? La web dejará de mostrarlo.")) return;
      try{ await api("DELETE","/api/public-chats/" + c.id); if (editingChat === c.id) chatForm(null); loadChats(); }catch(e){ say("cSt", e.message, "err"); }
    };
    head.append(mk("span","when",""), ed, del);
    const dl = mk("dl");
    const add = (k, v) => dl.append(mk("dt","",k), mk("dd","",v));
    add("Webs", c.allowedOrigins.length ? c.allowedOrigins.join(", ") : "Ninguna (el chat no funcionará hasta que añadas una)");
    add("Hoy", c.messagesToday + " de " + c.dailyLimit + " mensajes");
    add("Por visitante", c.perVisitorLimit + " mensajes cada 10 minutos");
    const sn = mk("div","snippet"), pre = mk("pre","",snippet(c));
    const cp = mk("button","mini ok","Copiar código");
    cp.onclick = async () => { try{ await navigator.clipboard.writeText(snippet(c)); cp.textContent = "Copiado"; setTimeout(() => cp.textContent = "Copiar código", 1600); }catch{ say("cSt","No se pudo copiar; selecciona el texto a mano.","err"); } };
    sn.append(mk("p","hint","Pega esta línea antes de </body> en la web:"), pre);
    const bt = mk("div","btns"); bt.appendChild(cp); sn.appendChild(bt);
    card.append(head, dl, sn); box.appendChild(card);
  }
}

$("cSave").onclick = async () => {
  const body = {
    agentId: $("cAgent").value, title: $("cTitle").value.trim(), greeting: $("cGreeting").value.trim(),
    suggestions: lines("cSuggestions"), privacyNotice: $("cPrivacy").value.trim(), allowedOrigins: lines("cOrigins"),
    perVisitorLimit: +$("cPerVisitor").value, dailyLimit: +$("cDaily").value, enabled: $("cEnabled").checked
  };
  if (!body.agentId) return say("cSt","Elige un agente activo.","err");
  if (!body.allowedOrigins.length) return say("cSt","Añade al menos una web autorizada.","err");
  $("cSave").disabled = true; say("cSt","Guardando…");
  try{
    if (editingChat) await api("PUT","/api/public-chats/" + editingChat, body); else await api("POST","/api/public-chats", body);
    const msg = editingChat ? "Cambios guardados." : "Chat publicado. Copia el código de arriba en la web.";
    chatForm(null); await loadChats(); say("cSt", msg, "ok");
  }catch(e){ say("cSt", e.message, "err"); }
  $("cSave").disabled = false;
};

(async () => {
  try{ const d = await api("GET","/api/auth/me"); start(d.user); }
  catch{ showAuth(); }
})();
