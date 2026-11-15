/*!
 * Agent Builder · widget de chat para webs
 *
 * Uso (una línea antes de </body>):
 *   <script src="https://TU-WORKER/widget.js" data-chat="ID-DEL-CHAT" defer></script>
 *
 * Atributos opcionales:
 *   data-accent="#c8324b"      color principal (botón, burbujas del visitante)
 *   data-accent-text="#fff"    color del texto sobre el color principal
 *   data-theme="auto|light|dark"
 *   data-position="right|left"
 *   data-label="Pregunta a Refu"  texto del botón flotante
 *   data-font="inherit"        tipografía (por defecto, la de la web)
 *   data-api="https://..."     origen de la API (por defecto, el del propio script)
 *
 * Sin dependencias. Todo vive dentro de un Shadow DOM: los estilos de la web no lo afectan ni al revés.
 */
(() => {
  "use strict";

  const script = document.currentScript;
  if (!script) return;
  const ds = script.dataset;
  const chatId = (ds.chat || "").trim();
  if (!/^[0-9a-f-]{36}$/i.test(chatId)) {
    console.warn("[chat] Falta data-chat con el identificador del chat.");
    return;
  }
  if (window.__agentChatLoaded && window.__agentChatLoaded[chatId]) return; // evita duplicados
  (window.__agentChatLoaded = window.__agentChatLoaded || {})[chatId] = true;

  const API = (ds.api || new URL(script.src, location.href).origin).replace(/\/+$/, "");
  const ENDPOINT = `${API}/api/public/chats/${encodeURIComponent(chatId)}`;
  const STORE_KEY = `agent-chat:${chatId}`;
  const MAX_CHARS = 1000;
  const MAX_TURNS_SENT = 20;
  const position = ds.position === "left" ? "left" : "right";
  const theme = ["light", "dark"].includes(ds.theme) ? ds.theme : "auto";
  const safeColor = (v, def) => (v && /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\)|hsla?\([\d\s.,%deg]+\))$/i.test(v.trim()) ? v.trim() : def);
  const accent = safeColor(ds.accent, "#1f5c4a");
  const accentText = safeColor(ds.accentText, "#ffffff");
  const font = ds.font && /^[\w\s"',-]+$/.test(ds.font) ? ds.font : "inherit";

  /* ---------------- Estado ---------------- */
  let config = null;
  let messages = []; // {role: "user"|"assistant", content}
  let conversationId = "";
  let busy = false;
  let open = false;
  let lastFailed = null;

  const store = {
    load() {
      try {
        const s = JSON.parse(sessionStorage.getItem(STORE_KEY) || "null");
        if (s && Array.isArray(s.messages)) {
          messages = s.messages.filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string").slice(-60);
          conversationId = typeof s.id === "string" ? s.id : "";
          open = !!s.open;
        }
      } catch (_) { /* almacenamiento no disponible */ }
    },
    save() {
      try { sessionStorage.setItem(STORE_KEY, JSON.stringify({ id: conversationId, messages: messages.slice(-60), open })); } catch (_) { /* nada */ }
    },
  };

  const newId = () => {
    const a = new Uint8Array(12);
    (window.crypto || {}).getRandomValues ? crypto.getRandomValues(a) : a.forEach((_, i) => (a[i] = Math.floor(Math.random() * 256)));
    return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
  };

  /* ---------------- Estilos ---------------- */
  const css = `
:host{all:initial}
*{box-sizing:border-box;margin:0}
.root{
  --accent:${accent}; --accent-fg:${accentText};
  --bg:#ffffff; --surface:#f6f4f1; --surface-2:#efece8; --fg:#1a1614; --muted:#6b625a; --subtle:#9a9087;
  --border:rgba(26,22,20,.10); --border-strong:rgba(26,22,20,.16);
  --shadow:0 1px 2px rgba(26,22,20,.06),0 24px 56px -16px rgba(26,22,20,.28);
  --danger:#c43c3c;
  font-family:${font === "inherit" ? "inherit" : font};
  font-size:15px; line-height:1.5; color:var(--fg);
  -webkit-font-smoothing:antialiased;
}
.root.dark{
  --bg:#141110; --surface:#1b1716; --surface-2:#231e1c; --fg:#ede6dc; --muted:#a39a8f; --subtle:#6f675e;
  --border:rgba(237,230,220,.09); --border-strong:rgba(237,230,220,.15);
  --shadow:0 1px 0 rgba(255,255,255,.03) inset,0 24px 64px -16px rgba(0,0,0,.75);
  --danger:#f06a6a;
}
button,textarea{font:inherit;color:inherit}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:8px}

.launcher{
  position:fixed; bottom:20px; ${position}:20px; z-index:2147483000;
  display:inline-flex; align-items:center; gap:10px;
  height:52px; padding:0 20px 0 16px; border-radius:999px; border:0; cursor:pointer;
  background:var(--accent); color:var(--accent-fg);
  font-weight:600; font-size:14px; letter-spacing:-.005em;
  box-shadow:0 1px 0 rgba(255,255,255,.18) inset,0 10px 30px -8px rgba(0,0,0,.45);
  transition:transform .18s cubic-bezier(.22,1,.36,1),box-shadow .18s,opacity .18s;
}
.launcher:hover{transform:translateY(-2px)}
.launcher:active{transform:translateY(0) scale(.98)}
.launcher svg{flex:none}
.launcher[aria-expanded="true"]{opacity:0;pointer-events:none;transform:scale(.9)}

.panel{
  position:fixed; bottom:20px; ${position}:20px; z-index:2147483001;
  width:min(392px,calc(100vw - 32px)); height:min(620px,calc(100vh - 40px));
  display:flex; flex-direction:column; overflow:hidden;
  background:var(--bg); border:1px solid var(--border-strong); border-radius:18px; box-shadow:var(--shadow);
  transform-origin:bottom ${position};
  animation:pop .22s cubic-bezier(.22,1,.36,1);
}
.panel[hidden]{display:none}
@keyframes pop{from{opacity:0;transform:translateY(10px) scale(.98)}to{opacity:1;transform:none}}

.head{display:flex; align-items:center; gap:12px; padding:14px 14px 14px 16px; border-bottom:1px solid var(--border)}
.avatar{flex:none; display:grid; place-items:center; width:36px; height:36px; border-radius:11px; background:var(--accent); color:var(--accent-fg); font-weight:700; font-size:15px}
.who{flex:1; min-width:0}
.who b{display:block; font-size:15px; font-weight:600; letter-spacing:-.01em; white-space:nowrap; overflow:hidden; text-overflow:ellipsis}
.who span{display:flex; align-items:center; gap:6px; font-size:12px; color:var(--muted)}
.who span::before{content:""; width:6px; height:6px; border-radius:50%; background:#4fb286; box-shadow:0 0 0 3px rgba(79,178,134,.18)}
.icon{display:grid; place-items:center; width:34px; height:34px; border-radius:9px; border:1px solid transparent; background:none; color:var(--muted); cursor:pointer; transition:background-color .15s,color .15s,border-color .15s}
.icon:hover{background:var(--surface); color:var(--fg); border-color:var(--border)}

.log{flex:1; overflow-y:auto; padding:18px 16px 8px; display:flex; flex-direction:column; gap:10px; overscroll-behavior:contain; scroll-behavior:smooth}
.msg{max-width:86%; padding:10px 13px; border-radius:14px; font-size:14.5px; line-height:1.5; white-space:pre-wrap; word-wrap:break-word; overflow-wrap:anywhere; animation:in .2s cubic-bezier(.22,1,.36,1)}
@keyframes in{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
.msg.assistant{align-self:flex-start; background:var(--surface); border:1px solid var(--border); border-bottom-left-radius:5px}
.msg.user{align-self:flex-end; background:var(--accent); color:var(--accent-fg); border-bottom-right-radius:5px}
.msg a{color:inherit; text-decoration:underline; text-underline-offset:2px}
.notice{align-self:stretch; font-size:12px; color:var(--subtle); line-height:1.45; padding:0 2px}
.error{align-self:stretch; display:flex; gap:10px; align-items:center; justify-content:space-between; font-size:13px; color:var(--danger); background:color-mix(in srgb,var(--danger) 9%,transparent); border:1px solid color-mix(in srgb,var(--danger) 30%,transparent); border-radius:10px; padding:8px 10px}
.error button{flex:none; border:1px solid currentColor; background:none; color:inherit; border-radius:7px; padding:3px 10px; font-size:12px; font-weight:600; cursor:pointer}

.typing{align-self:flex-start; display:flex; gap:4px; padding:13px 14px; background:var(--surface); border:1px solid var(--border); border-radius:14px; border-bottom-left-radius:5px}
.typing i{width:6px; height:6px; border-radius:50%; background:var(--subtle); animation:dot 1.2s infinite ease-in-out}
.typing i:nth-child(2){animation-delay:.15s}.typing i:nth-child(3){animation-delay:.3s}
@keyframes dot{0%,60%,100%{opacity:.35;transform:none}30%{opacity:1;transform:translateY(-3px)}}

.chips{display:flex; flex-wrap:wrap; gap:6px; padding:2px 16px 10px}
.chips[hidden]{display:none}
.chip{border:1px solid var(--border-strong); background:var(--bg); border-radius:999px; padding:6px 12px; font-size:13px; cursor:pointer; color:var(--fg); transition:background-color .15s,border-color .15s}
.chip:hover{background:var(--surface); border-color:var(--accent)}

.composer{display:flex; align-items:flex-end; gap:8px; margin:0 12px 12px; padding:6px 6px 6px 14px; border:1px solid var(--border-strong); border-radius:14px; background:var(--surface); transition:border-color .15s,box-shadow .15s}
.composer:focus-within{border-color:var(--accent); box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 18%,transparent)}
textarea{flex:1; border:0; outline:0; background:none; resize:none; max-height:120px; min-height:36px; padding:7px 0; font-size:14.5px; line-height:1.45; overflow-y:hidden; scrollbar-width:thin}
textarea:focus-visible{outline:0}
textarea::placeholder{color:var(--subtle)}
.send{flex:none; display:grid; place-items:center; width:36px; height:36px; border:0; border-radius:10px; background:var(--accent); color:var(--accent-fg); cursor:pointer; transition:opacity .15s,transform .15s}
.send:disabled{opacity:.35; cursor:not-allowed}
.send:not(:disabled):active{transform:scale(.95)}
.foot{display:flex; justify-content:space-between; padding:0 16px 10px; font-size:11px; color:var(--subtle)}
.sr{position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0 0 0 0); white-space:nowrap}

@media (max-width:480px){
  .panel{inset:0; width:100%; height:100%; max-height:none; border-radius:0; border:0}
  .launcher{bottom:16px; ${position}:16px}
}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important;scroll-behavior:auto!important}}
`;

  /* ---------------- DOM ---------------- */
  const host = document.createElement("div");
  host.setAttribute("data-agent-chat", chatId);
  const shadow = host.attachShadow({ mode: "open" });
  const root = document.createElement("div");
  root.className = "root";
  const style = document.createElement("style");
  style.textContent = css;
  shadow.append(style, root);

  const el = (tag, attrs = {}, ...children) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") n.className = v;
      else if (k === "text") n.textContent = v;
      else if (k === "html") n.innerHTML = v; // solo para iconos SVG estáticos de este archivo
      else n.setAttribute(k, v);
    }
    n.append(...children);
    return n;
  };

  const ICON_CHAT = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a8.5 8.5 0 0 1-12.4 7.6L3 21l1.4-5.1A8.5 8.5 0 1 1 21 12z"/></svg>';
  const ICON_CLOSE = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>';
  const ICON_RESET = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 8a5.5 5.5 0 1 0 1.7-4"/><path d="M2.5 2.5v3h3"/></svg>';
  const ICON_SEND = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 13V3M3.5 7.5 8 3l4.5 4.5"/></svg>';

  const panelId = `agent-chat-${chatId.slice(0, 8)}`;
  const launcher = el("button", { class: "launcher", type: "button", "aria-expanded": "false", "aria-controls": panelId });
  const launcherText = el("span");
  launcher.innerHTML = ICON_CHAT;
  launcher.append(launcherText);

  const avatar = el("span", { class: "avatar", "aria-hidden": "true" });
  const titleEl = el("b");
  const resetBtn = el("button", { class: "icon", type: "button", "aria-label": "Empezar una conversación nueva", title: "Nueva conversación", html: ICON_RESET });
  const closeBtn = el("button", { class: "icon", type: "button", "aria-label": "Cerrar el chat", title: "Cerrar", html: ICON_CLOSE });
  const head = el("div", { class: "head" }, avatar, el("div", { class: "who" }, titleEl, el("span", { text: "Responde al momento" })), resetBtn, closeBtn);

  const log = el("div", { class: "log", role: "log", "aria-live": "polite", "aria-relevant": "additions", tabindex: "0" });
  const chips = el("div", { class: "chips", role: "group", "aria-label": "Preguntas sugeridas" });
  const input = el("textarea", { rows: "1", maxlength: String(MAX_CHARS), placeholder: "Escribe tu mensaje…", "aria-label": "Tu mensaje" });
  const sendBtn = el("button", { class: "send", type: "submit", "aria-label": "Enviar mensaje", html: ICON_SEND });
  const composer = el("form", { class: "composer" }, input, sendBtn);
  const counter = el("span", { "aria-hidden": "true" });
  const foot = el("div", { class: "foot" }, el("span", { text: "Asistente con IA · puede equivocarse" }), counter);
  const status = el("p", { class: "sr", role: "status" });
  const panel = el("div", { class: "panel", id: panelId, role: "dialog", "aria-modal": "false", hidden: "" }, head, log, chips, composer, foot, status);

  /* ---------------- Render ---------------- */

  /** Convierte texto plano en nodos, enlazando URLs, correos y teléfonos sin usar innerHTML. */
  function linkify(text) {
    const frag = document.createDocumentFragment();
    const re = /(https?:\/\/[^\s<>()]+[^\s<>().,;:!?¿¡"'])|([\w.+-]+@[\w-]+\.[\w.-]+[a-z])|((?:\+34[\s.]?)?[6-9]\d{2}[\s.]?\d{3}[\s.]?\d{3})/gi;
    let last = 0;
    for (const m of text.matchAll(re)) {
      if (m.index > last) frag.append(text.slice(last, m.index));
      const [match, url, mail, tel] = m;
      const a = document.createElement("a");
      a.textContent = match;
      if (url) { a.href = url; a.target = "_blank"; a.rel = "noopener noreferrer"; }
      else if (mail) a.href = `mailto:${mail}`;
      else if (tel) a.href = `tel:${tel.replace(/[\s.]/g, "")}`;
      frag.append(a);
      last = m.index + match.length;
    }
    if (last < text.length) frag.append(text.slice(last));
    return frag;
  }

  function bubble(role, content) {
    const b = el("div", { class: `msg ${role}` });
    if (role === "assistant") {
      b.append(el("span", { class: "sr", text: `${config ? config.title : "Asistente"} dice: ` }));
      b.append(linkify(content));
    } else {
      b.append(el("span", { class: "sr", text: "Tú: " }), content);
    }
    return b;
  }

  function render() {
    log.textContent = "";
    if (config.greeting) log.append(bubble("assistant", config.greeting));
    if (config.privacyNotice) log.append(el("p", { class: "notice", text: config.privacyNotice }));
    for (const m of messages) log.append(bubble(m.role, m.content));
    chips.hidden = messages.length > 0 || !config.suggestions.length;
    scroll();
  }

  const scroll = () => requestAnimationFrame(() => { log.scrollTop = log.scrollHeight; });

  function setBusy(v) {
    busy = v;
    sendBtn.disabled = v || !input.value.trim();
    input.setAttribute("aria-busy", String(v));
  }

  function autosize() {
    const n = input.value.length;
    counter.textContent = n > MAX_CHARS * 0.8 ? `${n}/${MAX_CHARS}` : "";
    sendBtn.disabled = busy || !input.value.trim();
    if (panel.hidden) return; // oculto, scrollHeight vale 0: se recalcula al abrir
    input.style.height = "auto";
    input.style.height = `${Math.min(Math.max(input.scrollHeight, 36), 120)}px`;
    input.style.overflowY = input.scrollHeight > 120 ? "auto" : "hidden";
  }

  /* ---------------- Envío ---------------- */
  async function send(text) {
    const content = (text || "").trim().slice(0, MAX_CHARS);
    if (!content || busy) return;
    log.querySelectorAll(".error").forEach((n) => n.remove());
    if (!conversationId) conversationId = newId();
    messages.push({ role: "user", content });
    log.append(bubble("user", content));
    chips.hidden = true;
    input.value = "";
    autosize();
    store.save();

    const typing = el("div", { class: "typing", "aria-hidden": "true" }, el("i"), el("i"), el("i"));
    log.append(typing);
    status.textContent = `${config.title} está escribiendo…`;
    scroll();
    setBusy(true);

    // Historial: el saludo no se envía (lo pone el widget); el servidor recorta a los últimos turnos.
    const payload = { conversationId, messages: messages.slice(-MAX_TURNS_SENT) };
    try {
      const res = await fetch(`${ENDPOINT}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        credentials: "omit",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || typeof data.reply !== "string") throw new Error(data.error || "No he podido responder. Inténtalo de nuevo.");
      messages.push({ role: "assistant", content: data.reply });
      typing.remove();
      log.append(bubble("assistant", data.reply));
      status.textContent = "Nueva respuesta.";
      lastFailed = null;
      store.save();
    } catch (e) {
      typing.remove();
      // El mensaje fallido sale del historial para no enviarlo dos veces; se puede reintentar.
      messages.pop();
      store.save();
      lastFailed = content;
      const msg = e instanceof TypeError ? "Sin conexión con el asistente. Revisa tu conexión e inténtalo de nuevo." : e.message;
      const retry = el("button", { type: "button", text: "Reintentar" });
      retry.addEventListener("click", () => {
        const t = lastFailed;
        log.querySelectorAll(".msg.user").forEach((n, i, all) => { if (i === all.length - 1) n.remove(); });
        send(t);
      });
      log.append(el("div", { class: "error", role: "alert" }, el("span", { text: msg }), retry));
    } finally {
      setBusy(false);
      scroll();
      if (open) input.focus({ preventScroll: true });
    }
  }

  /* ---------------- Abrir / cerrar ---------------- */
  function setOpen(v, focus = true) {
    open = v;
    panel.hidden = !v;
    launcher.setAttribute("aria-expanded", String(v));
    launcher.setAttribute("aria-label", v ? `Cerrar el chat con ${config.title}` : `Abrir el chat con ${config.title}`);
    store.save();
    if (v) {
      autosize();
      scroll();
      if (focus) setTimeout(() => input.focus({ preventScroll: true }), 30);
    } else if (focus) launcher.focus({ preventScroll: true });
  }

  launcher.addEventListener("click", () => setOpen(!open));
  closeBtn.addEventListener("click", () => setOpen(false));
  resetBtn.addEventListener("click", () => {
    if (busy) return;
    messages = [];
    conversationId = "";
    lastFailed = null;
    store.save();
    render();
    input.focus();
  });
  panel.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); setOpen(false); } });
  composer.addEventListener("submit", (e) => { e.preventDefault(); send(input.value); });
  input.addEventListener("input", autosize);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(input.value); }
  });

  /* ---------------- Tema ---------------- */
  const mq = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
  const pageTheme = () => document.documentElement.getAttribute("data-theme");
  function applyTheme() {
    const dark = theme === "dark" || (theme === "auto" && (pageTheme() ? pageTheme() === "dark" : !!(mq && mq.matches)));
    root.classList.toggle("dark", dark);
  }
  if (theme === "auto") {
    mq && mq.addEventListener && mq.addEventListener("change", applyTheme);
    // Si la web cambia de tema con data-theme en <html>, el chat lo sigue.
    new MutationObserver(applyTheme).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  }

  /* ---------------- Arranque ---------------- */
  async function init() {
    try {
      const res = await fetch(ENDPOINT, { credentials: "omit" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      if (!data.available) return; // chat pausado: no se muestra nada
      config = {
        title: String(data.title || "Asistente"),
        greeting: String(data.greeting || ""),
        suggestions: Array.isArray(data.suggestions) ? data.suggestions.map(String).slice(0, 4) : [],
        privacyNotice: String(data.privacyNotice || ""),
      };
    } catch (e) {
      console.warn("[chat] No se pudo cargar el chat:", e.message);
      return;
    }

    applyTheme();
    titleEl.textContent = config.title;
    avatar.textContent = config.title.trim().charAt(0).toUpperCase() || "?";
    launcherText.textContent = (ds.label || `Pregunta a ${config.title}`).slice(0, 40);
    panel.setAttribute("aria-label", `Chat con ${config.title}`);
    for (const s of config.suggestions) {
      const chip = el("button", { class: "chip", type: "button", text: s });
      chip.addEventListener("click", () => send(s));
      chips.append(chip);
    }

    store.load();
    root.append(launcher, panel);
    document.body.append(host);
    render();
    autosize();
    setOpen(open, false);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init, { once: true });
  else init();
})();
