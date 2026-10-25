import json, glob, re, sys, os

D = sys.argv[1]
OUT = sys.argv[2]
kd = json.load(open(os.path.join(D, "kanji.json")))
jm = json.load(open(glob.glob(os.path.join(D, "jmdict-eng-common*.json"))[0]))["words"]

# --- jōyō kanji (grades 1-6 and 8), using only KANJIDIC fields ---
joyo = {k: v for k, v in kd.items() if v.get("grade") in (1, 2, 3, 4, 5, 6, 8)}

def clean_meanings(ms):
    out = []
    for m in ms:
        if re.search(r"radical|\(no\.", m, re.I):
            continue
        m = m.strip()
        if m and m.lower() not in [x.lower() for x in out]:
            out.append(m)
    return out[:4]

ks = []
for k, v in joyo.items():
    ms = clean_meanings(v.get("meanings") or [])
    if not ms:
        continue
    ks.append({
        "k": k, "s": v["strokes"], "f": v.get("freq") or 2600, "g": v["grade"],
        "j": v.get("jlpt_new"), "m": ms,
        "on": v.get("readings_on") or [], "kun": v.get("readings_kun") or [],
    })

# percentile ranks
def pct(vals):
    order = sorted(range(len(vals)), key=lambda i: vals[i])
    r = [0.0] * len(vals)
    for pos, i in enumerate(order):
        r[i] = pos / (len(vals) - 1)
    return r

pf = pct([x["f"] for x in ks])
ps = pct([x["s"] + 0.01 * x["f"] / 2600 for x in ks])
pg = pct([x["g"] + 0.001 * x["f"] for x in ks])
for i, x in enumerate(ks):
    # usage dominates, difficulty (stroke count) second, school grade as a gentle nudge
    x["score"] = 0.50 * pf[i] + 0.36 * ps[i] + 0.14 * pg[i]
ks.sort(key=lambda x: x["score"])

# --- 60 levels: smaller first levels, like WaniKani ---
N = len(ks)
first = [18, 22, 26]
rest = N - sum(first)
per = rest // 57
extra = rest - per * 57
sizes = first + [per + (1 if i < extra else 0) for i in range(57)]
assert sum(sizes) == N
levels = []
i = 0
for L, sz in enumerate(sizes, 1):
    for x in ks[i:i + sz]:
        x["L"] = L
    levels.append([x["k"] for x in ks[i:i + sz]])
    i += sz
lvl = {x["k"]: x["L"] for x in ks}

# --- vocabulary: common words built only from kanji you have reached ---
KANJI_RE = re.compile(r"[一-鿿㐀-䶿々]")
cands = {}
for w in jm:
    kforms = [kf for kf in w["kanji"] if kf.get("common")]
    if not kforms:
        continue
    text = kforms[0]["text"]
    chars = [c for c in text if KANJI_RE.match(c) and c != "々"]
    if not chars or any(c not in lvl for c in chars):
        continue
    if len(text) > 5 or not re.fullmatch("[\u3041-\u309F\u4E00-\u9FFF\u3005]+", text):
        continue
    misc = set(m for sn in w["sense"][:1] for m in sn.get("misc", []))
    if misc & {"arch", "obs", "rare", "uk", "obsc", "sl", "vulg", "derog", "male-sl"}:
        continue
    readings = [kn["text"] for kn in w["kana"] if kn.get("common") and
                ("*" in kn.get("appliesToKanji", ["*"]) or text in kn.get("appliesToKanji", []))]
    if not readings:
        continue
    # skip pure archaic / name-ish senses
    sense = w["sense"][0]
    glosses = [g["text"] for g in sense["gloss"]][:3]
    if len(w["sense"]) > 1:
        glosses += [g["text"] for g in w["sense"][1]["gloss"]][:2]
    glosses = list(dict.fromkeys(glosses))[:4]
    if not glosses:
        continue
    # every other everyday sense is also accepted as an answer (中 = inside, among, middle, during...)
    extra = []
    for sn in w["sense"][:8]:
        if set(sn.get("misc", [])) & {"arch", "obs", "rare", "sl", "vulg", "derog", "male-sl"}:
            continue
        extra += [g["text"] for g in sn["gloss"]]
    extra = [g for g in dict.fromkeys(extra) if g not in glosses][:16]
    L = max(lvl[c] for c in chars)
    # owner = the newest kanji in the word
    entry = {"w": text, "r": readings[:3], "m": glosses, "a": extra, "L": L, "c": sorted(set(chars)),
             "pos": sense["partOfSpeech"][:2]}
    nk = len(set(chars))
    # prefer: single kanji words with okurigana or 2-kanji compounds, short
    nsense = min(len(w["sense"]), 6)
    entry["_rank"] = (0 if nk <= 2 else 1, -nsense, abs(len(text) - 2), len(text))
    for c in set(chars):
        if lvl[c] == L:
            cands.setdefault(c, []).append(entry)

vocab = {}
# Per kanji: the kanji on its own as a word (its kun'yomi, e.g. 下 = した), then up to 2
# okurigana words (下がる), then up to 3 compounds (地下). Kun'yomi are learned through these.
for x in ks:
    lst = sorted(cands.get(x["k"], []), key=lambda e: e["_rank"])
    alone = [e for e in lst if e["w"] == x["k"]]
    okuri = [e for e in lst if len(e["c"]) == 1 and e["w"] != x["k"]]
    comp = [e for e in lst if len(e["c"]) > 1]
    for group, cap in ((alone, 1), (okuri, 2), (comp, 3)):
        picked = 0
        for e in group:
            if picked >= cap:
                break
            if e["w"] in vocab:
                continue
            vocab[e["w"]] = e
            picked += 1

vlist = sorted(vocab.values(), key=lambda e: (e["L"], 0 if len(e["c"]) == 1 else 1, e["_rank"]))
for e in vlist:
    e.pop("_rank", None)

kmean = {x["k"]: x["m"] for x in ks}
def accepts(e):
    a = list(e["a"])
    if e["w"] in kmean:  # a kanji on its own as a word also takes the kanji's meanings
        a += [m for m in kmean[e["w"]] if m.lower() not in [g.lower() for g in e["m"] + a]]
    return a

data = {
    "levels": levels,
    "kanji": {x["k"]: {"m": x["m"], "on": x["on"], "kun": x["kun"], "s": x["s"], "f": x["f"] if x["f"] < 2600 else None,
                       "j": x["j"], "L": x["L"]} for x in ks},
    "vocab": [dict({"w": e["w"], "r": e["r"], "m": e["m"], "L": e["L"], "c": e["c"]}, **({"a": accepts(e)} if accepts(e) else {})) for e in vlist],
}
json.dump(data, open(OUT, "w"), ensure_ascii=False, separators=(",", ":"))
print("kanji", N, "vocab", len(vlist), "bytes", os.path.getsize(OUT))
for L in (1, 2, 3, 4, 10, 30, 60):
    print(L, "".join(levels[L - 1]))
print("vocab L1:", [e["w"] for e in vlist if e["L"] == 1])
print("vocab L2:", [e["w"] for e in vlist if e["L"] == 2])
