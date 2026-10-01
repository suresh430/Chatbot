/* ============================================================
 * Cloudify Website Chatbot — embeddable widget
 * ------------------------------------------------------------
 * One file, zero dependencies. Answers visitor questions using
 * kb.json, a knowledge base generated from the Framer website
 * by build_kb.py. Re-run build_kb.py whenever the site changes
 * and the bot's answers update automatically.
 *
 * Embed (Framer: Site Settings → Custom Code → End of <body>):
 *
 *   <script src="https://YOUR-HOST/chatbot-widget.js"
 *           data-kb="https://YOUR-HOST/kb.json"
 *           data-name="Cloudify"
 *           data-color="#1d4ed8"></script>
 *
 * Backend mode (recommended for production): point the widget at the API —
 *   <script src="https://YOUR-HOST/chatbot-widget.js"
 *           data-api="https://your-api.example.com/chat"
 *           data-name="Cloudify"></script>
 * or window.CloudifyChat = { apiUrl: "https://your-api.example.com/chat" }.
 * The widget POSTs {message} and renders answer+sources; if the API is
 * unreachable it falls back to the local kb.json search.
 *
 * Optional global config (set BEFORE the script tag):
 *   window.CloudifyChat = { kbUrl, name, color, position, welcome, chips };
 * ============================================================ */
(function () {
"use strict";

/* ---------------- search engine (pure, DOM-free, node-testable) ---------------- */

var STOPWORDS = {};
("a about above after again against all am an and any are as at be because been before being below between both but by can could did do does doing down during each few for from further had has have having he her here hers herself him himself his how i if in into is it its itself me more most my myself no nor not of off on once only or other ought our ours ourselves out over own same she should so some such than that the their theirs them themselves then there these they this those through to too under until up very was we were what when where which while who whom why will with you your yours yourself yourselves whats whats dont doesnt isnt isnt cant wont im ive youre theyre thats theres whats").split(" ").forEach(function (w) { STOPWORDS[w] = 1; });

function tokenize(s) {
  return (s || "").toLowerCase().replace(/[^a-z0-9'\s]/g, " ").split(/\s+/)
    .map(function (t) { return t.replace(/^'+|'+$/g, ""); })
    .filter(function (t) { return t.length > 1 && !STOPWORDS[t]; });
}

function buildIndex(chunks) {
  var df = {}, docs = [], N = chunks.length, i, j, toks, tf, seen;
  for (i = 0; i < N; i++) {
    toks = tokenize(chunks[i].text + " " + chunks[i].title + " " + chunks[i].title);
    tf = {}; seen = {};
    for (j = 0; j < toks.length; j++) {
      tf[toks[j]] = (tf[toks[j]] || 0) + 1;
      if (!seen[toks[j]]) { df[toks[j]] = (df[toks[j]] || 0) + 1; seen[toks[j]] = 1; }
    }
    docs.push({ tf: tf, len: toks.length });
  }
  var idf = {};
  Object.keys(df).forEach(function (t) { idf[t] = Math.log((N + 1) / (df[t] + 1)) + 1; });
  // precompute tf-idf vectors + norms
  var vecs = docs.map(function (d) {
    var v = {}, norm = 0, t, w;
    for (t in d.tf) {
      w = (d.tf[t] / d.len) * (idf[t] || 0);
      v[t] = w; norm += w * w;
    }
    return { v: v, norm: Math.sqrt(norm) || 1 };
  });
  return { chunks: chunks, idf: idf, vecs: vecs, N: N };
}

function search(index, query, topK) {
  topK = topK || 3;
  var qtoks = tokenize(query), i, t;
  if (!qtoks.length) return [];
  var qtf = {}, qv = {}, qnorm = 0, w;
  qtoks.forEach(function (x) { qtf[x] = (qtf[x] || 0) + 1; });
  Object.keys(qtf).forEach(function (x) {
    w = (qtf[x] / qtoks.length) * (index.idf[x] || 0);
    if (w > 0) { qv[x] = w; qnorm += w * w; }
  });
  qnorm = Math.sqrt(qnorm) || 1;
  var scored = [];
  for (i = 0; i < index.N; i++) {
    var dv = index.vecs[i], dot = 0, matched = 0;
    for (t in qv) { if (dv.v[t]) { dot += qv[t] * dv.v[t]; matched++; } }
    if (dot <= 0) continue;
    var cos = dot / (qnorm * dv.norm);
    // bonus when query words appear in the page title
    var titleToks = tokenize(index.chunks[i].title), hit = 0;
    qtoks.forEach(function (x) { if (titleToks.indexOf(x) !== -1) hit++; });
    cos += 0.35 * (hit / qtoks.length);
    scored.push({ i: i, score: cos, matched: matched });
  }
  scored.sort(function (a, b) { return b.score - a.score; });
  return scored.slice(0, topK).map(function (s) {
    return { chunk: index.chunks[s.i], score: s.score, matched: s.matched };
  });
}

// light query expansion so visitor wording hits site wording
var SYNONYMS = {
  services: "solutions offerings", service: "solution",
  pricing: "price cost", price: "pricing cost", cost: "pricing price", prices: "pricing",
  demo: "trial demonstration", contact: "email phone reach",
  company: "about us", integrations: "integration apps", integration: "integrations apps"
};
function expandQuery(q) {
  var extra = [];
  tokenize(q).forEach(function (t) { if (SYNONYMS[t]) extra.push(SYNONYMS[t]); });
  return extra.length ? q + " " + extra.join(" ") : q;
}
// a match counts when it's strong, or decent with at least 2 query terms hitting
function goodMatch(r) {
  return r.score >= 0.55 || (r.score >= 0.30 && r.matched >= 2);
}

var ChatEngine = { tokenize: tokenize, buildIndex: buildIndex, search: search, expandQuery: expandQuery, goodMatch: goodMatch };
if (typeof module !== "undefined" && module.exports) module.exports = ChatEngine;

/* ---------------- widget (browser only) ---------------- */
if (typeof window === "undefined" || typeof document === "undefined") return;

var scriptTag = document.currentScript;
function dataAttr(k, fb) {
  return (scriptTag && scriptTag.getAttribute("data-" + k)) || fb;
}
var userCfg = window.CloudifyChat || {};
var CFG = {
  kbUrl:    userCfg.kbUrl    || dataAttr("kb", "kb.json"),
  apiUrl:   userCfg.apiUrl   || dataAttr("api", ""), // e.g. https://your-api/chat — when set, the widget POSTs here instead of searching locally
  name:     userCfg.name     || dataAttr("name", "Cloudify"),
  color:    userCfg.color    || dataAttr("color", "#1d4ed8"),
  position: userCfg.position || dataAttr("position", "right"), // right | left
  welcome:  userCfg.welcome  || null,
  chips:    userCfg.chips    || ["How do I connect my Xero account?", "How do I create an invoice from HubSpot?", "How do I cancel my subscription?"]
};
var CONTACT_URL = "https://cloudify.biz/contact";
var BOOK_URL = "https://meetings.hubspot.com/cloudify/app-assistance";

/* ---------- tiny intent layer (runs before KB search) ---------- */
function intentReply(q) {
  var s = q.toLowerCase().trim();
  if (/^(hi|hii+|hello|hey|yo|namaste|good (morning|afternoon|evening))\b/.test(s) || s.length < 3 && /^(hi|hey)$/.test(s))
    return { text: "Hello! 👋 Great to see you here. " + helpLine(), chips: CFG.chips };
  if (/\b(thank|thanks|thx|dhanyavad)\b/.test(s))
    return { text: "You're very welcome! 😊 Anything else I can help with?", chips: CFG.chips };
  if (/\b(bye|goodbye|see you|good night)\b/.test(s))
    return { text: "Goodbye for now! 👋 If you need anything later, I'll be right here.", chips: [] };
  if (/\b(book|demo|consultation|consult|call|talk to (a |someone|human)|human|agent|support|contact|email|phone)\b/.test(s))
    return { html: "You can <b>book a free consultation</b> with our team here:<br><br>👉 <a href=\"" + BOOK_URL + "\" target=\"_blank\" rel=\"noopener\">Book a free consultation</a><br>Or reach us via the <a href=\"" + CONTACT_URL + "\" target=\"_blank\" rel=\"noopener\">contact page</a>.",
             text: "You can book a free consultation with our team.", chips: ["What services do you offer?"] };
  if (/\b(who are you|your name|what are you)\b/.test(s))
    return { text: "I'm " + CFG.name + ", the Cloudify docs assistant. I answer from our documentation — ask me about installing, configuring, or troubleshooting an integration!", chips: CFG.chips };
  return null;
}
function helpLine() {
  return "How can I help you today? Ask me about installing, configuring, or troubleshooting an integration.";
}

/* ---------- styles ---------- */
var CSS = [
".cfb-launcher{position:fixed;bottom:24px;z-index:2147483000;width:60px;height:60px;border-radius:50%;border:none;cursor:pointer;box-shadow:0 6px 24px rgba(0,0,0,.25);display:flex;align-items:center;justify-content:center;transition:transform .15s}",
".cfb-launcher:hover{transform:scale(1.07)}",
".cfb-launcher svg{width:30px;height:30px;fill:#fff}",
".cfb-panel{position:fixed;bottom:96px;z-index:2147483000;width:380px;max-width:calc(100vw - 32px);height:560px;max-height:calc(100vh - 140px);background:#fff;border-radius:16px;box-shadow:0 12px 48px rgba(0,0,0,.28);display:none;flex-direction:column;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif}",
".cfb-panel.open{display:flex}",
".cfb-head{padding:16px;background:VAR_COLOR;color:#fff}",
".cfb-head h3{margin:0;font-size:16px;font-weight:650}",
".cfb-head p{margin:2px 0 0;font-size:12px;opacity:.85}",
".cfb-head button{position:absolute;top:10px;right:10px;background:rgba(255,255,255,.2);border:none;color:#fff;width:28px;height:28px;border-radius:50%;cursor:pointer;font-size:15px;line-height:1}",
".cfb-body{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:10px;background:#f6f7f9}",
".cfb-msg{max-width:85%;padding:10px 14px;border-radius:14px;font-size:14px;line-height:1.5;word-wrap:break-word}",
".cfb-bot{background:#fff;color:#1f2937;border-bottom-left-radius:4px;align-self:flex-start;box-shadow:0 1px 3px rgba(0,0,0,.08)}",
".cfb-user{background:VAR_COLOR;color:#fff;border-bottom-right-radius:4px;align-self:flex-end}",
".cfb-msg a{color:VAR_COLOR;font-weight:600}",
".cfb-src{display:block;margin-top:8px;padding-top:8px;border-top:1px solid #eef0f3;font-size:12px}",
".cfb-typing{display:inline-flex;gap:5px;padding:12px 16px}",
".cfb-typing span{width:8px;height:8px;border-radius:50%;background:#9ca3af;animation:cfb-b 1.2s infinite}",
".cfb-typing span:nth-child(2){animation-delay:.15s}.cfb-typing span:nth-child(3){animation-delay:.3s}",
"@keyframes cfb-b{0%,60%,100%{transform:none;opacity:.4}30%{transform:translateY(-5px);opacity:1}}",
".cfb-chips{display:flex;flex-wrap:wrap;gap:8px}",
".cfb-chip{border:1.5px solid VAR_COLOR;color:VAR_COLOR;background:#fff;border-radius:999px;padding:7px 13px;font-size:13px;cursor:pointer;font-weight:550}",
".cfb-chip:hover{background:VAR_COLOR;color:#fff}",
".cfb-foot{display:flex;gap:8px;padding:12px;border-top:1px solid #eef0f3;background:#fff}",
".cfb-foot input{flex:1;border:1.5px solid #e5e7eb;border-radius:999px;padding:10px 16px;font-size:14px;outline:none}",
".cfb-foot input:focus{border-color:VAR_COLOR}",
".cfb-foot button{border:none;background:VAR_COLOR;color:#fff;border-radius:50%;width:42px;height:42px;cursor:pointer;font-size:17px;flex-shrink:0}",
".cfb-foot button:disabled{opacity:.5;cursor:default}"
].join("\n").replace(/VAR_COLOR/g, CFG.color);

var POS = CFG.position === "left" ? "left:24px" : "right:24px";

/* ---------- DOM ---------- */
function el(html) {
  var d = document.createElement("div");
  d.innerHTML = html.trim();
  return d.firstChild;
}
var style = document.createElement("style");
style.textContent = CSS;
document.head.appendChild(style);

var launcher = el(
  '<button class="cfb-launcher" style="background:' + CFG.color + ";" + POS + '" aria-label="Open chat">' +
  '<svg viewBox="0 0 24 24"><path d="M20 2H4a2 2 0 0 0-2 2v18l4-4h14a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2z"/></svg></button>');

var panel = el(
  '<div class="cfb-panel" style="' + POS + '">' +
    '<div class="cfb-head" style="position:relative">' +
      '<h3>' + escapeHtml(CFG.name) + ' · Cloudify assistant</h3>' +
      '<p>Answers from cloudify.biz · replies instantly</p>' +
      '<button aria-label="Close chat">✕</button>' +
    '</div>' +
    '<div class="cfb-body"></div>' +
    '<div class="cfb-foot"><input type="text" placeholder="Ask a question…" aria-label="Ask a question"><button aria-label="Send">➤</button></div>' +
  '</div>');

document.body.appendChild(launcher);
document.body.appendChild(panel);

var body = panel.querySelector(".cfb-body");
var input = panel.querySelector(".cfb-foot input");
var sendBtn = panel.querySelector(".cfb-foot button");
var closeBtn = panel.querySelector(".cfb-head button");

function escapeHtml(s) {
  return (s || "").replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}

/* ---------- chat behavior ---------- */
var opened = false, kbIndex = null, kbMeta = null, kbFailed = false;

function scrollDown() { body.scrollTop = body.scrollHeight; }

function addMsg(cls, html) {
  var m = el('<div class="cfb-msg ' + cls + '">' + html + "</div>");
  body.appendChild(m);
  scrollDown();
  return m;
}
function addChips(list) {
  if (!list || !list.length) return;
  var wrap = el('<div class="cfb-chips"></div>');
  list.forEach(function (c) {
    var b = el('<button class="cfb-chip">' + escapeHtml(c) + "</button>");
    b.onclick = function () { handleUser(c); };
    wrap.appendChild(b);
  });
  body.appendChild(wrap);
  scrollDown();
}
function typing(on) {
  var t = body.querySelector(".cfb-typing");
  if (on && !t) {
    t = el('<div class="cfb-msg cfb-bot cfb-typing"><span></span><span></span><span></span></div>');
    body.appendChild(t); scrollDown();
  } else if (!on && t) { t.remove(); }
  return t;
}
function botSay(html, chips, delay) {
  typing(true);
  setTimeout(function () {
    typing(false);
    addMsg("cfb-bot", html);
    addChips(chips);
  }, delay || 700);
}
function trimText(t, n) {
  t = (t || "").replace(/\s+/g, " ").trim();
  if (t.length <= n) return escapeHtml(t);
  var cut = t.lastIndexOf(" ", n);
  return escapeHtml(t.slice(0, cut > n * 0.6 ? cut : n)) + "…";
}
function srcLink(chunk) {
  var title = escapeHtml(chunk.title || chunk.url);
  return '<span class="cfb-src">📄 Source: <a href="' + escapeHtml(chunk.url) + '" target="_blank" rel="noopener">' + title + "</a></span>";
}

function answerFromKB(q) {
  var results = search(kbIndex, expandQuery(q), 3).filter(goodMatch);
  if (!results.length) {
    return {
      html: "I couldn't find that in our documentation. 🤔 Try asking about <b>installing</b>, <b>configuring</b>, or <b>troubleshooting</b> an integration — or <a href=\"" + CONTACT_URL + "\" target=\"_blank\" rel=\"noopener\">contact our team</a> directly and we'll help!",
      chips: CFG.chips
    };
  }
  var htmlOut = "Here's what I found:" + "<br><br>" + trimText(results[0].chunk.text, 420) + srcLink(results[0].chunk);
  // include a second source when it's a close second from a different page
  if (results[1] && results[1].score >= results[0].score * 0.75 &&
      results[1].chunk.url !== results[0].chunk.url) {
    htmlOut += "<br><br>Related: " + trimText(results[1].chunk.text, 280) + srcLink(results[1].chunk);
  }
  var chips = ["How do I connect my Xero account?", "How do I cancel my subscription?"];
  return { html: htmlOut, chips: chips };
}

function handleUser(text) {
  text = (text || "").trim();
  if (!text) return;
  addMsg("cfb-user", escapeHtml(text));
  input.value = "";
  var ir = intentReply(text);
  if (ir) { botSay(ir.html || escapeHtml(ir.text), ir.chips); return; }
  if (CFG.apiUrl) { askApi(text); return; }
  if (kbFailed) {
    botSay("I'm having trouble reaching my knowledge base right now. 😅 Please <a href=\"" + CONTACT_URL + "\" target=\"_blank\" rel=\"noopener\">contact our team</a> directly — we'll get back to you quickly.", []);
    return;
  }
  if (!kbIndex) { // KB still loading: answer as soon as it's ready, no duplicate message
    botSay("One moment — I'm loading the latest info from our website… ⏳", []);
    answerWhenReady(text, 6);
    return;
  }
  var a = answerFromKB(text);
  botSay(a.html, a.chips);
}

/* ---------- API mode: POST to backend, fall back to local KB on failure ---------- */
function askApi(text) {
  typing(true);
  fetch(CFG.apiUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: text })
  }).then(function (r) {
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
  }).then(function (res) {
    typing(false);
    var htmlOut = escapeHtml(res.answer).replace(/\n/g, "<br>");
    (res.sources || []).forEach(function (s) {
      htmlOut += '<span class="cfb-src">📄 Source: <a href="' + escapeHtml(s.url) +
        '" target="_blank" rel="noopener">' + escapeHtml(s.title || s.url) + "</a></span>";
    });
    addMsg("cfb-bot", htmlOut);
    addChips(CFG.chips);
  }).catch(function () {
    typing(false);
    // fall back to local KB so the visitor still gets an answer
    if (kbFailed) {
      botSay("I'm having trouble reaching my knowledge base right now. 😅 Please <a href=\"" + CONTACT_URL + "\" target=\"_blank\" rel=\"noopener\">contact our team</a> directly — we'll get back to you quickly.", []);
    } else if (kbIndex) {
      var a = answerFromKB(text);
      botSay(a.html, a.chips);
    } else {
      answerWhenReady(text, 6);
    }
  });
}

function answerWhenReady(text, triesLeft) {  setTimeout(function () {
    if (kbFailed) {
      botSay("I'm having trouble reaching my knowledge base right now. 😅 Please <a href=\"" + CONTACT_URL + "\" target=\"_blank\" rel=\"noopener\">contact our team</a> directly — we'll get back to you quickly.", []);
      return;
    }
    if (kbIndex) {
      var a = answerFromKB(text);
      botSay(a.html, a.chips);
    } else if (triesLeft > 1) {
      answerWhenReady(text, triesLeft - 1);
    } else {
      botSay("Still loading — please try asking again in a moment. ⏳", []);
    }
  }, 1200);
}

/* ---------- KB load (cache-busted so rebuilds are picked up) ---------- */
function loadKB() {
  var url = CFG.kbUrl + (CFG.kbUrl.indexOf("?") === -1 ? "?" : "&") + "v=" + Date.now();
  fetch(url).then(function (r) {
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
  }).then(function (kb) {
    kbMeta = { generated: kb.generated_at, chunks: kb.chunk_count };
    kbIndex = buildIndex(kb.chunks || []);
  }).catch(function (e) {
    kbFailed = true;
    if (typeof console !== "undefined") console.warn("[chatbot] KB load failed:", e);
  });
}

/* ---------- open / close ---------- */
function toggle(open) {
  var willOpen = typeof open === "boolean" ? open : !panel.classList.contains("open");
  panel.classList.toggle("open", willOpen);
  launcher.style.display = willOpen ? "none" : "flex";
  if (willOpen) {
    if (!opened) {
      opened = true;
      var w1 = CFG.welcome || ("Hi there! 👋 Welcome to <b>Cloudify</b>. I'm " + escapeHtml(CFG.name) + ", your website assistant.");
      botSay(w1, null, 500);
      setTimeout(function () { botSay(helpLine(), CFG.chips); }, 1400);
    }
    setTimeout(function () { input.focus(); }, 150);
  }
}
launcher.onclick = function () { toggle(true); };
closeBtn.onclick = function () { toggle(false); };
sendBtn.onclick = function () { handleUser(input.value); };
input.addEventListener("keydown", function (e) {
  if (e.key === "Enter") handleUser(input.value);
});
document.addEventListener("keydown", function (e) {
  if (e.key === "Escape") toggle(false);
});

loadKB();
})();
