(function () {
"use strict";
const HOUR = 3600e3;
const INTERVAL_H = { 1: 4, 2: 8, 3: 23, 4: 47, 5: 167, 6: 335, 7: 719, 8: 2879 };
const STAGE_NAMES = ["Lesson", "Apprentice I", "Apprentice II", "Apprentice III", "Apprentice IV", "Guru I", "Guru II", "Master", "Enlightened", "Burned"];
const GROUPS = [
  { key: "app", name: "Apprentice", min: 1, max: 4, c: "var(--st-app)" },
  { key: "guru", name: "Guru", min: 5, max: 6, c: "var(--st-guru)" },
  { key: "master", name: "Master", min: 7, max: 7, c: "var(--st-master)" },
  { key: "enl", name: "Enlightened", min: 8, max: 8, c: "var(--st-enl)" },
  { key: "burn", name: "Burned", min: 9, max: 9, c: "var(--st-burn)" },
];
const LESSON_BATCH = 5;
const REVIEW_WINDOW = 10;
const MISS_GAP = 6; // questions to wait before a missed item is asked again

const app = document.getElementById("app");
const dlg = document.getElementById("dlg");
const navHome = document.getElementById("nav-home");
const navLevels = document.getElementById("nav-levels");
const navReading = document.getElementById("nav-reading");

let DATA = null;        // {levels, kanji, vocab}
let vocabByWord = {};
let vocabByKanji = {};
let state = { level: 1, kanji: {}, vocab: {}, started: Date.now() };
let screen = "home";
let session = null;
let refs = null;        // db refs
let db = null, sample = null, sampleOff = false;
const dirty = new Set();
let saving = false;
let hookCache = {};

// ---------- helpers ----------
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) for (const k in attrs) {
    const v = attrs[k];
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else if (k === "style") el.setAttribute("style", v);
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
}
function rich(text) {
  const frag = document.createDocumentFragment();
  String(text || "").split(/(\*\*[^*]+\*\*)/).forEach(p => {
    if (/^\*\*[^*]+\*\*$/.test(p)) frag.append(h("b", { text: p.slice(2, -2) }));
    else if (p) frag.append(document.createTextNode(p));
  });
  return frag;
}
function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function nowH() { return Date.now() / HOUR; }
function toast(msg) {
  const t = h("div", { class: "toast", role: "status", text: msg });
  document.body.append(t); setTimeout(() => t.remove(), 3200);
}
function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
function hira(s) { return window.wanakana ? window.wanakana.toHiragana(s) : s; }
function kunDisplay(r) { const s = r.replace(/-/g, ""); const i = s.indexOf("."); return i < 0 ? s : s.slice(0, i) + "(" + s.slice(i + 1) + ")"; }
// The dictionary lists prefix/suffix forms separately (て, て-, -て); show each reading once
function kunList(k) { return [...new Set((k.kun || []).map(kunDisplay))]; }
function onList(k) { return [...new Set((k.on || []).map(r => hira(r.replace(/-/g, ""))))]; }

// ---------- audio: recorded clips (VOICEVOX:No.7), with the device voice as a fallback ----------
// Clips live in audio/on.json (every on'yomi) and audio/L01..L60.json (that level's kun'yomi and words).
const tts = { ok: "speechSynthesis" in window && "SpeechSynthesisUtterance" in window, voice: null };
const AUDIO_OK = !!(window.AudioContext || window.webkitAudioContext);
function pickVoice() {
  try {
    const vs = speechSynthesis.getVoices();
    tts.voice = vs.find(v => /^ja/i.test(v.lang) && /google|kyoko|otoya|nanami|haruka|ayumi|keita/i.test(v.name)) || vs.find(v => /^ja/i.test(v.lang)) || null;
  } catch (e) {}
}
if (tts.ok) { pickVoice(); try { speechSynthesis.addEventListener("voiceschanged", pickVoice); } catch (e) {} }
function deviceSpeak(text) {
  return new Promise(res => {
    if (!tts.ok || !text) return res();
    try {
      const u = new SpeechSynthesisUtterance(String(text).replace(/[()]/g, ""));
      u.lang = "ja-JP"; if (tts.voice) u.voice = tts.voice; u.rate = 0.9;
      u.onend = res; u.onerror = res; speechSynthesis.speak(u);
      setTimeout(res, 4000);
    } catch (e) { res(); }
  });
}
let actx = null;
function audioCtx() {
  if (!AUDIO_OK) return null;
  if (!actx) {
    try { if (navigator.audioSession) navigator.audioSession.type = "playback"; } catch (e) {} // play even with the iPhone silent switch on
    actx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (actx.state === "suspended") actx.resume().catch(() => {});
  return actx;
}
const clipBundles = {}, decoded = new Map();
let kunBundle = null;
function pad2(n) { return (n < 10 ? "L0" : "L") + n; }
function bundleOf(key) {
  if (key.startsWith("o:")) return "on";
  if (key.startsWith("w:")) { const v = vocabByWord[key.slice(2)]; return v ? pad2(v.L) : null; }
  if (key.startsWith("k:")) {
    if (!kunBundle) {
      kunBundle = {};
      DATA.levels.forEach((ks, i) => ks.forEach(ch => (DATA.kanji[ch].kun || []).forEach(r => {
        const s = r.replace(/-/g, "").replace(".", ""); if (s && !(s in kunBundle)) kunBundle[s] = pad2(i + 1);
      })));
    }
    return kunBundle[key.slice(2)] || null;
  }
  return null;
}
function loadBundle(name) {
  if (!name) return Promise.resolve(null);
  if (!(name in clipBundles)) clipBundles[name] = fetch("audio/" + name + ".json").then(r => r.ok ? r.json() : null).catch(() => null);
  return clipBundles[name];
}
function preloadAudio(items) {
  const names = new Set(["on"]);
  items.forEach(it => names.add(pad2(it.L)));
  names.forEach(loadBundle);
}
async function clipBuffer(key) {
  if (decoded.has(key)) return decoded.get(key);
  const b = await loadBundle(bundleOf(key));
  if (!b || !b[key]) return null;
  const c = audioCtx(); if (!c) return null;
  const bin = Uint8Array.from(atob(b[key]), ch => ch.charCodeAt(0));
  const buf = await new Promise((res, rej) => { const p = c.decodeAudioData(bin.buffer, res, rej); if (p && p.then) p.then(res, rej); });
  decoded.set(key, buf);
  return buf;
}
let playToken = 0, playing = null;
async function speak(items) {
  items = [].concat(items).filter(Boolean);
  const c = audioCtx(); // created inside the tap so iOS allows sound
  const token = ++playToken;
  try { if (playing) playing.stop(); } catch (e) {}
  try { if (tts.ok) speechSynthesis.cancel(); } catch (e) {}
  for (const it of items) {
    if (token !== playToken) return;
    let buf = null;
    try { buf = it.key && c ? await clipBuffer(it.key) : null; } catch (e) { buf = null; }
    if (token !== playToken) return;
    if (buf) {
      await new Promise(res => { const s = c.createBufferSource(); s.buffer = buf; s.connect(c.destination); s.onended = res; playing = s; s.start(); });
    } else await deviceSpeak(it.text);
  }
}
const SPEAKER_SVG = '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor"/><path d="M16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
function speakerIcon() { const s = document.createElement("span"); s.style.display = "inline-flex"; s.innerHTML = SPEAKER_SVG; return s; }
const CAN_PLAY = AUDIO_OK || tts.ok;
function sayBtn(items, label, cls) {
  if (!CAN_PLAY) return null;
  const b = h("button", { class: "say " + (cls || ""), type: "button", "aria-label": label, title: label, onclick: e => { e.stopPropagation(); speak(items); } });
  b.append(speakerIcon()); return b;
}
// list: [{text, key}] — text is what's shown, key finds the recorded clip
function readingChips(list) {
  return h("span", { class: "rchips" }, list.map(r => CAN_PLAY
    ? h("button", { class: "rchip", type: "button", lang: "ja", "aria-label": "Play " + r.text, onclick: () => speak(r) }, h("span", { text: r.text }), speakerIcon())
    : h("span", { class: "rchip static", lang: "ja", text: r.text })));
}
function onItems(k) { return onList(k).map(r => ({ text: r, key: "o:" + r })); }
function kunItems(k) { return kunList(k).map(r => ({ text: r, key: "k:" + r.replace(/[()]/g, "") })); }
function vocabReadingItems(v) { return v.r.map((r, i) => ({ text: r, key: i === 0 ? "w:" + v.w : null })); }
function mainSpeech(it) {
  if (it.type === "vocab") return vocabReadingItems(it.v).slice(0, 1);
  return mainItems(it.k).slice(0, 1);
}
function stageColor(st) {
  if (st == null) return null;
  if (st === 0) return "var(--st-lesson)";
  const g = GROUPS.find(g => st >= g.min && st <= g.max); return g ? g.c : null;
}
function fmtWhen(hoursFromNow) {
  if (hoursFromNow <= 0) return "now";
  const m = Math.round(hoursFromNow * 60);
  if (m < 60) return "in " + m + " min";
  const hh = Math.floor(m / 60), mm = m % 60;
  if (hh < 24) return "in " + hh + "h" + (mm ? " " + mm + "m" : "");
  const d = Math.round(hh / 24); return "in " + d + " day" + (d > 1 ? "s" : "");
}
function clockAt(hourStamp) {
  try { return new Date(hourStamp * HOUR).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }); } catch (e) { return ""; }
}

// ---------- items ----------
function rec(type, id) { return state[type][id]; }
function stageOf(type, id) { const r = rec(type, id); return r ? r[0] : null; }
function itemInfo(type, id) {
  if (type === "kanji") {
    const k = DATA.kanji[id];
    return { type, id, chars: id, L: k.L, meanings: k.m, readings: kanjiReadings(k), k };
  }
  const v = vocabByWord[id];
  return { type, id, chars: id, L: v.L, meanings: v.m, accepts: vocabAccepts(v), readings: v.r, v };
}
// Kanji reading questions test the on'yomi only; kun'yomi are learned through vocabulary.
// A kanji with no on'yomi (e.g. 畑) is quizzed on its kun'yomi instead.
// Each kanji card asks for its main reading: data fields p (readings) and pt ("on" or "kun"),
// picked from how common words actually read the kanji (手 = て, 口 = くち, 中 = ちゅう).
function isOnType(k) { return k.pt ? k.pt === "on" : onList(k).length > 0; }
function primaryKeys(k) { return k.p || (onList(k).length ? onList(k) : (k.kun || []).map(r => r.replace(/-/g, ""))); }
function mainItems(k) {
  const p = primaryKeys(k);
  if (isOnType(k)) return p.map(r => { const t = hira(r); return { text: t, key: "o:" + t }; });
  return p.map(r => ({ text: kunDisplay(r), key: "k:" + r.replace(/[-.]/g, "") }));
}
function kanjiReadings(k) {
  const p = primaryKeys(k);
  if (isOnType(k)) return p.map(hira);
  // a kun main reading accepts the stem or any full form built on it (こ, こむ, こめる)
  const stems = new Set(p.map(r => r.replace(/-/g, "").split(".")[0]));
  const out = new Set(stems);
  (k.kun || []).forEach(r => { const t = r.replace(/-/g, ""); if (stems.has(t.split(".")[0])) out.add(t.replace(".", "")); });
  return [...out];
}
function allReadingForms(k) { return onList(k).concat(kunForms(k)); }
function quizzedReadingsDisplay(k) { return mainItems(k).map(x => x.text); }
function readingTypeLabel(k) { return isOnType(k) ? "on'yomi" : "kun'yomi"; }
function otherReadingItems(k, kind) {
  const main = new Set(mainItems(k).map(x => x.key));
  return (kind === "on" ? onItems(k) : kunItems(k)).filter(x => !main.has(x.key));
}
function kunForms(k) {
  const out = new Set();
  (k.kun || []).forEach(r => {
    const s = r.replace(/-/g, "");
    const i = s.indexOf(".");
    if (i < 0) out.add(s); else { out.add(s.slice(0, i)); out.add(s.replace(".", "")); }
  });
  return [...out].filter(Boolean);
}
// Every accepted meaning of a word; number + つ counter words (五つ) also take "5 things", "5 items"...
function vocabAccepts(v) {
  const a = v.m.concat(v.a || []);
  if (/^[一二三四五六七八九]つ$/.test(v.w)) ["things", "items", "pieces", "objects"].forEach(t => a.push(v.m[0] + " " + t));
  return a;
}
function isGuru(kanjiId) { const s = stageOf("kanji", kanjiId); return s != null && s >= 5; }
// A word unlocks once every kanji in it is at Guru or above
function unlockedVocab(v) { return v.c.every(isGuru); }

function kanjiLessonQueue() {
  const q = [];
  for (let L = 1; L <= state.level; L++) {
    for (const k of DATA.levels[L - 1]) if (!rec("kanji", k)) q.push(["kanji", k]);
  }
  return q;
}
function vocabLessonQueue() {
  const q = [];
  for (const v of DATA.vocab) if (!rec("vocab", v.w) && unlockedVocab(v)) q.push(["vocab", v.w]);
  return q;
}
function dueQueue() {
  const t = nowH(), out = [];
  for (const type of ["kanji", "vocab"]) for (const id in state[type]) {
    const [st, nxt] = state[type][id];
    if (st >= 1 && st < 9 && nxt <= t) out.push([type, id]);
  }
  return out;
}
function nextReviewH() {
  let best = Infinity;
  for (const type of ["kanji", "vocab"]) for (const id in state[type]) {
    const [st, nxt] = state[type][id];
    if (st >= 1 && st < 9 && nxt < best) best = nxt;
  }
  return best;
}
function levelProgress(L) {
  const ks = DATA.levels[L - 1];
  const guru = ks.filter(isGuru).length;
  return { total: ks.length, guru, need: Math.ceil(ks.length * 0.9) };
}
function checkLevelUp() {
  let moved = false;
  while (state.level < 60) {
    const p = levelProgress(state.level);
    if (p.guru >= p.need) { state.level++; moved = true; } else break;
  }
  if (moved) { dirty.add("meta"); toast("Level " + state.level + " unlocked. New kanji are in your lessons."); }
}

// ---------- answer checking ----------
// Number words become digits, so "5" matches "five" and "twenty-one" matches "21"
const NUMW = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40,
  fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100, thousand: 1000 };
function numberize(str) {
  const out = [];
  for (const w of str.split(" ")) {
    const n = w in NUMW ? NUMW[w] : /^\d+$/.test(w) ? Number(w) : null;
    const prev = out.length ? out[out.length - 1] : null;
    if (n !== null && typeof prev === "number") {
      if ((n === 100 || n === 1000) && prev < n) { out[out.length - 1] = prev * n; continue; }
      if (prev >= 20 && prev % 10 === 0 && prev < 100 && n < 10) { out[out.length - 1] = prev + n; continue; }
      if (prev >= 100 && n < prev && prev % 100 === 0) { out[out.length - 1] = prev + n; continue; }
    }
    out.push(n !== null ? n : w);
  }
  return out.join(" ");
}
function normMeaning(s) {
  return numberize(String(s).toLowerCase().replace(/\(.*?\)/g, " ").replace(/^to\s+/, "").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim());
}
function lev(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length; if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}
function checkMeaning(input, meanings) {
  const a = normMeaning(input); if (!a) return null;
  for (const m of meanings) {
    const parts = [m, ...m.split(/[;,]/)];
    for (const p of parts) {
      const b = normMeaning(p); if (!b) continue;
      if (a.replace(/\D/g, "") !== b.replace(/\D/g, "") && /\d/.test(a + b)) continue; // numbers must match exactly
      const tol = b.length < 4 ? 0 : b.length < 8 ? 1 : 2;
      if (lev(a, b) <= tol) return true;
      // "think" counts for "think over": the answer matches the leading word(s) of a short meaning
      const bw = b.split(" "), aw = a.split(" ");
      if (bw.length <= 3 && aw.length < bw.length && a.length >= 3) {
        const head = bw.slice(0, aw.length).join(" ");
        if (lev(a, head) <= (head.length < 5 ? 0 : 1)) return true;
      }
    }
  }
  return false;
}
function checkReading(input, readings) {
  let a = hira(String(input).trim().replace(/n$/, "nn"));
  a = a.replace(/[^ぁ-ゟァ-ーー]/g, "");
  if (!a) return null;
  if (/[a-z]/i.test(a)) return null;
  return readings.map(hira).includes(hira(a));
}

// ---------- persistence ----------
function saveLocal() { try { localStorage.setItem("ladder-state", JSON.stringify(state)); } catch (e) {} }
function markDirty(type) { dirty.add(type); saveLocal(); flush(); }
async function flush() {
  if (!refs || saving || !dirty.size) return;
  saving = true;
  while (dirty.size) {
    const part = dirty.values().next().value; dirty.delete(part);
    try {
      if (part === "meta") await refs.meta.set({ level: state.level, started: state.started });
      else await refs[part].set({ items: state[part] });
    } catch (e) {
      dirty.add(part); // offline or a failed request: retried when back online or on the next change
      break;
    }
  }
  saving = false;
}

// ---------- hooks (shared memory aids) ----------
function hookId(ch) { return "u" + [...ch].map(c => c.codePointAt(0).toString(16)).join("-"); }
async function getHook(ch) {
  if (ch in hookCache) return hookCache[ch];
  if (!db) return null;
  try {
    const s = await db.doc("hooks/" + hookId(ch)).get();
    hookCache[ch] = s.exists ? (s.data() || {}).text || null : null;
  } catch (e) { hookCache[ch] = null; }
  return hookCache[ch];
}
async function saveHook(ch, text) {
  hookCache[ch] = text;
  if (!db) return;
  try { await db.doc("hooks/" + hookId(ch)).set({ k: ch, text }); } catch (e) { toast("Couldn't save the hook."); }
}
async function makeHook(ch) {
  const k = DATA.kanji[ch];
  const prompt = "Write a memory hook for a Japanese learner (around JLPT N4-N3) for the kanji " + ch + ".\n" +
    "Meanings: " + k.m.join(", ") + "\nOn'yomi: " + (onList(k).join("、") || "none") + "\nKun'yomi: " + (kunList(k).join("、") || "none") + "\n\n" +
    "Format: 2 or 3 short sentences, under 60 words, plain text, no headings or lists.\n" +
    "1) Name the quickest visual feature of the shape, breaking it into components with simple English names (for example 耂 = old man, 宀 = roof, 氵 = water).\n" +
    "2) A short vivid story that ties that shape to the meaning \"" + k.m[0] + "\".\n" +
    "Wrap the 1 to 3 most important words in **double asterisks**. Reply with only the hook.";
  const { text } = await sample(prompt, { cache: false });
  return text.trim();
}

function hookBox(ch) {
  const box = h("div", { class: "hook" }, h("span", { class: "eyebrow", text: "Memory hook" }), h("p", { class: "muted", text: "Loading…" }));
  const paint = (text) => {
    box.replaceChildren(h("span", { class: "eyebrow", text: "Memory hook" }));
    if (text) box.append(h("p", null, rich(text)));
    else box.append(h("p", { class: "muted", text: "No hook yet for this kanji." }));
    const tools = h("div", { class: "tools" });
    if (sample && !sampleOff) {
      const b = h("button", { class: "linkbtn", text: text ? "Write a new one" : "Make a hook with Claude" });
      b.onclick = async () => {
        b.disabled = true; b.textContent = "Thinking…";
        try { const t = await makeHook(ch); await saveHook(ch, t); paint(t); }
        catch (e) {
          if (["not_granted", "sampling_disabled", "not_declared", "capability_disabled", "capability_removed"].includes(e && e.code)) { sampleOff = true; paint(text); }
          else { b.disabled = false; b.textContent = e && e.code === "rate_limited" ? "Busy, try again shortly" : "Try again"; }
        }
      };
      tools.append(b);
    }
    if (db) {
      const e = h("button", { class: "linkbtn", text: text ? "Edit" : "Write my own" });
      e.onclick = () => {
        const ta = h("textarea", { id: "hook-edit-" + hookId(ch), "aria-label": "Memory hook" }); ta.value = text || "";
        const save = h("button", { class: "btn", text: "Save hook" });
        save.onclick = async () => { const v = ta.value.trim(); await saveHook(ch, v || null); paint(v || null); };
        box.replaceChildren(h("span", { class: "eyebrow", text: "Memory hook" }), ta, h("span", { class: "muted", style: "font-size:12px", text: "Tip: wrap key words in **double asterisks** to highlight them." }), save);
        ta.focus();
      };
      tools.append(e);
    }
    if (tools.children.length) box.append(tools);
  };
  getHook(ch).then(paint);
  return box;
}

// ---------- item info block (used in lessons, after answers, and the detail sheet) ----------
function infoBlock(item, opts = {}) {
  const wrap = h("div", { class: "info" });
  wrap.append(h("div", { class: "row" }, h("span", { class: "eyebrow", text: "Meaning" }), h("span", { class: "val", text: item.meanings.map(cap).join(", ") })));
  if (item.type === "kanji") {
    const k = item.k;
    wrap.append(h("div", { class: "row" }, h("span", { class: "eyebrow", text: "Readings" }),
      h("div", { class: "readings" },
        h("span", null, h("span", { class: "rlabel", text: "Main reading (" + readingTypeLabel(k) + ") · what reviews ask for" }), readingChips(mainItems(k))),
        otherReadingItems(k, "on").length ? h("span", { class: "kunrow" }, h("span", { class: "rlabel", text: "Other on'yomi" }), readingChips(otherReadingItems(k, "on"))) : null,
        otherReadingItems(k, "kun").length ? h("span", { class: "kunrow" }, h("span", { class: "rlabel", text: isOnType(k) ? "Kun'yomi · learned through vocabulary" : "Other kun'yomi" }), readingChips(otherReadingItems(k, "kun"))) : null)));
    wrap.append(hookBox(item.id));
    const vs = (vocabByKanji[item.id] || []).slice(0, 6);
    if (vs.length) {
      wrap.append(h("div", { class: "row" }, h("span", { class: "eyebrow", text: "Words that use it" }),
        h("div", { class: "chips" }, vs.map(v => h("button", { class: "chip", onclick: () => openDetail("vocab", v.w) },
          h("span", { class: "c", text: v.w }), h("span", { class: "m", text: v.r[0] + " · " + v.m[0] }))))));
    }
    const meta = [k.s + " strokes", "Level " + k.L, k.j ? "JLPT N" + k.j : null, k.f ? "#" + k.f + " in newspaper use" : null].filter(Boolean).join(" · ");
    wrap.append(h("span", { class: "muted", style: "font-size:12px", text: meta }));
  } else {
    const v = item.v;
    wrap.append(h("div", { class: "row" }, h("span", { class: "eyebrow", text: "Reading" }), readingChips(vocabReadingItems(v))));
    wrap.append(h("div", { class: "row" }, h("span", { class: "eyebrow", text: "Built from" }),
      h("div", { class: "chips" }, v.c.map(c => h("button", { class: "chip", onclick: () => openDetail("kanji", c) },
        h("span", { class: "c", text: c }), h("span", { class: "m", text: cap(DATA.kanji[c].m[0]) }))))));
  }
  const st = stageOf(item.type, item.id);
  if (opts.showStage && st != null) {
    const r = rec(item.type, item.id);
    const next = st >= 1 && st < 9 ? " · next review " + fmtWhen(r[1] - nowH()) : "";
    wrap.prepend(h("div", null, h("span", { class: "stagepill", style: "--c:" + stageColor(st), text: STAGE_NAMES[st] }), h("span", { class: "muted", style: "font-size:12px", text: next })));
  }
  return wrap;
}

function openDetail(type, id) {
  const it = itemInfo(type, id);
  const st = stageOf(type, id);
  const locked = st == null && !(type === "kanji" ? it.L <= state.level : unlockedVocab(it.v));
  dlg.replaceChildren(
    h("div", { class: "study", style: "border:0" },
      h("div", { class: "study-top" }, h("span", { class: "eyebrow", text: (type === "kanji" ? "Kanji" : "Vocabulary") + " · Level " + it.L + (locked ? " · locked" : "") }),
        h("button", { class: "x", "aria-label": "Close", onclick: () => dlg.close(), text: "Close" })),
      h("div", { class: "stage-char " + type }, h("div", { class: "bigchar", lang: "ja", text: it.chars }), sayBtn(mainSpeech(it), "Play reading", "big"))),
    h("div", { class: "dlg-body" }, infoBlock(it, { showStage: true })));
  if (!dlg.open) dlg.showModal();
}
dlg.addEventListener("click", e => { if (e.target === dlg) dlg.close(); });

// ---------- screens ----------
function setNav() {
  navHome.setAttribute("aria-current", screen === "home");
  navLevels.setAttribute("aria-current", screen === "levels");
  navReading.setAttribute("aria-current", screen === "reading" || screen === "story");
  document.querySelector(".nav").hidden = screen === "signin";
}
function go(s) { screen = s; session = null; render(); }
navHome.onclick = () => go("home");
navLevels.onclick = () => go("levels");
navReading.onclick = () => openReading();

function tile(type, id) {
  const st = stageOf(type, id);
  const unlocked = st != null || (type === "kanji" ? DATA.kanji[id].L <= state.level : unlockedVocab(vocabByWord[id]));
  const c = st != null ? stageColor(st) : unlocked ? "var(--st-lesson)" : null;
  return h("button", { class: "tile" + (unlocked ? "" : " locked"), style: c ? "--c:" + c : null, "aria-label": id + (st != null ? ", " + STAGE_NAMES[st] : unlocked ? ", ready to learn" : ", locked"),
    onclick: () => openDetail(type, id), text: id });
}
function legend() {
  return h("div", { class: "legend" },
    h("span", { style: "--c:var(--st-lesson)", text: "To learn" }),
    GROUPS.map(g => h("span", { style: "--c:" + g.c, text: g.name })));
}

function renderHome() {
  const L = state.level, p = levelProgress(L);
  const kl = kanjiLessonQueue(), vl = vocabLessonQueue(), due = dueQueue();
  const wordsLearned = Object.keys(state.vocab).length;
  const nxt = nextReviewH();
  const parts = [];

  parts.push(h("section", { class: "panel" },
    h("div", { class: "levelhead" },
      h("div", { class: "levelbadge" }, h("b", { text: String(L) }), h("small", { text: "Level" })),
      h("div", { class: "levelinfo" },
        h("h2", { text: p.guru >= p.need ? "Level complete" : "Get " + (p.need - p.guru) + " more kanji to Guru to reach level " + Math.min(60, L + 1) }),
        h("div", { class: "bar", role: "img", "aria-label": p.guru + " of " + p.total + " kanji at Guru" },
          h("i", { style: "width:" + (100 * p.guru / p.total).toFixed(1) + "%" }), h("span", { class: "goal", style: "left:" + (100 * p.need / p.total).toFixed(1) + "%" })),
        h("span", { class: "muted num", style: "font-size:13px", text: p.guru + " / " + p.total + " kanji at Guru · need " + p.need })))));

  parts.push(h("div", { class: "actions" },
    h("button", { class: "action lessons", disabled: !kl.length, onclick: () => startLessons("kanji") },
      h("span", { class: "n", text: String(kl.length) }), h("span", { class: "l", text: "Kanji lessons" }),
      h("span", { class: "s", text: kl.length ? "Learn " + Math.min(LESSON_BATCH, kl.length) + " new kanji" : "All level " + L + " kanji started" })),
    h("button", { class: "action vocab", disabled: !vl.length, onclick: () => startLessons("vocab") },
      h("span", { class: "n", text: String(vl.length) }), h("span", { class: "l", text: "Vocabulary lessons" }),
      h("span", { class: "s", text: vl.length ? "Words built from kanji you know" : wordsLearned ? "Guru more kanji to unlock words" : "Guru a kanji to unlock words" })),
    h("button", { class: "action reviews", disabled: !due.length, onclick: startReviews },
      h("span", { class: "n", text: String(due.length) }), h("span", { class: "l", text: "Reviews" }),
      h("span", { class: "s", text: due.length ? "Due now" : nxt < Infinity ? "Next " + fmtWhen(nxt - nowH()) : "Finish a lesson first" }))));

  const rd = stories.today;
  parts.push(h("button", { class: "readcard", onclick: openReading },
    h("span", { class: "rc-kanji", "aria-hidden": "true", text: "読" }),
    h("span", { class: "rc-body" }, h("span", { class: "l", text: "Today's reading" }),
      h("span", { class: "s", lang: rd ? "ja" : null, text: rd ? plainJp(rd.title) + (rd.titleEn ? " · " + rd.titleEn : "") : "A new short story at your level" })),
    h("span", { class: "rc-go", text: rd ? "Read" : "Start" })));

  // forecast, next 24 hours
  const t0 = Math.floor(nowH());
  const bins = new Array(24).fill(0);
  for (const type of ["kanji", "vocab"]) for (const id in state[type]) {
    const [st, n] = state[type][id];
    if (st >= 1 && st < 9) { const b = Math.floor(n) - t0; if (b >= 1 && b < 25) bins[b - 1]++; }
  }
  const mx = Math.max(1, ...bins), total24 = bins.reduce((a, b) => a + b, 0);
  const counts = GROUPS.map(g => {
    let n = 0; for (const type of ["kanji", "vocab"]) for (const id in state[type]) { const s = state[type][id][0]; if (s >= g.min && s <= g.max) n++; }
    return n;
  });
  parts.push(h("section", { class: "panel" },
    h("span", { class: "eyebrow", text: "Your items" }),
    h("div", { class: "spread" }, GROUPS.map((g, i) => h("div", { style: "--c:" + g.c }, h("b", { text: String(counts[i]) }), h("span", { text: g.name })))),
    h("span", { class: "eyebrow", text: "Reviews coming in the next 24 hours · " + total24 }),
    h("div", { class: "forecast", role: "img", "aria-label": total24 + " reviews in the next 24 hours" },
      bins.map(n => h("div", { class: n ? "has" : "", style: "height:" + (n ? Math.max(8, 100 * n / mx) : 3) + "%", title: n + " reviews" }))),
    h("div", { class: "fc-axis" }, h("span", { text: clockAt(t0 + 1) }), h("span", { text: clockAt(t0 + 12) }), h("span", { text: clockAt(t0 + 24) }))));

  parts.push(h("section", { class: "panel" },
    h("span", { class: "eyebrow", text: "Level " + L + " kanji" }),
    h("div", { class: "tiles" }, DATA.levels[L - 1].map(k => tile("kanji", k))),
    legend()));

  parts.push(h("p", { class: "muted", style: "font-size:12px;text-align:center;margin:0" }, "Audio: VOICEVOX:No.7 · ", h("button", { class: "linkbtn", style: "font-size:12px", onclick: signOut, text: "Sign out" })));
  if (!refs) parts.push(h("div", { class: "notice", text: "Progress is saved in this browser only. Open this page in Claude while signed in to keep it in your account." }));
  app.replaceChildren(...parts);
}

function renderLevels() {
  const parts = [h("section", { class: "panel" }, h("span", { class: "eyebrow", text: "All 60 levels · sorted by how common and how simple each kanji is" }), legend())];
  const list = h("div", { class: "levels-list" });
  // render current level first area quickly, rest after a tick
  const rows = [];
  for (let L = 1; L <= 60; L++) {
    const p = levelProgress(L);
    rows.push(h("section", { class: "lvlrow", id: "level-" + L },
      h("h3", null, "Level " + L + (L === state.level ? " · you are here" : L > state.level ? " · locked" : ""), h("span", { text: p.guru + " / " + p.total })),
      h("div", { class: "tiles" }, DATA.levels[L - 1].map(k => tile("kanji", k)))));
  }
  list.append(...rows);
  parts.push(h("section", { class: "panel" }, list));
  app.replaceChildren(...parts);
}

// ---------- study sessions ----------
function startLessons(type) {
  const q = (type === "vocab" ? vocabLessonQueue() : kanjiLessonQueue()).slice(0, LESSON_BATCH);
  if (!q.length) return;
  session = { kind: "lesson", lessonType: type, batch: q.map(([t, id]) => itemInfo(t, id)), i: 0, phase: "learn" };
  preloadAudio(session.batch);
  screen = "study"; render();
}
function startReviews() {
  const q = shuffle(dueQueue()).map(([t, id]) => itemInfo(t, id));
  if (!q.length) return;
  session = { kind: "review", pool: q, total: q.length, done: [], correctItems: 0 };
  preloadAudio(q);
  beginQuiz();
  screen = "study"; render();
}
function beginQuiz() {
  const items = session.kind === "lesson" ? session.batch : session.pool;
  session.phase = "quiz";
  session.queue = items.map(it => ({ it, need: shuffle(["meaning", "reading"]), wrongM: 0, wrongR: 0 }));
  if (session.kind === "review") shuffle(session.queue);
  session.active = [];
  session.finished = [];
  refill(); nextQuestion();
}
function refill() { while (session.active.length < REVIEW_WINDOW && session.queue.length) session.active.push(session.queue.shift()); }
function nextQuestion() {
  refill();
  if (!session.active.length) { session.q = null; session.phase = "summary"; return; }
  session.n = (session.n || 0) + 1;
  // A missed item waits a few questions before it comes back; never the same item twice in a row
  const last = session.q && session.q.entry;
  let pool = session.active.filter(e => !(e.readyAt > session.n) && e !== last);
  if (!pool.length) {
    const rest = session.active.filter(e => e !== last);
    const from = rest.length ? rest : session.active;
    pool = [from.reduce((a, b) => (a.readyAt || 0) <= (b.readyAt || 0) ? a : b)];
  }
  const pick = pool[Math.floor(Math.random() * pool.length)];
  const kind = pick.need[0];
  session.q = { entry: pick, kind, answered: null };
}
function submitAnswer(value) {
  const q = session.q; if (!q || q.answered) return;
  const it = q.entry.it;
  const res = q.kind === "meaning" ? checkMeaning(value, it.accepts || it.meanings) : checkReading(value, it.readings);
  if (res === false && q.kind === "reading" && it.type === "kanji" && checkReading(value, allReadingForms(it.k))) {
    // Another genuine reading isn't wrong, it's just not what this card asks for: let them try again
    q.hint = "That's another reading of " + it.id + ". This card asks for its main reading, the " + readingTypeLabel(it.k) + ".";
    q.draft = value; render(); return;
  }
  if (res === false && q.kind === "reading" && it.type === "vocab" && DATA.kanji[it.id] && checkReading(value, allReadingForms(DATA.kanji[it.id]))) {
    // 上 the word is うえ; typing the kanji's じょう deserves a nudge, not a fail
    q.hint = "That's a reading of the kanji " + it.id + ". On its own as a word, it's read differently.";
    q.draft = value; render(); return;
  }
  if (res === null) { // empty or invalid
    q.hint = q.kind === "reading" ? "Type the reading in kana (romaji converts as you type)." : "Type an English meaning.";
    if (q.kind === "meaning" && /[ぁ-ー]/.test(value)) q.hint = "That's kana. This one asks for the English meaning.";
    render(); return;
  }
  q.hint = null;
  q.answered = { value, ok: res };
  // Play the reading once it's no longer a spoiler (after the reading question, or the item's last question)
  if (res && (q.kind === "reading" || !q.entry.need.includes("reading"))) speak(answerAudio(it, q.kind === "reading" ? value : null));
  if (!res) { if (q.kind === "meaning") q.entry.wrongM++; else q.entry.wrongR++; }
  render();
}
function markTypo() {
  const q = session.q; if (!q || !q.answered || q.answered.ok) return;
  if (q.kind === "meaning") q.entry.wrongM--; else q.entry.wrongR--;
  q.answered.ok = true; q.answered.typo = true;
  if (q.kind === "reading" || !q.entry.need.includes("reading")) speak(answerAudio(q.entry.it, q.kind === "reading" ? q.answered.value : null));
  render();
}
function advance() {
  const q = session.q; if (!q || !q.answered) return;
  const e = q.entry;
  if (q.answered.ok) {
    e.need = e.need.filter(k => k !== q.kind);
    if (!e.need.length) {
      session.active = session.active.filter(x => x !== e);
      finishItem(e);
    }
  } else {
    e.readyAt = (session.n || 0) + 1 + MISS_GAP;
  }
  nextQuestion(); render();
}
function finishItem(e) {
  const it = e.it, type = it.type;
  const t = nowH();
  let from = stageOf(type, it.id), to;
  if (session.kind === "lesson") {
    to = 1;
  } else {
    const wrong = e.wrongM + e.wrongR;
    if (!wrong) to = Math.min(9, from + 1);
    else { const pen = from >= 5 ? 2 : 1; to = Math.max(1, from - Math.ceil(wrong / 2) * pen); }
  }
  state[type][it.id] = [to, to >= 9 ? 0 : Math.round((t + INTERVAL_H[to]) * 1000) / 1000];
  session.finished.push({ it, from, to, wrong: e.wrongM + e.wrongR });
  markDirty(type);
  if (type === "kanji" && to >= 5 && (from == null || from < 5)) {
    const n = (vocabByKanji[it.id] || []).filter(v => !rec("vocab", v.w) && unlockedVocab(v)).length;
    if (n) toast(n + " new word" + (n > 1 ? "s" : "") + " unlocked with " + it.id);
  }
  const before = state.level;
  checkLevelUp();
  if (state.level !== before) markDirty("meta");
}

function renderStudy() {
  const s = session;
  if (!s) return go("home");
  if (s.phase === "learn") return renderLearn();
  if (s.phase === "summary") return renderSummary();
  const q = s.q, it = q.entry.it;
  const doneCount = s.finished.length, totalCount = (s.kind === "lesson" ? s.batch.length : s.total);
  const top = h("div", { class: "study-top" },
    h("span", { class: "eyebrow num", text: (s.kind === "lesson" ? "Lesson quiz" : "Reviews") + " · " + doneCount + " / " + totalCount + " done" }),
    h("button", { class: "x", onclick: () => { go("home"); }, text: s.kind === "lesson" ? "Stop" : "Wrap up" }));
  // The play button only appears after answering, so it never gives the reading away
  const charBox = h("div", { class: "stage-char " + it.type }, h("div", { class: "bigchar", lang: "ja", text: it.chars }), q.answered ? sayBtn(mainSpeech(it), "Play reading", "big") : null);
  const band = h("div", { class: "qband " + q.kind },
    (it.type === "kanji" ? "Kanji " : "Vocabulary ") + (q.kind === "meaning" ? "meaning" : "reading"),
    h("small", { text: q.kind === "meaning" ? "in English" : it.type === "kanji" ? "main reading, " + readingTypeLabel(it.k) + " · type romaji" : "読み · type romaji" }));
  const input = h("input", { id: "answer-input", type: "text", autocomplete: "off", autocapitalize: "off", spellcheck: "false", lang: q.kind === "reading" ? "ja" : "en",
    placeholder: q.kind === "meaning" ? "Your answer" : "答え", "aria-label": q.kind === "meaning" ? "Meaning in English" : "Reading in kana" });
  const btn = h("button", { class: "go", type: "button", text: q.answered ? "Next" : "Check" });
  const form = h("form", { class: "answer " + q.kind }, input, btn);
  form.addEventListener("submit", ev => { ev.preventDefault(); studyAction(input.value); });
  btn.addEventListener("click", ev => { ev.preventDefault(); studyAction(input.value); });

  const wrap = h("div", { class: "study" }, top, charBox, band, form);
  if (!q.answered && q.draft) { input.value = q.draft; q.draft = null; }
  if (q.hint && !q.answered) wrap.append(h("div", { class: "feedback" }, h("span", { class: "muted", text: q.hint })));
  if (q.answered) {
    input.value = q.answered.value; input.readOnly = true;
    input.classList.add(q.answered.ok ? "right" : "wrong");
    const correctList = q.kind === "meaning" ? it.meanings.map(cap).join(", ") : (it.type === "kanji" ? quizzedReadingsDisplay(it.k).join("、") : it.readings.join("、"));
    const fb = h("div", { class: "feedback" },
      h("div", { class: "verdict " + (q.answered.ok ? "right" : "wrong") },
        h("span", { text: q.answered.ok ? (q.answered.typo ? "Counted as correct" : "Correct") : "Not quite" }),
        !q.answered.ok ? h("button", { class: "linkbtn", onclick: markTypo, text: "That was a typo" }) : null),
      !q.answered.ok || q.kind === "reading" ? h("div", null, h("span", { class: "eyebrow", text: q.kind === "meaning" ? "Accepted meanings" : it.type === "kanji" ? "Main reading" : "Readings" }), h("div", { class: "val" + (q.kind === "reading" ? " jp" : ""), text: correctList })) : null);
    if (!q.answered.ok) fb.append(infoBlock(it));
    fb.append(askPanel(q, it));
    wrap.append(fb);
  }
  app.replaceChildren(wrap);

  if (window.wanakana) { try { window.wanakana.unbind(input); } catch (e) {} if (q.kind === "reading" && !q.answered) window.wanakana.bind(input, { IMEMode: true }); }
  if (q.answered && q.chat && q.chat.open) {
    // Chatting: keep focus in the question box (on phones only right after opening it)
    const ai = document.getElementById("ask-input");
    if (ai && (!TOUCH || !q.chat.turns.length) && !q.chat.pending) ai.focus({ preventScroll: true });
  } else if (q.answered) {
    // On phones, close the keyboard so the Next tap lands on the button; on computers, Enter moves on
    if (TOUCH) { try { document.activeElement && document.activeElement.blur(); } catch (e) {} }
    else btn.focus({ preventScroll: true });
  } else input.focus({ preventScroll: true });
}

// One entry point for Check / Next, whatever triggered it (tap, Enter key, keyboard Go).
// It always acts on the live session, so a screen that fell out of step re-renders instead of doing nothing.
const TOUCH = (() => { try { return matchMedia("(hover: none), (pointer: coarse)").matches; } catch (e) { return false; } })();
let lastAction = 0;
function studyAction(value) {
  const t = Date.now();
  if (t - lastAction < 300) return; // ignore a ghost second tap from the same press
  lastAction = t;
  const q = session && session.q;
  try {
    if (!q) { render(); return; }
    if (q.answered) advance(); else submitAnswer(value);
  } catch (e) {
    reportBug(e);
    try { render(); } catch (e2) {}
  }
}
function reportBug(e) {
  const msg = (e && (e.message || e.code)) || String(e);
  toast("Something went wrong: " + msg + ". Tell Claude this message.");
}
window.addEventListener("error", ev => { if (ev && ev.error) reportBug(ev.error); });
window.addEventListener("unhandledrejection", ev => { const r = ev && ev.reason; if (r && r instanceof Error) reportBug(r); });

function renderLearn() {
  const s = session, it = s.batch[s.i];
  const wrap = h("div", { class: "study" },
    h("div", { class: "study-top" },
      h("span", { class: "eyebrow", text: "New " + (it.type === "kanji" ? "kanji" : "vocabulary") + " · " + (s.i + 1) + " of " + s.batch.length }),
      h("button", { class: "x", onclick: () => go("home"), text: "Stop" })),
    h("div", { class: "stage-char " + it.type }, h("div", { class: "bigchar", lang: "ja", text: it.chars }), sayBtn(mainSpeech(it), "Play reading", "big")),
    h("div", { class: "feedback", style: "padding-top:14px" }, infoBlock(it)),
    h("div", { class: "dots" }, s.batch.map((_, j) => h("i", { class: j === s.i ? "on" : "" }))),
    h("div", { class: "lesson-nav" },
      h("button", { class: "btn", disabled: s.i === 0, onclick: () => { s.i--; render(); }, text: "Back" }),
      s.i < s.batch.length - 1
        ? h("button", { class: "btn primary", id: "lesson-next", onclick: () => { s.i++; render(); }, text: "Next" })
        : h("button", { class: "btn primary", id: "lesson-next", onclick: () => { beginQuiz(); render(); }, text: "Start quiz" })));
  app.replaceChildren(wrap);
  // Start each new card at its top so the Back/Next bar stays in the same place on screen
  const top = app.getBoundingClientRect().top + window.scrollY - 8;
  if (window.scrollY > top) window.scrollTo(0, top);
  const nb = document.getElementById("lesson-next"); if (nb) nb.focus({ preventScroll: true });
}

function renderSummary() {
  const s = session;
  const ups = s.finished.filter(f => f.wrong === 0).length;
  const total = s.finished.length;
  const isVocab = s.lessonType === "vocab";
  const moreLessons = (isVocab ? vocabLessonQueue() : kanjiLessonQueue()).length, moreReviews = dueQueue().length;
  const title = s.kind === "lesson" ? "Learned " + total + (isVocab ? " new word" + (total === 1 ? "" : "s") : " new kanji") : Math.round(100 * ups / Math.max(1, total)) + "% right";
  const sub = s.kind === "lesson" ? "First review " + fmtWhen(INTERVAL_H[1]) + "." : ups + " of " + total + " moved up. Items you missed drop back so you see them sooner.";
  app.replaceChildren(h("div", { class: "panel summary" },
    h("div", { class: "big", text: s.kind === "lesson" ? (isVocab ? "語" : "学") : "✓" }),
    h("h2", { style: "margin:0", text: title }),
    h("span", { class: "muted", text: sub }),
    h("div", { class: "tiles" }, s.finished.map(f => tile(f.it.type, f.it.id))),
    h("div", { class: "actions", style: "width:100%" },
      h("button", { class: "btn", onclick: () => go("home"), text: "Home" }),
      s.kind === "lesson" && moreLessons
        ? h("button", { class: "btn primary", onclick: () => startLessons(s.lessonType), text: "Next " + Math.min(LESSON_BATCH, moreLessons) + (isVocab ? " words" : " kanji") })
        : moreReviews ? h("button", { class: "btn primary", onclick: startReviews, text: "Reviews (" + moreReviews + ")" }) : h("span"))));
}

function render() {
  setNav();
  if (screen === "signin") return renderSignin();
  if (!DATA) return;
  if (screen === "study") return renderStudy();
  if (screen === "levels") return renderLevels();
  if (screen === "reading") return renderReading();
  if (screen === "story") return renderStory();
  return renderHome();
}

document.addEventListener("keydown", e => {
  if (screen === "study" && session && session.phase === "learn") {
    if (e.key === "ArrowRight" && session.i < session.batch.length - 1) { session.i++; render(); }
    if (e.key === "ArrowLeft" && session.i > 0) { session.i--; render(); }
  }
});

// refresh due counts on the home screen as time passes
setInterval(() => { if (screen === "home" && DATA && !dlg.open) renderHome(); }, 60e3);

// ---------- "Ask Claude" on the answer screen ----------
// A short chat about the item just answered. Claude gets the item, its readings and meanings, and the answer given.
const ASK_OFF_CODES = ["not_granted", "sampling_disabled", "not_declared", "capability_disabled", "capability_removed"];
function askContext(q, it) {
  const lines = [
    "You are a friendly, accurate Japanese tutor inside a kanji study app. Keep answers short: 2 to 5 sentences, plain text, no headings, lists only if asked. Write Japanese words with their reading in parentheses, e.g. 中心 (ちゅうしん).",
    "The learner is on level " + state.level + " of 60, with grammar around JLPT N4 and working toward N3.", ""];
  if (it.type === "kanji") lines.push("They just reviewed the kanji " + it.id + ". Meanings: " + it.meanings.join(", ") + ". Main reading the app quizzes (" + readingTypeLabel(it.k) + "): " + quizzedReadingsDisplay(it.k).join("、") + ". All on'yomi: " + (onList(it.k).join("、") || "none") + ". All kun'yomi: " + (kunList(it.k).join("、") || "none") + ". Other readings are taught through vocabulary.");
  else lines.push("They just reviewed the word " + it.id + " (" + it.v.r.join("、") + "). Accepted meanings: " + (it.accepts || it.meanings).join(", ") + ". Kanji in it: " + it.v.c.map(c => c + " (" + DATA.kanji[c].m[0] + ")").join(", ") + ".");
  lines.push("The question asked for its " + (q.kind === "meaning" ? "English meaning" : "reading") + ". They answered \"" + q.answered.value + "\", which the app marked " + (q.answered.ok ? "correct" : "wrong") + ". If the app's marking looks mistaken, say so plainly.");
  lines.push("", "Answer their questions about this item. If a question isn't about Japanese, steer back politely.");
  return lines.join("\n");
}
function askSuggestions(q, it) {
  const out = [];
  if (!q.answered.ok) out.push(q.kind === "meaning" ? "Why isn't my answer right?" : "Why is it read this way?");
  out.push("Give me an example sentence");
  out.push(it.type === "kanji" ? "Common words with it" : "When would I use it?");
  out.push(it.type === "kanji" ? "Kanji that look like it" : "Words that are easy to confuse with it");
  return out.slice(0, 3);
}
function askPanel(q, it) {
  if (sampleOff || (!sample && !samplePromise)) return null;
  const c = q.chat || (q.chat = { open: false, turns: [], pending: false, partial: "", error: null });
  const box = h("div", { class: "ask" });
  if (!c.open) {
    box.append(h("button", { class: "askopen", type: "button", onclick: () => { c.open = true; render(); } },
      h("span", { class: "ask-ic", "aria-hidden": "true", text: "?" }), "Ask Claude about " + it.chars));
    return box;
  }
  box.append(h("span", { class: "eyebrow", text: "Ask Claude about " + it.chars }));
  const log = h("div", { class: "ask-log", "aria-live": "polite" });
  c.turns.forEach(t => log.append(h("div", { class: "bubble " + t.role }, t.role === "assistant" ? rich(t.content) : t.content)));
  if (c.pending) log.append(h("div", { class: "bubble assistant pending", id: "ask-pending", text: c.partial || "Thinking…" }));
  if (c.error) log.append(h("div", { class: "ask-err", text: c.error }));
  if (log.children.length) box.append(log);
  if (!c.turns.length && !c.pending) box.append(h("div", { class: "ask-chips" }, askSuggestions(q, it).map(sg => h("button", { class: "chipbtn", type: "button", onclick: () => askSend(q, it, sg), text: sg }))));
  const inp = h("input", { id: "ask-input", type: "text", autocomplete: "off", enterkeyhint: "send", "aria-label": "Your question", placeholder: c.turns.length ? "Ask a follow-up" : "Type a question" });
  const f = h("form", { class: "ask-form" }, inp, h("button", { class: "go", type: "submit", disabled: c.pending, text: "Ask" }));
  f.addEventListener("submit", ev => { ev.preventDefault(); ev.stopPropagation(); const v = inp.value.trim(); if (v) askSend(q, it, v); });
  box.append(f);
  return box;
}
async function askSend(q, it, text) {
  const c = q.chat;
  if (!c || c.pending) return;
  c.turns.push({ role: "user", content: text });
  c.pending = true; c.partial = ""; c.error = null;
  render();
  try {
    const smp = sample || (samplePromise ? await samplePromise : null);
    if (!smp) throw { code: "sampling_disabled" };
    const turns = [{ role: "user", content: askContext(q, it) }, ...c.turns.slice(-12)];
    const res = await smp(turns, { cache: false, onText: ({ text: t }) => { c.partial = t; const el = document.getElementById("ask-pending"); if (el) el.textContent = t; } });
    c.turns.push({ role: "assistant", content: res.text.trim() });
  } catch (e) {
    if (e && e.text) c.turns.push({ role: "assistant", content: e.text });
    if (e && ASK_OFF_CODES.includes(e.code)) c.error = "Claude features aren't enabled for this account. Check ALLOWED_EMAILS and ANTHROPIC_API_KEY in Vercel.";
    else if (e && e.code === "rate_limited") c.error = "Claude is busy right now. Try again in a minute.";
    else c.error = e && e.code === "offline" ? "You're offline. Ask again once you're connected." : "Couldn't get an answer. Try asking again.";
  }
  c.pending = false;
  if (screen === "study" && session && session.q === q) render();
}

// ---------- daily reading ----------
// One short story a day, written by Claude at the moment you open Reading, from the kanji and words
// you've learned. Saved privately to your account; past stories form the log book.
const stories = { list: null, today: null, generating: null, error: null, current: null, furiAll: false, showEn: false };
let storiesCol = null, samplePromise = null;
function todayKey() { const d = new Date(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }
function fmtDate(key) {
  try { const [y, m, d] = key.split("-").map(Number); return new Date(y, m - 1, d).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric", year: "numeric" }); }
  catch (e) { return key; }
}
function knownKanji() { return Object.keys(state.kanji).filter(k => state.kanji[k][0] >= 1); }
function knownWords() { return Object.keys(state.vocab).filter(w => state.vocab[w][0] >= 1); }
function plainJp(t) { return String(t || "").replace(/\{([^|{}]+)\|[^{}]*\}/g, "$1"); }

async function loadStories() {
  let list = [];
  if (storiesCol) {
    try { const snap = await storiesCol.orderBy("date", "desc").limit(500).get(); list = snap.docs.map(d => JSON.parse(JSON.stringify(d.data()))); }
    catch (e) { list = stories.list || []; }
  } else {
    try { list = JSON.parse(localStorage.getItem("ladder-stories") || "[]"); } catch (e) { list = []; }
  }
  stories.list = list;
  stories.today = list.find(s => s.date === todayKey()) || null;
}
async function saveStory(st) {
  stories.list = [st, ...(stories.list || []).filter(s => s.date !== st.date)];
  stories.today = st;
  try { localStorage.setItem("ladder-stories", JSON.stringify(stories.list.slice(0, 60))); } catch (e) {}
  if (storiesCol) { try { await storiesCol.doc(st.date).set(st); } catch (e) { toast("Couldn't save the story to your account."); } }
}
function storyPrompt() {
  const kanji = knownKanji(), words = knownWords().slice(-400);
  const recent = (stories.list || []).slice(0, 8).map(s => s.titleEn).filter(Boolean);
  return [
    "Write today's short reading for a Japanese learner. Today is " + todayKey() + ".",
    "",
    "The learner is on level " + state.level + " of a 60-level kanji course. Their grammar is around JLPT N4, working toward N3.",
    "Kanji they have learned (" + kanji.length + "): " + (kanji.join("") || "none yet"),
    "Words they have learned (" + words.length + "): " + (words.join("、") || "none yet"),
    recent.length ? "Recent stories, so pick a different topic and setting: " + recent.join("; ") : "",
    "",
    "Write an original, self-contained short story in natural Japanese, 8 to 14 sentences, about everyday life in Japan.",
    "Rules:",
    "- Write in kanji only the words made from the learned kanji; write other words in hiragana or katakana, the way a graded reader would. You may use up to 6 other common kanji words where the story needs them.",
    "- Use the learned words where they fit naturally.",
    "- Mark EVERY word that contains kanji as {kanji|reading}, with the reading of that part in hiragana and any okurigana outside the braces, e.g. {今日|きょう}は{山|やま}に{行|い}きました。",
    "- Plain polite style (です/ます) is fine; keep sentences short.",
    "",
    'Reply with only JSON in this shape: {"title": "...", "title_en": "...", "sentences": [{"jp": "...", "en": "..."}], "words": [{"word": "...", "reading": "...", "meaning": "..."}]}',
    '"title" and every "jp" use the {kanji|reading} marking. "en" is a natural English translation of that sentence.',
    '"words" lists up to 8 useful words from the story that are NOT in the learned list (word in its normal written form, reading in hiragana, short English meaning).',
  ].filter(l => l !== null).join("\n");
}
function normalizeStory(o) {
  if (!o || typeof o !== "object" || !Array.isArray(o.sentences)) throw { code: "invalid_json" };
  const sentences = o.sentences.map(s => ({ jp: String((s && s.jp) || "").trim(), en: String((s && s.en) || "").trim() })).filter(s => s.jp);
  if (sentences.length < 3) throw { code: "invalid_json" };
  const words = (Array.isArray(o.words) ? o.words : []).slice(0, 10).map(w => ({ word: String(w.word || ""), reading: String(w.reading || ""), meaning: String(w.meaning || "") })).filter(w => w.word);
  return { title: String(o.title || "今日の話"), titleEn: String(o.title_en || ""), sentences, words };
}
function storyErrorText(e) {
  const c = e && e.code;
  if (["not_granted", "sampling_disabled", "not_declared", "capability_disabled", "capability_removed"].includes(c)) return "Claude features aren't enabled for this account. Check ALLOWED_EMAILS and ANTHROPIC_API_KEY in Vercel.";
  if (c === "offline") return "You're offline. Today's story will be written once you're connected.";
  if (c === "session_expired") return "Your sign-in expired. Sign out and sign in again.";
  if (c === "rate_limited") return "Claude is busy right now. Try again in a minute.";
  if (c === "invalid_json") return "The story came back incomplete. Try again.";
  return "Couldn't write today's story. Try again.";
}
async function generateStory() {
  if (stories.generating || stories.today) return;
  stories.error = null;
  stories.generating = (async () => {
    const smp = sample || (samplePromise ? await samplePromise : null);
    if (!smp) throw { code: "sampling_disabled" };
    const out = await smp.json(storyPrompt(), { cache: false });
    const st = normalizeStory(out);
    Object.assign(st, { date: todayKey(), level: state.level, kanjiKnown: knownKanji().length, wordsKnown: knownWords().length, createdAt: Date.now() });
    await saveStory(st);
  })();
  render();
  try { await stories.generating; }
  catch (e) { stories.error = storyErrorText(e); }
  finally { stories.generating = null; }
  if (screen === "reading" || screen === "home") render();
}
function openReading() {
  go("reading");
  const kick = () => { if (!stories.today && !stories.generating && !stories.error) generateStory(); else render(); };
  if (stories.list === null) loadStories().then(kick); else kick();
}
function openStory(st) { stories.current = st; screen = "story"; render(); window.scrollTo(0, 0); }

function rubyFrag(text) {
  const frag = document.createDocumentFragment();
  const re = /\{([^|{}]+)\|([^{}]*)\}/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) frag.append(document.createTextNode(text.slice(last, m.index)));
    const base = m[1], rt = m[2];
    const ks = [...base].filter(c => /[㐀-鿿]/.test(c));
    const known = ks.length > 0 && ks.every(c => (state.kanji[c] || [0])[0] >= 1);
    const r = h("ruby", { class: known ? "known" : "new" }, base, h("rt", { text: rt }));
    r.addEventListener("click", e => { e.stopPropagation(); r.classList.toggle("show"); });
    frag.append(r);
    last = re.lastIndex;
  }
  if (last < text.length) frag.append(document.createTextNode(text.slice(last)));
  return frag;
}

function storyCard(st, isToday) {
  return h("button", { class: "storycard" + (isToday ? " today" : ""), onclick: () => openStory(st) },
    h("span", { class: "sc-date", text: isToday ? "Today" : fmtDate(st.date) }),
    h("span", { class: "sc-title", lang: "ja", text: plainJp(st.title) }),
    st.titleEn ? h("span", { class: "sc-en", text: st.titleEn }) : null,
    h("span", { class: "sc-meta", text: "Level " + st.level + " · " + st.sentences.length + " sentences" }));
}

function renderReading() {
  const parts = [];
  const top = h("section", { class: "panel" }, h("span", { class: "eyebrow", text: "Today's reading · " + fmtDate(todayKey()) }));
  if (stories.today) top.append(storyCard(stories.today, true));
  else if (stories.generating || stories.list === null) {
    top.append(h("div", { class: "writing" }, h("div", { class: "pen", "aria-hidden": "true", text: "書" }),
      h("div", null, h("strong", { text: stories.list === null ? "Opening your log book" : "Writing today's story" }),
        h("p", { class: "muted", text: "Built from the " + knownKanji().length + " kanji and " + knownWords().length + " words you've learned. This can take up to a minute." }))));
  } else if (stories.error) {
    top.append(h("p", { class: "err", text: stories.error }), h("button", { class: "btn primary", onclick: () => { stories.error = null; generateStory(); }, text: "Try again" }));
  } else {
    top.append(h("button", { class: "btn primary", onclick: generateStory, text: "Write today's story" }));
  }
  parts.push(top);

  const past = (stories.list || []).filter(s => s.date !== todayKey());
  parts.push(h("section", { class: "panel" },
    h("span", { class: "eyebrow", text: "Log book · " + past.length + " past " + (past.length === 1 ? "story" : "stories") }),
    past.length ? h("div", { class: "storylist" }, past.map(s => storyCard(s, false)))
      : h("p", { class: "muted", style: "margin:0", text: "Your earlier stories will collect here, one per day." })));
  app.replaceChildren(...parts);
}

function renderStory() {
  const st = stories.current;
  if (!st) return go("reading");
  const art = h("article", { class: "panel story" + (stories.furiAll ? " all-furi" : "") + (stories.showEn ? " show-en" : "") });
  const toggles = h("div", { class: "story-tools" },
    h("button", { class: "chipbtn", "aria-pressed": String(stories.furiAll), onclick: () => { stories.furiAll = !stories.furiAll; render(); }, text: stories.furiAll ? "Furigana: all" : "Furigana: new kanji only" }),
    h("button", { class: "chipbtn", "aria-pressed": String(stories.showEn), onclick: () => { stories.showEn = !stories.showEn; render(); }, text: stories.showEn ? "English: shown" : "English: hidden" }));
  art.append(
    h("div", { class: "story-head" },
      h("button", { class: "linkbtn", onclick: openReading, text: "← Log book" }),
      h("span", { class: "muted", style: "font-size:12px", text: fmtDate(st.date) + " · Level " + st.level })),
    h("h2", { class: "story-title", lang: "ja" }, rubyFrag(st.title)),
    st.titleEn ? h("p", { class: "muted story-en-title", text: st.titleEn }) : null,
    toggles,
    h("p", { class: "muted", style: "font-size:12px;margin:0", text: "Tap a word to see its reading. Tap a sentence's English button to check your understanding." }));
  const body = h("div", { class: "story-body", lang: "ja" });
  st.sentences.forEach(s => {
    const en = h("p", { class: "en", lang: "en", text: s.en });
    const row = h("div", { class: "sent" }, h("p", { class: "jp" }, rubyFrag(s.jp)),
      s.en ? h("button", { class: "enbtn", type: "button", "aria-label": "Show English", onclick: () => row.classList.toggle("open"), text: "EN" }) : null, en);
    body.append(row);
  });
  art.append(body);
  if (st.words && st.words.length) {
    art.append(h("div", { class: "row" }, h("span", { class: "eyebrow", text: "New words in this story" }),
      h("div", { class: "wordlist" }, st.words.map(w => h("div", { class: "worditem" },
        h("span", { class: "jp", lang: "ja", text: w.word }), h("span", { class: "muted", lang: "ja", text: w.reading }), h("span", { text: w.meaning }))))));
  }
  app.replaceChildren(art);
}

// The clip to play after a correct answer: the reading they typed, else the main reading
function answerAudio(it, typed) {
  const t = typed ? hira(String(typed).trim()) : null;
  if (it.type === "vocab") {
    const items = vocabReadingItems(it.v);
    const i = t ? it.v.r.findIndex(r => hira(r) === t) : 0;
    return items[Math.max(0, i)];
  }
  const list = mainItems(it.k);
  return (t && list.find(x => hira(x.text.replace(/[()]/g, "")) === t)) || list[0];
}

// ---------- backend: Supabase (sign-in, progress, stories, hooks) and Claude via /api/claude ----------
// These small adapters keep the same shape the app used inside the artifact, so the rest of the code is unchanged.
const SUPABASE_URL = "https://qrhlnlxohhsbkpdqygvn.supabase.co";
const SUPABASE_KEY = "sb_publishable_SWa7x_xCLtYE96bR7hFOVw_zN9L6j9i"; // publishable key: safe in the browser, data is protected by row-level security
const supa = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: true, autoRefreshToken: true } });
let uid = null, progressRowP = null, signinResolve = null, signinNote = "", signinBusy = false, signinEmail = "";

function throwIf(error) { if (error) throw Object.assign(new Error(error.message || "Request failed"), { code: error.code || "unavailable" }); }
function loadProgressRow() {
  if (!progressRowP) progressRowP = supa.from("progress").select("*").eq("user_id", uid).maybeSingle().then(({ data, error }) => { throwIf(error); return data; });
  return progressRowP;
}
async function upsertProgress(patch) {
  const { error } = await supa.from("progress").upsert(Object.assign({ user_id: uid, updated_at: new Date().toISOString() }, patch));
  throwIf(error);
}
function progressDoc(field) {
  return {
    async get() {
      const r = await loadProgressRow();
      return { exists: !!r, data: () => field === "meta" ? { level: r.level, started: r.started } : { items: r[field] || {} } };
    },
    async set(d) { await upsertProgress(field === "meta" ? { level: d.level, started: d.started } : { [field]: d.items }); },
  };
}
const storiesAdapter = {
  orderBy() { return this; }, limit() { return this; },
  async get() {
    const { data, error } = await supa.from("stories").select("data").eq("user_id", uid).order("date", { ascending: false }).limit(500);
    throwIf(error);
    return { docs: (data || []).map(r => ({ data: () => r.data })) };
  },
  doc(date) {
    return { async set(st) { const { error } = await supa.from("stories").upsert({ user_id: uid, date, data: st }); throwIf(error); } };
  },
};
const hooksAdapter = {
  doc(path) {
    const id = path.split("/").pop();
    return {
      async get() {
        const { data, error } = await supa.from("hooks").select("text").eq("id", id).maybeSingle();
        throwIf(error);
        return { exists: !!data, data: () => data || {} };
      },
      async set(d) { const { error } = await supa.from("hooks").upsert({ id, kanji: d.k, text: d.text, updated_at: new Date().toISOString() }); throwIf(error); },
    };
  },
};

// Claude: the same call shape the artifact runtime offered (sample(input, opts) and sample.json), served by /api/claude
function mergeTurns(turns) {
  const out = [];
  for (const t of turns) {
    const role = t.role === "assistant" ? "assistant" : "user";
    if (out.length && out[out.length - 1].role === role) out[out.length - 1].content += "\n\n" + t.content;
    else out.push({ role, content: String(t.content) });
  }
  return out;
}
function parseJsonLoose(text) {
  const tries = [text];
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) tries.push(fence[1]);
  const a = text.search(/[\[{]/), b = Math.max(text.lastIndexOf("}"), text.lastIndexOf("]"));
  if (a >= 0 && b > a) tries.push(text.slice(a, b + 1));
  for (const t of tries) { try { return JSON.parse(t); } catch (e) {} }
  throw { code: "invalid_json", text };
}
function makeSample() {
  async function call(input, opts = {}) {
    const messages = typeof input === "string" ? [{ role: "user", content: input }] : mergeTurns(input);
    const { data } = await supa.auth.getSession();
    const token = data && data.session ? data.session.access_token : "";
    let r;
    try {
      r = await fetch("/api/claude", { method: "POST", signal: opts.signal, headers: { "content-type": "application/json", authorization: "Bearer " + token },
        body: JSON.stringify({ messages, max_tokens: opts.maxTokens || 1500 }) });
    } catch (e) { throw { code: navigator.onLine === false ? "offline" : "upstream_error" }; }
    if (!r.ok) throw { code: r.status === 401 ? "session_expired" : r.status === 403 ? "not_granted" : r.status === 429 ? "rate_limited" : "upstream_error" };
    const j = await r.json();
    if (opts.onText) { try { opts.onText({ text: j.text, delta: j.text }); } catch (e) {} }
    return { text: j.text, truncated: j.stop_reason === "max_tokens" };
  }
  call.json = async (input, opts = {}) => { const { text } = await call(input, Object.assign({ maxTokens: 4000 }, opts)); return parseJsonLoose(text); };
  return call;
}

// Sign-in: email + password (works inside the home-screen app, where email links would open Safari instead)
async function ensureSignedIn() {
  const { data } = await supa.auth.getSession();
  if (data.session) return data.session;
  screen = "signin"; render();
  return new Promise(res => { signinResolve = res; });
}
async function doSignIn(email, pw, create) {
  if (signinBusy) return;
  signinEmail = (email || "").trim();
  if (!email || !pw) { signinNote = "Enter your email and a password."; render(); return; }
  signinBusy = true; signinNote = create ? "Creating your account…" : "Signing in…"; render();
  const { data, error } = create
    ? await supa.auth.signUp({ email: email.trim(), password: pw })
    : await supa.auth.signInWithPassword({ email: email.trim(), password: pw });
  signinBusy = false;
  if (error) { signinNote = error.message; render(); return; }
  if (!data.session) { signinNote = "Account created. Open the confirmation email Supabase sent you, then come back and sign in."; render(); return; }
  signinNote = ""; screen = "home";
  if (signinResolve) { const r = signinResolve; signinResolve = null; r(data.session); }
}
async function signOut() {
  try { await supa.auth.signOut(); } catch (e) {}
  try { localStorage.removeItem("ladder-state"); localStorage.removeItem("ladder-stories"); } catch (e) {}
  location.reload();
}
function renderSignin() {
  const email = h("input", { id: "si-email", type: "email", autocomplete: "username", inputmode: "email", placeholder: "Email", "aria-label": "Email" });
  email.value = signinEmail;
  const pw = h("input", { id: "si-pw", type: "password", autocomplete: "current-password", placeholder: "Password (6+ characters)", "aria-label": "Password" });
  const form = h("form", { class: "panel signin" },
    h("div", { class: "levelbadge", style: "align-self:center" }, h("b", { text: "梯" }), h("small", { text: "Kanji" })),
    h("h2", { text: "Sign in to Kanji Ladder" }),
    h("p", { class: "muted", text: "Your progress, daily stories and memory hooks are saved to your account." }),
    email, pw,
    h("div", { class: "actions" },
      h("button", { class: "btn primary", type: "submit", disabled: signinBusy, text: "Sign in" }),
      h("button", { class: "btn", type: "button", disabled: signinBusy, onclick: () => doSignIn(email.value, pw.value, true), text: "Create account" })),
    signinNote ? h("p", { class: "muted", role: "status", text: signinNote }) : null);
  form.addEventListener("submit", ev => { ev.preventDefault(); doSignIn(email.value, pw.value, false); });
  app.replaceChildren(form);
  (signinEmail ? pw : email).focus({ preventScroll: true });
}
window.addEventListener("online", () => flush());
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flush(); });

// ---------- boot ----------
async function loadData() {
  const r = await fetch("data.json");
  if (!r.ok) throw new Error("data " + r.status);
  DATA = await r.json();
  for (const v of DATA.vocab) {
    vocabByWord[v.w] = v;
    for (const c of v.c) (vocabByKanji[c] = vocabByKanji[c] || []).push(v);
  }
}
// Drop saved items that are no longer in the course (duplicate word cards that were removed)
function pruneState() {
  let n = 0;
  for (const id in state.vocab) if (!vocabByWord[id]) { delete state.vocab[id]; n++; }
  for (const id in state.kanji) if (!DATA.kanji[id]) { delete state.kanji[id]; n++; }
  return n;
}
function adopt(remote) {
  if (!remote) return;
  if (remote.meta && remote.meta.level) state.level = Math.max(1, Math.min(60, remote.meta.level));
  if (remote.meta && remote.meta.started) state.started = remote.meta.started;
  // Saved data arrives frozen (read-only); copy it so lessons and reviews can update it
  if (remote.kanji) state.kanji = JSON.parse(JSON.stringify(remote.kanji));
  if (remote.vocab) state.vocab = JSON.parse(JSON.stringify(remote.vocab));
}

async function start() {
  try { const l = JSON.parse(localStorage.getItem("ladder-state") || "null"); if (l && l.kanji) state = Object.assign(state, l); } catch (e) {}
  try { await loadData(); pruneState(); }
  catch (e) {
    app.replaceChildren(h("div", { class: "panel loading" }, h("strong", { text: "Couldn't load the kanji list" }), h("span", { text: "Reload the page to try again." })));
    return;
  }
  const authSession = await ensureSignedIn();
  uid = authSession.user.id;
  // a different account than last time on this device: start from that account's saved progress
  try { if (localStorage.getItem("ladder-uid") !== uid) { state = { level: 1, kanji: {}, vocab: {}, started: Date.now() }; localStorage.setItem("ladder-uid", uid); } } catch (e) {}
  if (screen === "signin") screen = "home";
  render();
  sample = makeSample(); samplePromise = Promise.resolve(sample);
  db = hooksAdapter;
  refs = { meta: progressDoc("meta"), kanji: progressDoc("kanji"), vocab: progressDoc("vocab") };
  storiesCol = storiesAdapter;
  try {
    const [m, k, v] = await Promise.all([refs.meta.get(), refs.kanji.get(), refs.vocab.get()]);
    if (m.exists || k.exists || v.exists) {
      adopt({ meta: m.exists ? m.data() : null, kanji: k.exists ? (k.data() || {}).items : null, vocab: v.exists ? (v.data() || {}).items : null });
      if (pruneState()) { dirty.add("kanji"); dirty.add("vocab"); flush(); }
      saveLocal();
    } else if (Object.keys(state.kanji).length) {
      // first time signed in with local progress: upload it
      dirty.add("meta"); dirty.add("kanji"); dirty.add("vocab"); flush();
    } else {
      dirty.add("meta"); flush();
    }
  } catch (e) { /* offline: keep using the copy on this device; changes save once back online */ }
  if (screen !== "study") render();
  if (stories.list === null) { await loadStories(); if (screen === "home") render(); }
}
start();
})();
