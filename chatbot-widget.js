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
  // stable page-order positions (survive combo sub-index rebuilds)
  chunks.forEach(function (c, idx) { if (c._pos === undefined) c._pos = idx; });
  // combo catalog: "pipedrive/xero" -> chunk count (for "show all combos" disambiguation)
  var combos = {};
  chunks.forEach(function (c) {
    var k = comboOf(c.url);
    if (k) combos[k] = (combos[k] || 0) + 1;
  });
  return { chunks: chunks, idf: idf, df: df, vecs: vecs, N: N, combos: combos };
}

// edit distance with early exit (for typo-tolerant search)
function editDistance(a, b, maxEd) {
  var m = a.length, n = b.length, i, j, cost, rowMin, tmp;
  if (Math.abs(m - n) > maxEd) return maxEd + 1;
  var prev = [], cur = [];
  for (j = 0; j <= n; j++) prev[j] = j;
  for (i = 1; i <= m; i++) {
    cur[0] = i; rowMin = i;
    for (j = 1; j <= n; j++) {
      cost = a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > maxEd) return maxEd + 1;
    tmp = prev; prev = cur; cur = tmp;
  }
  return prev[n];
}
// fix a misspelled query word ("reccuring" -> "recurring") using the KB vocabulary
function correctSpelling(index, tok) {
  if (index.idf[tok] || tok.length < 4) return tok;
  var maxEd = tok.length >= 7 ? 2 : 1;
  var terms = Object.keys(index.idf), best = null, bestEd = maxEd + 1, bestDf = -1, i, t, ed, df;
  for (i = 0; i < terms.length; i++) {
    t = terms[i];
    if (t.length < 4 || Math.abs(t.length - tok.length) > maxEd) continue;
    if (t.charAt(0) !== tok.charAt(0)) continue;
    ed = editDistance(tok, t, maxEd);
    if (ed <= maxEd) {
      df = (index.df && index.df[t]) || 0;
      if (ed < bestEd || (ed === bestEd && df > bestDf)) { best = t; bestEd = ed; bestDf = df; }
    }
  }
  return best || tok;
}
function search(index, query, topK) {
  topK = topK || 3;
  var qtoks = tokenize(query), i, t;
  if (!qtoks.length) return [];
  qtoks = qtoks.map(function (tok) { return correctSpelling(index, tok); });
  // Use CORRECTED tokens for combo matching too — otherwise a typo like
  // "pipedrivee" won't boost the pipedrive combos ("qn" had the raw typo).
  var qn = qtoks.join(" ");
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
    // bonus when the visitor named the chunk's app combo ("Xero in Pipedrive")
    var cb = comboOf(index.chunks[i].url);
    if (cb) cos += comboBoost(cb, qn);
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

/* ---------- app-combo awareness ----------
 * Cloudify sells integration combos (Pipedrive+Xero, HubSpot+e-conomic, ...),
 * and the combo lives in the docs URL (/pipedrive/xero/...). We use it to:
 *  1. boost chunks whose combo the visitor named ("Xero in Pipedrive"),
 *  2. ask WHICH combo they mean when top hits span several ("connect Xero"),
 *  3. never mix a "related" source from a different combo into an answer. */
var KNOWN_APPS = ["hubspot", "pipedrive", "shopify", "stripe", "woocommerce", "shopi",
  "xero", "e-conomic", "fortnox", "tripletex", "msbc", "quickbooks",
  "pennylane", "flowlink", "exactonline", "danish-cvr", "company-vat"];
var APP_LABELS = {
  "hubspot": "HubSpot", "pipedrive": "Pipedrive", "shopify": "Shopify",
  "stripe": "Stripe", "woocommerce": "WooCommerce", "shopi": "Shopi",
  "xero": "Xero", "e-conomic": "e-conomic", "fortnox": "Fortnox",
  "tripletex": "Tripletex", "msbc": "Business Central", "quickbooks": "QuickBooks",
  "pennylane": "Pennylane", "flowlink": "FlowLink", "exactonline": "Exact Online",
  "danish-cvr": "Danish CVR", "company-vat": "Company VAT"
};
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
/* Docs domain vocabulary for out-of-scope detection ("capital of France" names no
 * app and has none of these words — it's not a Cloudify question at all). */
var DOMAIN_WORDS = {setup:1, install:1, installation:1, configure:1, configuration:1,
  invoice:1, invoices:1, invoicing:1, quote:1, quotes:1, sync:1, synced:1, syncing:1,
  synchronise:1, synchronize:1, connect:1, connected:1, connecting:1, connection:1,
  integration:1, integrations:1, integrate:1, app:1, apps:1, account:1, accounts:1,
  subscription:1, subscriptions:1, trial:1, pricing:1, price:1, cost:1, billing:1,
  cancel:1, cancellation:1, refund:1, support:1, error:1, errors:1, issue:1, issues:1,
  problem:1, problems:1, failed:1, failure:1, troubleshooting:1, guide:1, documentation:1,
  docs:1, workflow:1, workflows:1, customer:1, customers:1, product:1, products:1,
  contact:1, contacts:1, deal:1, deals:1, payment:1, payments:1, tax:1, taxes:1,
  mapping:1, mapped:1, field:1, fields:1, api:1, webhook:1, automate:1, automation:1,
  manual:1, how:1, why:1, benefits:1, benefit:1, features:1, feature:1, advantages:1,
  advantage:1};
function isAppSeg(seg) {
  seg = (seg || "").toLowerCase();
  if (KNOWN_APPS.indexOf(seg) !== -1) return true; // full match first: "e-conomic", "danish-cvr"
  var parts = seg.split("-"), i;
  for (i = 0; i < parts.length; i++) {
    if (KNOWN_APPS.indexOf(parts[i]) !== -1) return true;
  }
  return false;
}
// "https://docs.cloudify.biz/pipedrive/xero/installation/..." -> "pipedrive/xero", else null
function comboOf(url) {
  var m = /^https?:\/\/[^\/]+\/([^?#]+)/.exec(url || "");
  if (!m) return null;
  var segs = m[1].split("/").filter(function (s) { return s; });
  if (segs.length < 2) return null;
  var a = segs[0].toLowerCase(), b = segs[1].toLowerCase();
  if (!isAppSeg(a) || !isAppSeg(b)) return null;
  return a + "/" + b;
}
function prettySeg(seg) {
  seg = (seg || "").toLowerCase();
  if (APP_LABELS[seg]) return APP_LABELS[seg];
  return seg.split("-").map(function (p) {
    return APP_LABELS[p] || (p.charAt(0).toUpperCase() + p.slice(1));
  }).join(" ");
}
function comboLabel(key) {
  var s = key.split("/"), a = prettySeg(s[0]), b = prettySeg(s[1]);
  if (b.toLowerCase().indexOf(a.toLowerCase()) !== -1) return b; // "WooCommerce Xero"
  return a + " + " + b;
}
// strings whose presence in the query names this combo, e.g. ["pipedrive","xero"]
function comboMatchStrings(key) {
  var out = [];
  key.split("/").forEach(function (seg) {
    var norm = seg.replace(/-/g, " ");
    if (out.indexOf(norm) === -1) out.push(norm);
    var lbl = (APP_LABELS[seg] || "").toLowerCase();
    if (lbl && out.indexOf(lbl) === -1) out.push(lbl);
  });
  return out;
}
// +0.6 per named app of this combo found in the query (word-boundary matched)
function comboBoost(key, qnorm) {
  var strs = comboMatchStrings(key), boost = 0, i, re;
  for (i = 0; i < strs.length; i++) {
    if (!strs[i]) continue;
    re = new RegExp("\\b" + escapeRe(strs[i]) + "\\b");
    if (re.test(qnorm)) boost += 0.6;
  }
  return boost;
}
// known apps the visitor mentioned, e.g. "connect xero in pipedrive" -> ["xero","pipedrive"]
// Typo-tolerant: "hubspott", "xerro", "shopfy" still match (same rules as correctSpelling).
function namedApps(qnorm) {
  var found = [];
  var toks = qnorm.split(/[^a-z0-9]+/);
  // Tokens that exactly match an app are "claimed" — they must not also
  // typo-match a different app (e.g. "shopify" must not match "shopi").
  var claimed = {};
  KNOWN_APPS.forEach(function (app) {
    var variants = [app.replace(/-/g, " "), app.replace(/-/g, "")];
    var lbl = (APP_LABELS[app] || "").toLowerCase();
    if (lbl && variants.indexOf(lbl) === -1) variants.push(lbl);
    for (var i = 0; i < variants.length; i++) {
      var re = new RegExp("\\b" + escapeRe(variants[i]) + "\\b");
      var m = qnorm.match(re);
      if (m) {
        // mark the matched token(s) as claimed
        variants[i].split(" ").forEach(function (w) { claimed[w] = 1; });
      }
    }
  });
  KNOWN_APPS.forEach(function (app) {
    // hyphenated apps need all spellings: "e-conomic", "e conomic", "economic"
    var variants = [app.replace(/-/g, " "), app.replace(/-/g, "")];
    var lbl = (APP_LABELS[app] || "").toLowerCase();
    if (lbl && variants.indexOf(lbl) === -1) variants.push(lbl);
    var matched = false;
    for (var i = 0; i < variants.length; i++) {
      if (new RegExp("\\b" + escapeRe(variants[i]) + "\\b").test(qnorm)) {
        matched = true;
        break;
      }
    }
    if (!matched) {
      // no exact hit — try typo tolerance on each unclaimed query token
      for (var t = 0; t < toks.length && !matched; t++) {
        var tok = toks[t];
        if (tok.length < 4 || claimed[tok]) continue;
        for (var v = 0; v < variants.length && !matched; v++) {
          var variant = variants[v].replace(/ /g, "");
          if (variant.length < 4 || tok.charAt(0) !== variant.charAt(0)) continue;
          var maxEd = tok.length >= 7 ? 2 : 1;
          if (Math.abs(tok.length - variant.length) > maxEd) continue;
          if (editDistance(tok, variant, maxEd) <= maxEd) matched = true;
        }
      }
    }
    if (matched) found.push(app);
  });
  return found;
}
function comboHasApp(key, app) {
  var want = (APP_LABELS[app] || app).toLowerCase();
  var segs = key.split("/"), i, j;
  for (i = 0; i < segs.length; i++) {
    var seg = segs[i].toLowerCase();
    if (seg === app) return true;
    if ((APP_LABELS[seg] || "").toLowerCase() === want) return true;
    var parts = seg.split("-"); // composite segs like "woocommerce-xero"
    for (j = 0; j < parts.length; j++) {
      if (parts[j] === app) return true;
      if ((APP_LABELS[parts[j]] || "").toLowerCase() === want) return true;
    }
  }
  return false;
}
// every combo containing this app, most-documented first: "xero" -> ["pipedrive/xero","hubspot/xero",...]
function combosForApp(combos, app) {
  var out = [];
  Object.keys(combos).forEach(function (key) {
    if (comboHasApp(key, app)) out.push(key);
  });
  out.sort(function (a, b) { return combos[b] - combos[a]; });
  return out;
}
// Pure decision: every question goes combo-first. Answer directly only when the
// visitor already named one combo ("Xero in Pipedrive"); otherwise ask which
// integration they mean - with all combos for the named app, or the most
// popular integrations when no app was named. Never returns a "related"
// source from a different combo.
function comboOrder(results) {
  var byCombo = {}, order = [], i, r, cb;
  for (i = 0; i < results.length; i++) {
    r = results[i]; cb = comboOf(r.chunk.url);
    if (cb && !(cb in byCombo)) { byCombo[cb] = r.score; order.push(cb); }
  }
  return order;
}
function topCombos(combos, n) {
  return Object.keys(combos).sort(function (a, b) { return combos[b] - combos[a]; }).slice(0, n);
}
function comboChips(keys) {
  var seen = {}, labels = [], options = {};
  keys.forEach(function (key) {
    if (seen[key]) return;
    seen[key] = 1;
    var label = comboLabel(key);
    labels.push(label);
    options[label] = key;
  });
  // "Others" lets the visitor name an integration not in the listed combos
  labels.push("Others");
  options["Others"] = "__others__";
  return { labels: labels, options: options };
}
// Friendly message for app combos we don't have: acknowledges what they want,
// then guides them to custom integration services.
function customComboMessage(rawText) {
  var apps = namedApps((rawText || "").toLowerCase().replace(/-/g, " "));
  var name = apps.length
    ? apps.map(function (a) { return prettySeg(a); }).join(" + ")
    : escapeHtml(rawText);
  return "Got it! " + name + " — nice combination! 😊<br><br>" +
    "If you're looking to connect these apps, we can help you set up a custom integration based on what you need.<br><br>" +
    "👉 <a href=\"https://custom.cloudify.biz\" target=\"_blank\" rel=\"noopener\">Get a Custom Integration: custom.cloudify.biz</a><br>" +
    "📩 <a href=\"mailto:" + SUPPORT_EMAIL + "\">" + SUPPORT_EMAIL + "</a> — our team will be happy to help! 🤝";
}
// Match free-typed app names ("HubSpot + QuickBooks") to a known combo key.
// Returns the combo key, or null if nothing matches.
// When 2+ apps are named, ALL must be in the combo — a partial match (e.g.
// "Stripe Xero" matching "hubspot/xero" via just "xero") is worse than no match.
function matchTypedCombo(text) {
  if (!kbIndex || !kbIndex.combos) return null;
  var qnorm = (text || "").toLowerCase().replace(/-/g, " ");
  var apps = namedApps(qnorm);
  if (!apps.length) return null;
  var keys = Object.keys(kbIndex.combos), best = null, bestScore = 0, i, key, score;
  for (i = 0; i < keys.length; i++) {
    key = keys[i];
    score = 0;
    apps.forEach(function (app) { if (comboHasApp(key, app)) score++; });
    // prefer the combo that matches ALL named apps; break ties by popularity
    if (score > bestScore || (score === bestScore && score === apps.length && best && kbIndex.combos[key] > kbIndex.combos[best])) {
      bestScore = score;
      best = key;
    }
  }
  // multi-app request with no combo covering all of them -> no match (don't guess)
  if (apps.length > 1 && bestScore < apps.length) return null;
  return bestScore > 0 ? best : null;
}
function pageSteps(index, primary, maxSteps) {
  // steps for a rich answer: the primary chunk's page, in page order,
  // starting one chunk before the primary (for context) — up to maxSteps.
  // Gives the fallback and the AI rewrite enough material for real steps.
  var url = primary.chunk.url, page = [], i, c;
  for (i = 0; i < index.chunks.length; i++) {
    c = index.chunks[i];
    if (c.url === url) page.push(c);
  }
  page.sort(function (a, b) { return (a._pos || 0) - (b._pos || 0); });
  var start = 0;
  for (i = 0; i < page.length; i++) {
    if (page[i]._pos === primary.chunk._pos) { start = i; break; }
  }
  var from = Math.max(0, start - 1);
  return page.slice(from, from + (maxSteps || 6));
}
function directAnswer(results, topCb, index) {
  var primary = results[0], i;
  var pageChunks;
  if (index) {
    // fuller, coherent answers: page-ordered steps from the primary's page
    pageChunks = pageSteps(index, primary, 6);
  } else {
    // legacy path: up to 3 top chunks from the primary's page, in page order
    pageChunks = [];
    for (i = 0; i < results.length && pageChunks.length < 3; i++) {
      if (results[i].chunk.url === primary.chunk.url) pageChunks.push(results[i].chunk);
    }
    pageChunks.sort(function (a, b) { return (a._pos || 0) - (b._pos || 0); });
  }
  return { type: "answer", primary: primary, context: pageChunks };
}
/* ---------- centralized combo resolution ----------
 * Single place that decides "which integration is the user asking about?"
 * All paths (direct question, chip pick, Others flow, memory) go through here.
 *
 * opts: { explicitKey } — user explicitly picked a combo (chip/Others), use it directly
 *       { activeCombo } — remembered combo from conversation context
 *
 * Returns:
 *   {type:"combo", key}         — search within this combo's docs
 *   {type:"disambiguate", pivot} — ask which integration (pivot=app or null for top 6)
 *   {type:"custom", apps}       — no such combo exists → custom.cloudify.biz
 *   {type:"clarify"}            — vague follow-up in memory context, ask for detail
 */
function resolveCombo(q, opts) {
  opts = opts || {};
  var qnorm = (q || "").toLowerCase().replace(/-/g, " ");
  var combos = (kbIndex && kbIndex.combos) || {};

  // 1. Explicit pick (chip or Others flow) — trust it, no re-deciding.
  if (opts.explicitKey) return { type: "combo", key: opts.explicitKey };

  var named = namedApps(qnorm);

  // 2. Two or more apps named — they must ALL be in one combo.
  if (named.length >= 2) {
    var bestKey = null, bestPop = -1, k, n, ok;
    var keys = Object.keys(combos);
    for (k = 0; k < keys.length; k++) {
      ok = true;
      for (n = 0; n < named.length; n++) {
        if (!comboHasApp(keys[k], named[n])) { ok = false; break; }
      }
      if (ok && combos[keys[k]] > bestPop) { bestPop = combos[keys[k]]; bestKey = keys[k]; }
    }
    if (bestKey) return { type: "combo", key: bestKey };
    return { type: "custom", apps: named }; // no such integration exists
  }

  // 3. One app named.
  if (named.length === 1) {
    var app = named[0];
    // In memory context, if the named app is part of the remembered combo,
    // stay in context (vague → clarify, specific → answer).
    if (opts.activeCombo && comboHasApp(opts.activeCombo, app)) {
      if (isVagueQuestion(q)) return { type: "clarify" };
      return { type: "combo", key: opts.activeCombo };
    }
    // Different app (or no memory) — show all combos for that app.
    return { type: "disambiguate", pivot: app };
  }

  // 4. No apps named.
  if (opts.activeCombo) {
    if (isVagueQuestion(q)) return { type: "clarify" };
    return { type: "combo", key: opts.activeCombo };
  }
  return { type: "disambiguate", pivot: null };
}

function decideAnswer(results, qnorm, combos, forceDirect, index) {
  if (!results.length) return { type: "fallback" };
  var topCb = comboOf(results[0].chunk.url);
  if (!forceDirect) {
    var named = namedApps(qnorm), i, a;
    if (named.length >= 2) {
      // visitor named 2+ apps — if no combo actually has ALL of them, this
      // integration doesn't exist. Don't guess with a partial match.
      var validCombo = false, allKeys = combos ? Object.keys(combos) : [], k, n;
      for (k = 0; k < allKeys.length && !validCombo; k++) {
        validCombo = true;
        for (n = 0; n < named.length; n++) {
          if (!comboHasApp(allKeys[k], named[n])) { validCombo = false; break; }
        }
      }
      if (!validCombo) return { type: "custom" };
    }
    if (named.length && topCb) {
      var order = comboOrder(results);
      var runner = order.length > 1 ? order[1] : null;
      // visitor distinctively named one combo -> answer it directly
      var distinctive = false;
      for (i = 0; i < named.length; i++) {
        if (comboHasApp(topCb, named[i]) && (!runner || !comboHasApp(runner, named[i]))) {
          distinctive = true; break;
        }
      }
      if (!distinctive && combos && order.length >= 2) {
        var best = {};
        order.forEach(function (k) { best[k] = 0; });
        results.forEach(function (r) {
          var cbx = comboOf(r.chunk.url);
          if (cbx && order.indexOf(cbx) !== -1 && !best[cbx]) best[cbx] = r.score;
        });
        if (best[order[1]] >= best[order[0]] * 0.7) {
          // ambiguous: pivot = the named app the candidate combos share
          var pivot = null, pivotCount = 0, c;
          for (i = 0; i < named.length; i++) {
            c = 0;
            for (a = 0; a < order.length; a++) {
              if (comboHasApp(order[a], named[i])) c++;
            }
            if (c > pivotCount) { pivotCount = c; pivot = named[i]; }
          }
          if (pivot && pivotCount >= 2) {
            // offer EVERY combo for that app - search hits first, then the rest
            var keys = [];
            order.forEach(function (key) { if (comboHasApp(key, pivot)) keys.push(key); });
            combosForApp(combos, pivot).forEach(function (key) {
              if (keys.indexOf(key) === -1) keys.push(key);
            });
            var chips = comboChips(keys);
            return { type: "disambiguate", labels: chips.labels, options: chips.options,
              html: "Good question - but the setup steps are different for each integration. 🙂<br><br><b>Which " +
                prettySeg(pivot) + " integration are you setting up?</b>" };
          }
        }
      }
      // distinctive, or named but not ambiguous -> answer the top combo directly
    } else if (combos) {
      // no app named: ask with the most popular integrations
      var chips2 = comboChips(topCombos(combos, 6));
      return { type: "disambiguate", labels: chips2.labels, options: chips2.options,
        html: "Sure - I\u2019ll point you to the right guide. 🙂<br><br><b>Which integration is this about?</b>" };
    }
  }
  return directAnswer(results, topCb, index);
}

function isGettingStarted(q) {
  var s = (q || "").toLowerCase();
  // "setup automation" is the invoice feature, not onboarding — never the card
  if (/\bsetup automation\b/.test(s)) return false;
  if (!/\b(set ?up|install|getting started|get started)\b/.test(s)) return false;
  // A general "setup <integration>" request (e.g. "Setup Hubspot xero" as a first
  // message) wants the full end-to-end setup card. But a specific config question
  // ("how do I setup invoice sync rules") wants the docs answer instead — so strip
  // setup-words, app names and filler; if almost nothing remains, it's general.
  var t = s.replace(/\b(set ?up|install|getting started|get started|guide|integration|app|hubspot|xero|shopify|woocommerce|pipedrive|fortnox|e-?conomic|pennylane|tripletex|exact|visma|dynamics|netsuite|sage|quickbooks|freshbooks|zoho|myob)\b/g, " ")
           .replace(/\b(how|to|do|does|can|could|i|we|you|the|a|an|my|our|me|please|need|want|with|for|is|are|it)\b/g, " ")
           .replace(/[^a-z0-9]+/g, " ").trim();
  var toks = t ? t.split(" ").filter(function (w) { return w.length > 1; }) : [];
  return toks.length < 2;
}
// Just app names with no real question ("Shopify fortnox") — the visitor wants
// the setup guide for that integration, not a docs search.
function isJustAppNames(q) {
  var s = (q || "").toLowerCase();
  var apps = namedApps(s.replace(/-/g, " "));
  if (!apps.length) return false;
  var t = s.replace(/\b(hubspot|xero|shopify|woocommerce|pipedrive|fortnox|e-?conomic|pennylane|tripletex|exact|visma|dynamics|netsuite|sage|quickbooks|freshbooks|zoho|myob|stripe|shopi|msbc|flowlink)\b/g, " ")
           .replace(/\b(how|to|do|does|can|could|i|we|you|the|a|an|my|our|me|please|need|want|with|for|is|are|it|hi|hello|hey)\b/g, " ")
           .replace(/[^a-z0-9]+/g, " ").trim();
  var toks = t ? t.split(" ").filter(function (w) { return w.length > 1; }) : [];
  return toks.length === 0;
}
var ChatEngine = { tokenize: tokenize, buildIndex: buildIndex, search: search, expandQuery: expandQuery, goodMatch: goodMatch,
  comboOf: comboOf, comboLabel: comboLabel, namedApps: namedApps, comboBoost: comboBoost, decideAnswer: decideAnswer,
  combosForApp: combosForApp, comboHasApp: comboHasApp, isGettingStarted: isGettingStarted, isJustAppNames: isJustAppNames,
  gettingStartedCard: gettingStartedCard, richAnswerHtml: richAnswerHtml, matchTypedCombo: matchTypedCombo, customComboMessage: customComboMessage,
  closingFor: closingFor, supportLine: supportLine, isTrouble: isTrouble,
  isLinkRequest: isLinkRequest, linkReply: linkReply, namedApps: namedApps,
  memoryFilter: memoryFilter, answerFromKB: answerFromKB, isVagueQuestion: isVagueQuestion,
  getActiveCombo: function () { return activeCombo; },
  setActiveCombo: function (c) { activeCombo = c; },
  setKbIndex: function (idx) { kbIndex = idx; },
  topCombos: topCombos, comboOrder: comboOrder, comboChips: comboChips,
  correctSpelling: correctSpelling, cleanText: cleanText, editDistance: editDistance };
if (typeof module !== "undefined" && module.exports) module.exports = ChatEngine;
var comboIndexCache = {}; // lazily built per-combo search indexes
var VAGUE_STOPWORDS = {a:1, an:1, the:1, and:1, or:1, can:1, could:1, you:1, your:1, me:1, my:1, i:1, we:1, please:1, show:1, tell:1, give:1, get:1, want:1, need:1, help:1, how:1, do:1, does:1, is:1, are:1, what:1, which:1, with:1, for:1, to:1, of:1, in:1, on:1, it:1, this:1, that:1, be:1, have:1, has:1, will:1, would:1, should:1, am:1, as:1, by:1, from:1, some:1, any:1, more:1, about:1};

var CONTACT_URL = "https://cloudify.biz/contact";
var BOOK_URL = "https://meetings.hubspot.com/cloudify/app-assistance";
var SUPPORT_EMAIL = "support@cloudify.biz";
/* ---------- per-integration "getting started" cards ----------
 * Curated links for the rich answers (marketplace listing, overview video,
 * trial). Setup Guide is derived from the docs at runtime; booking + support
 * email are global. Combos without curated links still get Setup Guide +
 * booking + support rows. */
var COMBO_CARDS = {
  "hubspot/xero": {
    app: "HubSpot Marketplace",
    appUrl: "https://ecosystem.hubspot.com/marketplace/apps/xero-sync-3387409",
    videoId: "JypOwjEhAp0",
    videoTitle: "HS Xero Onboarding",
    trialText: "Includes 30 invoice syncs over 30 days",
    trialUrl: "https://app.hubspot.com/marketplace/23395533/listing/xero-sync-3387409"
  },
  "pipedrive/xero": {
    app: "Pipedrive Marketplace",
    appUrl: "https://www.pipedrive.com/en/marketplace/app/xero/b217602d14d86f39",
    videoId: "3XKwrCnaEJE",
    videoTitle: "How to start using the Pipedrive-Xero integration from Cloudify",
    trialText: "Free trial with 15 syncs, no credit card required",
    trialUrl: ""
  },
  "shopify/xero": {
    app: "Shopify App Store",
    appUrl: "https://apps.shopify.com/xero-4",
    videoId: "",
    trialText: "",
    trialUrl: ""
  },
  "woocommerce/woocommerce-xero": {
    app: "",
    appUrl: "",
    videoId: "",
    trialText: "",
    trialUrl: "",
    setupGuide: "https://docs.cloudify.biz/woocommerce-xero/getting-started/overview"
  }
};

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
  rewriteUrl: userCfg.rewriteUrl || dataAttr("rewrite", ""), // e.g. https://xxx.workers.dev — when set, docs answers are rewritten by AI
  name:     userCfg.name     || dataAttr("name", "Cloudify"),
  color:    userCfg.color    || dataAttr("color", "#1d4ed8"),
  position: userCfg.position || dataAttr("position", "right"), // right | left
  welcome:  userCfg.welcome  || null,
  chips:    userCfg.chips    || []
};

// shortest installation/getting-started docs URL for a combo
function setupGuideUrl(combo, idx) {
  var curated = COMBO_CARDS[combo] && COMBO_CARDS[combo].setupGuide;
  if (curated) return curated;
  var kb = idx || ((typeof kbIndex !== "undefined") ? kbIndex : null);
  if (!kb) return null;
  var best = null;
  kb.chunks.forEach(function (c) {
    if (comboOf(c.url) !== combo) return;
    if (c.url.indexOf("/installation/") === -1 && c.url.indexOf("/getting-started/") === -1) return;
    if (!best || c.url.length < best.length) best = c.url;
  });
  return best;
}
function gettingStartedCard(combo, idx) {
  var info = COMBO_CARDS[combo] || {};
  var guide = setupGuideUrl(combo, idx);
  var label = comboLabel(combo).replace(/ \+ /g, "-");
  function extLink(url, text) { return '<a href="' + escapeHtml(url) + '" target="_blank" rel="noopener">' + escapeHtml(text) + "</a>"; }
  var rows = [];
  if (guide) {
    rows.push('📖 <b>Setup Guide:</b> Follow the step-by-step instructions here: ' + extLink(guide, "Setup Guide"));
  }
  if (info.appUrl) {
    rows.push('🛒 <b>Get the App:</b> Available on the ' + escapeHtml(info.app || "marketplace") + ": " + extLink(info.appUrl, "Get the app"));
  }
  if (info.videoId) {
    rows.push('🎥 <b>Video Guide:</b> Watch an overview: ' + extLink("https://www.youtube.com/watch?v=" + info.videoId, "YouTube Video"));
  }
  if (info.trialText) {
    var trial = '🆓 <b>Free Trial:</b> ' + escapeHtml(info.trialText);
    trial += info.trialUrl ? ": " + extLink(info.trialUrl, "Start free trial") : ".";
    rows.push(trial);
  }
  rows.push('📅 <b>Onboarding Support:</b> Book a complimentary 30-minute onboarding call: ' + extLink(BOOK_URL, "Book a call"));
  var html = "Here's how you can get started with the " + escapeHtml(label) + " integration:<br><br>" +
    "• " + rows.join("<br>• ") +
    "<br><br>Is there anything specific about the setup you need help with? 😊";
  return { html: html, chips: (typeof CFG !== "undefined" && CFG.chips) || [],
           linkUrl: guide || null, linkTitle: guide ? "Setup Guide" : null };
}

/* ---------- tiny intent layer (runs before KB search) ---------- */
function intentReply(q) {
  var s = q.toLowerCase().trim();
  if (/^(hi|hii+|hello|hey|yo|namaste|good (morning|afternoon|evening))\b/.test(s) || s.length < 3 && /^(hi|hey)$/.test(s))
    return { text: "Hello! 👋 What would you like to know about our integrations?", chips: [] };
  // one-word acknowledgments / replies — never search the KB for these, just respond naturally
  if (/^(ok|okay|k|got it|understood|noted|alright|fine|cool|great|sure)[!. ]*$/.test(s))
    return { text: "👍 Got it! I'm here if you need anything else.", chips: [] };
  if (/^(yes|yeah|yep|yup)[!. ]*$/.test(s))
    return { text: "Sure — what would you like to know? 🙂", chips: [] };
  if (/^(no|nope|nah)[!. ]*$/.test(s))
    return { text: "No problem at all! Feel free to come back anytime. 👋", chips: [] };
  if (/\b(thank|thanks|thx|dhanyavad)\b/.test(s))
    return { text: "You're very welcome! 😊 Anything else I can help with?", chips: CFG.chips };
  if (/\b(bye|goodbye|see you|good night)\b/.test(s))
    return { text: "Goodbye for now! 👋 If you need anything later, I'll be right here.", chips: [] };
  if (/\b(book|demo|consultation|consult|call|talk to (a |someone|human)|human|agent|support|contact|email|phone|connect (me |us )?(with|to) (your |our |the )?team|talk to (your |our |the )?team|connect me with (someone|a human))\b/.test(s))
    return { html: "To talk to our marketplace team at Cloudify, you can <a href=\"" + BOOK_URL + "\" target=\"_blank\" rel=\"noopener\">schedule a meeting with us</a>. A calendar invitation will be shared with you.<br><br>Alternatively, feel free to reach out to us at <a href=\"mailto:" + SUPPORT_EMAIL + "\">" + SUPPORT_EMAIL + "</a> for any questions or assistance. 😀",
             text: "To talk to our marketplace team at Cloudify, you can schedule a meeting with us.", chips: [] };
  if (/\b(who are you|your name|what are you)\b/.test(s))
    return { text: "I'm " + CFG.name + ", the Cloudify docs assistant. I answer from our documentation — ask me about installing, configuring, or troubleshooting an integration!", chips: CFG.chips };
  return null;
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
".cfb-yt{display:block;margin-top:10px;border:1px solid #eef0f3;border-radius:12px;overflow:hidden;text-decoration:none}",
".cfb-yt img{display:block;width:100%;height:auto}",
".cfb-yt span{display:block;padding:8px 12px;font-size:13px;font-weight:600}",
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
".cfb-foot .cfb-attach{background:none;font-size:20px;width:36px;height:42px;filter:grayscale(1);opacity:.55;padding:0}",
".cfb-foot .cfb-attach:hover{opacity:1;filter:none}",
".cfb-attachment img{max-width:200px;max-height:140px;border-radius:8px;display:block}",
".cfb-attachchip{background:rgba(255,255,255,.22);border-radius:8px;padding:6px 10px;font-size:13px;display:inline-block}",
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
    '<div class="cfb-foot"><button class="cfb-attach" aria-label="Attach a file">📎</button><input type="text" placeholder="Ask a question…" aria-label="Ask a question"><button class="cfb-send" aria-label="Send">➤</button></div>' +
    '<input type="file" class="cfb-fileinput" accept="image/*,.pdf,.doc,.docx,.txt,.csv,.xls,.xlsx" style="display:none" aria-hidden="true">' +
  '</div>');

document.body.appendChild(launcher);
document.body.appendChild(panel);

var body = panel.querySelector(".cfb-body");
var input = panel.querySelector(".cfb-foot input");
var sendBtn = panel.querySelector(".cfb-send");
var attachBtn = panel.querySelector(".cfb-attach");
var fileInput = panel.querySelector(".cfb-fileinput");
var closeBtn = panel.querySelector(".cfb-head button");

function escapeHtml(s) {
  return (s || "").replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}

/* ---------- chat behavior ---------- */
var opened = false, kbIndex = null, kbMeta = null, kbFailed = false, pendingCombo = null, activeCombo = null;
var awaitingCustomCombo = null; // original query saved when visitor clicks "Others" — waiting for them to type the app names
var lastAnswer = null; // {title, url} of the most recent answer's primary source — for "do you have a link?" follow-ups
// lazily built search index over a single combo's chunks (for picked integrations)
function indexForCombo(combo) {
  if (!comboIndexCache[combo]) {
    var sub = kbIndex.chunks.filter(function (c) { return comboOf(c.url) === combo; });
    if (!sub.length) return null;
    comboIndexCache[combo] = buildIndex(sub);
  }
  return comboIndexCache[combo];
}

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
// strip markdown debris the KB build may have left behind (***, ___, \', ...)
function cleanText(t) {
  return (t || "")
    .replace(/\*{3,}/g, " ")
    .replace(/_{3,}/g, " ")
    .replace(/(^|\s)-{3,}(\s|$)/g, " ")
    .replace(/\\'/g, "'")
    .replace(/\s+/g, " ")
    .trim();
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

/* ---------- "do you have a link?" follow-ups ----------
 * A visitor asking for a link usually means the source link of the previous
 * answer ("Ok did you have link?") — NOT a docs search for the word "link"
 * (which would match product "Direct Link" matching and invent a problem).
 * We answer from the remembered last answer instead of searching. */
function isLinkRequest(q) {
  var s = (q || "").toLowerCase().trim();
  if (!/\blink\b/.test(s)) return false;
  // docs topic, not a URL request: "link products", "how to link", "linking X"
  if (/\blink(ing)?\s+(products?|invoices?|quotes?|accounts?|contacts?|orders?|items?)\b/.test(s)) return false;
  if (/\bhow\s+(do|to|can)\b[^?.]{0,25}\blink\b/.test(s)) return false;
  // URL request: "do you have a link", "did you have link", "share the link",
  // "give me the link", "link me to the setup guide", "link please"
  return /\b(have|has|got|give|send|share|provide|post|drop)\b.{0,30}\blink\b/.test(s) ||
         /\blink\s+me\b/.test(s) ||
         /\blink\b.{0,20}\b(please|pls)\b/.test(s);
}
function linkReply(q) {
  if (!isLinkRequest(q)) return null;
  if (lastAnswer && lastAnswer.url) {
    return 'Yes! Here\u2019s the link: 📄 <a href="' + escapeHtml(lastAnswer.url) +
      '" target="_blank" rel="noopener">' + escapeHtml(lastAnswer.title || lastAnswer.url) + "</a> 🙂";
  }
  return "Which link are you looking for? Tell me the topic \u2014 for example the setup guide \u2014 and I\u2019ll share the right one. 🙂";
}

/* ---------- Lyro-style closings & support escalation ---------- */
function isTrouble(q) {
  return /\b(issue|issues|error|errors|problem|problems|facing|not working|isn'?t working|failed|fails|failure|trouble|stuck|broken)\b/i.test(q || "");
}
function supportLine(q) {
  var mail = '<a href="mailto:' + SUPPORT_EMAIL + '">' + SUPPORT_EMAIL + "</a>";
  if (isTrouble(q)) {
    return 'Need more help? <a href="' + BOOK_URL + '" target="_blank" rel="noopener">Book a support call</a> or reach us at ' + mail + ".";
  }
  return "Need more help? Reach us at " + mail + ".";
}
function closingFor(q) {
  if (isTrouble(q)) {
    return "Could you share more details about the specific error or issue you're encountering? I can try to help further, or connect you with our team. 🙂";
  }
  return "Is there anything else I can help you with? 🙂";
}
// bold the lead phrase of a step when it has a natural "Lead: rest" shape
function stepLead(s) {
  var m = /^(.{4,60}?)(:\s+| – | - )(.{10,})$/.exec(s);
  if (m) return "<b>" + escapeHtml(m[1]) + "</b> – " + escapeHtml(m[3]);
  return escapeHtml(s);
}
/* ---------- Lyro-style rich answer (deterministic) ----------
 * Builds a structured answer from the page-ordered steps: opening line,
 * numbered steps, guide sentence, source link, support email, follow-up.
 * Used as the extractive fallback AND as the base the AI rewrite improves
 * on — so answers stay rich even when the AI proxy is unreachable. */
function richAnswerHtml(d, q) {
  var primary = d.primary.chunk;
  var title = primary.title || primary.url;
  var steps = [], seen = {};
  d.context.forEach(function (c) {
    var t = cleanText(c.text);
    if (!t || t.length < 10 || seen[t]) return;
    seen[t] = 1;
    if (t.length > 260) t = t.slice(0, 260).replace(/\s+\S*$/, "") + "…";
    steps.push(t);
  });
  var html = "";
  var trouble = isTrouble(q);
  if (steps.length >= 2) {
    html = (trouble ? "Sorry to hear you're facing issues! Here are the steps for " : "Here are the steps for ") +
      "<b>" + escapeHtml(title) + "</b>:<br><br><ol>" +
      steps.map(function (s) { return "<li>" + stepLead(s) + "</li>"; }).join("") +
      "</ol><br>";
  } else if (steps.length === 1) {
    html = (trouble ? "Sorry to hear you're facing issues! " : "") + escapeHtml(steps[0]) + "<br><br>";
  }
  html += srcLink(primary) +
    "<br><br>" + supportLine(q) +
    "<br><br>" + closingFor(q);
  return html;
}

/* Out-of-scope detection: the question names no app and contains none of the docs
 * domain vocabulary ("capital of France") — it's not a Cloudify question at all,
 * so we decline politely instead of issuing a support ticket for it. */
function isOutOfScope(q) {
  var qnorm = (q || "").toLowerCase();
  if (namedApps(qnorm).length > 0) return false;
  var toks = tokenize(qnorm), i;
  for (i = 0; i < toks.length; i++) {
    if (DOMAIN_WORDS[toks[i]]) return false;
  }
  return true;
};

/* Vague-question detection: after stopwords and app names are removed, fewer than
 * two meaningful tokens remain (e.g. "Can you show me steps" -> just "steps").
 * Used so a vague follow-up in an established combo context gets a clarifying
 * question instead of a ticket message or another "which integration?" ask. */
function isVagueQuestion(q) {
  var qnorm = q.toLowerCase().replace(/-/g, " ");
  var apps = namedApps(qnorm), toks = tokenize(q.toLowerCase()), i, t, meaningful = 0;
  for (i = 0; i < toks.length; i++) {
    t = toks[i];
    if (VAGUE_STOPWORDS[t]) continue;
    if (apps.indexOf(t) !== -1) continue;
    meaningful++;
  }
  return meaningful < 2;
}

/* Once the visitor has settled on an integration (named it distinctively or picked
 * a chip), remember it for the rest of the conversation so follow-up questions
 * don't get asked "which app?" again. A question naming an app outside the
 * remembered combo starts fresh. */
function memoryFilter(qnorm) {
  if (!activeCombo) return null;
  var named = namedApps(qnorm), i;
  for (i = 0; i < named.length; i++) {
    if (!comboHasApp(activeCombo, named[i])) return null; // different app -> fresh
  }
  return activeCombo;
}

function answerFromKB(q, comboFilter, isMemory) {
  // Centralized combo resolution — one place decides which integration.
  var res;
  if (comboFilter && !isMemory) {
    res = { type: "combo", key: comboFilter }; // explicit pick, trust it
  } else if (comboFilter && isMemory) {
    res = resolveCombo(q, { activeCombo: comboFilter });
  } else {
    res = resolveCombo(q, { activeCombo: activeCombo });
  }

  // --- non-search resolutions ---
  if (res.type === "custom") {
    pendingCombo = null;
    return { html: customComboMessage(q), chips: [] };
  }
  if (res.type === "clarify") {
    pendingCombo = null;
    return {
      html: "I want to point you to the right place — could you share a bit more detail about what you're trying to do? 🙂",
      chips: []
    };
  }
  if (res.type === "disambiguate") {
    pendingCombo = null;
    var dchips, dhtml;
    if (res.pivot) {
      var pkeys = combosForApp(kbIndex.combos, res.pivot);
      dchips = comboChips(pkeys);
      dhtml = "Good question - but the setup steps are different for each integration. 🙂<br><br><b>Which " +
        prettySeg(res.pivot) + " integration are you setting up?</b>";
    } else {
      dchips = comboChips(topCombos(kbIndex.combos, 6));
      dhtml = "Sure - I\u2019ll point you to the right guide. 🙂<br><br><b>Which integration is this about?</b>";
    }
    pendingCombo = { query: q, options: dchips.options };
    return { html: dhtml, chips: dchips.labels };
  }

  // --- res.type === "combo": search within the combo's docs ---
  var key = res.key;
  var index = indexForCombo(key);
  if (!index) {
    pendingCombo = null;
    return {
      html: "Please <b>submit a support ticket</b> by emailing <a href=\"mailto:" + SUPPORT_EMAIL + "\">" + SUPPORT_EMAIL + "</a> — include the exact error message, screenshots, and any order or transaction references, and our team will take it from there. 🤝",
      chips: (typeof CFG !== "undefined" && CFG.chips) || []
    };
  }
  var results = search(index, expandQuery(q), 15).filter(goodMatch);
  var memoryBypassed = false;
  var isMemCtx = !!(comboFilter && isMemory);
  if (isMemCtx && !results.length) {
    var weak = search(index, expandQuery(q), 5);
    if (weak.length > 0 && weak[0].score >= 0.25) results = weak.slice(0, 3);
  }
  if (isMemCtx && !results.length) {
    var full = search(kbIndex, expandQuery(q), 15).filter(goodMatch);
    if (full.length > 0) { results = full; index = kbIndex; memoryBypassed = true; }
  }
  if (!results.length) {
    // No docs found in this combo.
    pendingCombo = null;
    if (isOutOfScope(q)) {
      return {
        html: "I'm the Cloudify docs assistant, so I can only help with our accounting integrations (setup, invoicing, syncing, troubleshooting). 🙂 What would you like to know about them?",
        chips: []
      };
    }
    // Vague in-scope question with no search hits — ask which integration
    // (unless one was already picked).
    if (!comboFilter) {
      var fchips = comboChips(topCombos(kbIndex.combos, 6));
      pendingCombo = { query: q, options: fchips.options };
      return {
        html: "Sure - I\u2019ll point you to the right guide. 🙂<br><br><b>Which integration is this about?</b>",
        chips: fchips.labels
      };
    }
    return {
      html: "Please <b>submit a support ticket</b> by emailing <a href=\"mailto:" + SUPPORT_EMAIL + "\">" + SUPPORT_EMAIL + "</a> — include the exact error message, screenshots, and any order or transaction references, and our team will take it from there. 🤝",
      chips: (typeof CFG !== "undefined" && CFG.chips) || []
    };
  }

  // We have results — build the answer.
  pendingCombo = null;
  var answeredCombo = memoryBypassed ? comboOf(results[0].chunk.url) : key;
  if (answeredCombo) activeCombo = answeredCombo;
  if (isGettingStarted(q) || isJustAppNames(q)) {
    var card = gettingStartedCard(key);
    if (card.linkUrl) lastAnswer = { title: card.linkTitle, url: card.linkUrl };
    return card;
  }
  var d = directAnswer(results, key, index);
  var htmlOut = richAnswerHtml(d, q);
  lastAnswer = { title: d.primary.chunk.title || d.primary.chunk.url, url: d.primary.chunk.url };
  return {
    html: htmlOut, chips: [],
    rewrite: {
      question: q,
      combo: key,
      excerpts: d.context.map(function (c) { return cleanText(c.text); }),
      primaryUrl: d.primary.chunk.url,
      primaryTitle: d.primary.chunk.title || d.primary.chunk.url
    }
  };
}

// formatting; this is defense in depth)
function sanitizeHtml(h) {
  return (h || "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/href=(["'])(?!https?:\/\/|mailto:)[\s\S]*?\1/gi, 'href="#"');
}
// ask the rewrite proxy to turn docs excerpts into a polished answer
function rewriteAnswer(a) {
  typing(true);
  var ctrl = null, timer = null;
  try { ctrl = new AbortController(); } catch (e) { ctrl = null; }
  var done = false;
  function finish(html) {
    if (done) return; done = true;
    if (timer) clearTimeout(timer);
    typing(false);
    addMsg("cfb-bot", html);
    addChips(a.chips);
  }
  function fallback() { finish(a.html); }
  if (ctrl) { timer = setTimeout(function () { try { ctrl.abort(); } catch (e) {} fallback(); }, 45000); }
  var payload = {
    question: a.rewrite.question,
    combo: a.rewrite.combo,
    excerpts: a.rewrite.excerpts
  };
  var opts = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) };
  if (ctrl) opts.signal = ctrl.signal;
  fetch(CFG.rewriteUrl, opts).then(function (res) {
    if (!res.ok) throw new Error("bad status");
    return res.json();
  }).then(function (data) {
    if (!data || !data.html) throw new Error("empty");
    // ticket-only replies stay bare, exactly as the visitor should see them
    if (/support ticket/i.test(data.html)) { finish(sanitizeHtml(data.html)); return; }
    var src = { url: a.rewrite.primaryUrl, title: a.rewrite.primaryTitle };
    var htmlOut = sanitizeHtml(data.html) + "<br>" + srcLink(src) +
      "<br><br>" + supportLine(a.rewrite.question) +
      "<br><br>" + closingFor(a.rewrite.question);
    finish(htmlOut);
  }).catch(function () { fallback(); });
  if (!ctrl) { /* no AbortController: rely on fetch rejection */ }
}
// display an answer, using the AI rewrite when configured and applicable
function sayAnswer(a) {
  if (a.rewrite && CFG.rewriteUrl) { rewriteAnswer(a); return; }
  botSay(a.html, a.chips);
}

/* ---------- file attachments ----------
 * Visitors can attach screenshots via the paperclip button. Images are read
 * with Tesseract.js OCR entirely in the browser (nothing uploaded); the
 * extracted text is then answered through the normal KB + AI pipeline.
 * Non-image files can't be processed — the bot says so honestly. */
var pendingImageText = null; // OCR text from the last screenshot — attached to the next question
// Lazy-load Tesseract.js from CDN (only when a screenshot is uploaded)
function loadTesseract(cb) {
  if (window.Tesseract && window.Tesseract.createWorker) { cb(null); return; }
  var s = document.createElement("script");
  s.src = "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js";
  s.onload = function () { cb(null); };
  s.onerror = function () { cb(new Error("load failed")); };
  document.head.appendChild(s);
}
// Run OCR on an image element, return extracted text via callback.
// Small screenshots are upscaled 2x first — Tesseract reads tiny text poorly.
function ocrImage(imgEl, cb) {
  loadTesseract(function (err) {
    if (err) { cb(null); return; }
    (async function () {
      try {
        var src = imgEl;
        if (imgEl.naturalWidth && imgEl.naturalWidth < 1000) {
          var c = document.createElement("canvas");
          c.width = imgEl.naturalWidth * 2; c.height = imgEl.naturalHeight * 2;
          c.getContext("2d").drawImage(imgEl, 0, 0, c.width, c.height);
          src = c;
        }
        var worker = await window.Tesseract.createWorker("eng");
        var res = await worker.recognize(src);
        await worker.terminate();
        var t = (res && res.data && res.data.text ? res.data.text : "").replace(/\s+/g, " ").trim();
        cb(t.length > 10 ? t : null);
      } catch (e) { cb(null); }
    })();
  });
}
// Answer a screenshot: analyze OCR text, identify the app, then answer.
// - No supported apps in the screenshot → ask for a relevant screenshot.
// - Apps resolve to one combo → answer directly for that integration.
// - One app, several integrations → show what was found, then ask which one.
// - Never asks "which integration?" without first showing the analysis.
function answerScreenshot(ocrText, question) {
  var apps = namedApps(ocrText.toLowerCase());
  apps = apps.filter(function (a, i) { return apps.indexOf(a) === i; });

  if (!apps.length) {
    // No app names recognized — the screenshot may still show a Cloudify error
    // or settings page. Try the docs search on the extracted text before giving up.
    pendingImageText = null;
    pendingCombo = null;
    var qf = "The visitor uploaded a screenshot. Visible text: \"" + ocrText.slice(0, 1500) + "\". " +
      (question ? "They ask: " + question : "This looks like a Cloudify error or settings page — give the most relevant help from the docs.");
    var af = answerFromKB(qf, null, false);
    if (af && af.html.indexOf("point you to the right place") !== -1) {
      // Pipeline couldn't help either — screenshot truly not relevant
      pendingCombo = null;
      botSay("I looked at your screenshot, but I couldn't spot any of our supported apps in it. Please upload a screenshot related to one of our supported apps (HubSpot, Xero, Pipedrive, Shopify, Fortnox, e-conomic, and more). 🙂", []);
    } else {
      sayAnswer(af); // docs had an answer, or disambiguation chips to pick from
    }
    return;
  }

  var res = resolveCombo(apps.join(" "), {});
  var seen = "The visitor uploaded a screenshot. Visible text: \"" + ocrText.slice(0, 1500) + "\".";

  if (res.type === "combo") {
    // Screenshot identifies one integration — answer directly, no manual pick needed
    var q = "Screenshot analysis: this is about the " + comboLabel(res.key) + " integration. " +
      seen + (question ? " They ask: " + question : " Describe what the screenshot shows and give the most relevant help.");
    var a = answerFromKB(q, res.key, false);
    sayAnswer(a);
    return;
  }
  if (res.type === "disambiguate" && res.pivot) {
    // Screenshot shows one app with several integrations — show the finding, then ask
    var pkeys = combosForApp(kbIndex.combos, res.pivot);
    var dchips = comboChips(pkeys);
    var pq = "Screenshot analysis: this is about " + prettySeg(res.pivot) + ". " +
      seen + (question ? " They ask: " + question : " Describe what the screenshot shows and give the most relevant help.");
    pendingCombo = { query: pq, options: dchips.options };
    pendingImageText = null;
    botSay("📸 I can see this screenshot is about <b>" + prettySeg(res.pivot) + "</b>. 🙂<br><br>Which " +
      prettySeg(res.pivot) + " integration is this about?", dchips.labels);
    return;
  }
  // Fallback: run the normal pipeline on the screenshot text
  var qf = seen + (question ? " They ask: " + question : " Describe what the screenshot shows and give the most relevant help.");
  var af = answerFromKB(qf, null, false);
  sayAnswer(af);
}
attachBtn.onclick = function () { fileInput.click(); };
fileInput.onchange = function () {
  var f = fileInput.files && fileInput.files[0];
  fileInput.value = "";
  if (!f) return;
  if (f.size > 10 * 1024 * 1024) {
    botSay("That file is over 10MB — please try a smaller one. 📎", []);
    return;
  }
  var isImg = (f.type || "").indexOf("image/") === 0;
  var url = URL.createObjectURL(f);
  var inner = isImg
    ? '<div class="cfb-attachment"><img src="' + url + '" alt="Attached screenshot"></div><div style="font-size:12px;opacity:.75;margin-top:4px">' + escapeHtml(f.name) + "</div>"
    : '<span class="cfb-attachchip">📄 ' + escapeHtml(f.name) + "</span>";
  addMsg("cfb-user", inner);
  if (!isImg) {
    botSay("Thanks for sharing <b>" + escapeHtml(f.name) + "</b>! I can only read images (screenshots/photos) — I can't open this file type. Could you describe what you need in words, or email it to <a href=\"mailto:" + SUPPORT_EMAIL + "\">" + SUPPORT_EMAIL + "</a>.", []);
    return;
  }
  if (!CFG.rewriteUrl) {
    botSay("Thanks for sharing <b>" + escapeHtml(f.name) + "</b>! I can't view images right now. Could you describe what you're seeing in words? I'll do my best to help.", []);
    return;
  }
  botSay("Let me read your screenshot… ⏳", []);
  var imgEl = new Image();
  imgEl.onload = function () {
    ocrImage(imgEl, function (ocrText) {
      URL.revokeObjectURL(url);
      if (!ocrText) {
        botSay("I couldn't quite make out the text in that screenshot. Could you describe what you're seeing in words? 🙂", []);
        return;
      }
      pendingImageText = ocrText; // next question gets screenshot context
      answerScreenshot(ocrText, "");
    });
  };
  imgEl.onerror = function () {
    URL.revokeObjectURL(url);
    botSay("I couldn't read that image file. Could you describe what you're seeing in words? 🙂", []);
  };
  imgEl.src = url;
};

function handleUser(text) {
  text = (text || "").trim();
  if (!text) return;
  addMsg("cfb-user", escapeHtml(text));
  input.value = "";
  // "Hi, I need to setup pipedrive xero" — a leading greeting must not swallow the
  // real question. Strip it and answer what they actually asked.
  var stripped = text.replace(/^(hi+|hello|hey|yo|namaste|good\s+(morning|afternoon|evening))[,!. ]+/i, "").trim();
  if (stripped) text = stripped;
  if (awaitingCustomCombo) {
    // visitor clicked "Others" and has now typed the app combo they need
    var customQ = awaitingCustomCombo;
    awaitingCustomCombo = null;
    var customCombo = matchTypedCombo(text);
    if (customCombo) {
      activeCombo = customCombo; // remember the explicit choice even if this answer fails
      // If the original question was a getting-started question, show the
      // setup card directly — don't rely on search finding it.
      if (isGettingStarted(customQ)) {
        var card = gettingStartedCard(customCombo);
        if (card.linkUrl) lastAnswer = { title: card.linkTitle, url: card.linkUrl };
        sayAnswer(card);
      } else {
        var ca = answerFromKB(customQ, customCombo);
        sayAnswer(ca);
      }
    } else {
      botSay(customComboMessage(text), []);
    }
    return;
  }
  if (pendingCombo && pendingCombo.options[text]) {
    // visitor picked an integration from the disambiguation chips
    var key = pendingCombo.options[text], pq = pendingCombo.query;
    if (key === "__others__") {
      // "Others" — ask them to type the app combo they need
      awaitingCustomCombo = pq;
      pendingCombo = null;
      botSay("Sure! Please type the names of the apps you'd like to connect — for example, <b>HubSpot + QuickBooks</b>. 🙂", []);
      return;
    }
    pendingCombo = null;
    activeCombo = key; // remember the explicit choice even if this answer fails
    var a = answerFromKB(pq, key);
    sayAnswer(a);
    return;
  }
  pendingCombo = null;
  var ir = intentReply(text);
  if (ir) { botSay(ir.html || escapeHtml(ir.text), ir.chips); return; }
  var lr = linkReply(text);
  if (lr) { botSay(lr, []); return; }
  if (pendingImageText) {
    // visitor uploaded a screenshot and then asked about it — answer with OCR context
    var ocrT = pendingImageText;
    pendingImageText = null;
    answerScreenshot(ocrT, text);
    return;
  }
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
  // continue the conversation in the remembered integration's context instead of
  // asking "which app?" again — unless the question names a different app
  var memFilter = memoryFilter(text.toLowerCase().replace(/-/g, " "));
  var a = answerFromKB(text, memFilter, !!memFilter);
  sayAnswer(a);
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
      sayAnswer(a);
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
      sayAnswer(a);
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
