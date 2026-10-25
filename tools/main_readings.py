"""Pick each kanji's main reading from how common words actually read it, then drop word cards
that just repeat that reading. Updates data.json in place (levels and kanji order unchanged)."""
import json, glob, os, sys, collections

DL, DATA = sys.argv[1], sys.argv[2]
d = json.load(open(DATA))
jm = json.load(open(glob.glob(os.path.join(DL, "jmdict-eng-common*.json"))[0]))["words"]
K = d["kanji"]

def hira(s): return "".join(chr(ord(c) - 0x60) if "ァ" <= c <= "ヶ" else c for c in s)
VOICE = dict(zip("かきくけこさしすせそたちつてとはひふへほ", "がぎぐげござじずぜぞだぢづでどばびぶべぼ"))
VOICE.update({"は": "ば", "ひ": "び", "ふ": "ぶ", "へ": "べ", "ほ": "ぼ"})
HANDAKU = dict(zip("はひふへほ", "ぱぴぷぺぽ"))

def cands(k):
    """(type, reading key, sound) for each reading of kanji k."""
    out = []
    for r in K[k]["on"]:
        s = hira(r.replace("-", ""))
        if s: out.append(("on", s, s))
    for r in K[k]["kun"]:
        raw = r.replace("-", "")
        stem = raw.split(".")[0]
        if stem: out.append(("kun", raw, stem))
    return out

def variants(sound, pos, last):
    v = {sound}
    if pos > 0 and sound[0] in VOICE: v.add(VOICE[sound[0]])
    if pos > 0 and sound[0] in HANDAKU: v.add(HANDAKU[sound[0]] + sound[1:])
    if pos > 0 and sound[0] in VOICE: v.add(VOICE[sound[0]] + sound[1:])
    if not last and sound[-1] in "つちくき": v.add(sound[:-1] + "っ")
    return v

def split(word_kanji, reading):
    """All ways to read a pure-kanji word as one reading per kanji."""
    res = []
    def go(i, rest, acc):
        if i == len(word_kanji):
            if not rest: res.append(acc)
            return
        for (t, key, snd) in cands(word_kanji[i]):
            for v in variants(snd, i, i == len(word_kanji) - 1):
                if rest.startswith(v):
                    go(i + 1, rest[len(v):], acc + [(word_kanji[i], t, key)])
    go(0, reading, [])
    return res

score = collections.defaultdict(lambda: collections.Counter())
for w in jm:
    kf = [x for x in w["kanji"] if x.get("common")]
    if not kf: continue
    text = kf[0]["text"]
    rd = [hira(x["text"]) for x in w["kana"] if x.get("common")]
    if not rd: continue
    rd = rd[0]
    ks = [c for c in text if c in K]
    if not ks: continue
    if all(c in K for c in text) and 1 <= len(text) <= 3:
        sp = split(text, rd)
        if len(sp) >= 1:
            for (c, t, key) in sp[0]:
                score[c][(t, key)] += 1
    elif len(ks) == 1 and text[0] in K and all(not ("一" <= c <= "鿿") for c in text[1:]):
        c, oku = text[0], hira(text[1:])
        for (t, key, snd) in cands(c):
            if t == "kun" and "." in key and rd == hira(key.replace(".", "")).replace(hira(key.split(".")[1]), "") + oku and False:
                pass
            if t == "kun" and rd.startswith(snd) and (("." in key and hira(key.split(".")[1]) == oku) or ("." not in key and rd == snd + oku)):
                score[c][(t, key)] += 1
                break

changed = 0
for c, k in K.items():
    sc = score[c]
    on_sum = sum(v for (t, _), v in sc.items() if t == "on")
    kun_sum = sum(v for (t, _), v in sc.items() if t == "kun")
    has_on = bool([r for r in k["on"] if r.replace("-", "")])
    if not has_on: typ = "kun"
    elif kun_sum > on_sum * 1.5 and kun_sum >= 3: typ = "kun"
    else: typ = "on"
    ranked = [(key, v) for (t, key), v in sc.most_common() if t == typ]
    if ranked:
        top = ranked[0][1]
        prim = [key for key, v in ranked if v >= max(2, top * 0.3)][:2] or [ranked[0][0]]
    else:
        prim = [hira(k["on"][0].replace("-", ""))] if typ == "on" else [k["kun"][0].replace("-", "")]
    if typ == "on": prim = [hira(p) for p in prim]
    k["p"] = prim; k["pt"] = typ
    changed += 1

# drop word cards that are just the kanji read its main way (八 = はち next to the 八 kanji card)
def spoken(key): return hira(key.replace(".", ""))
before = len(d["vocab"])
keep = []
for v in d["vocab"]:
    if v["w"] in K:
        prim = {spoken(p) for p in K[v["w"]]["p"]}
        if hira(v["r"][0]) in prim:
            continue
    keep.append(v)
d["vocab"] = keep
json.dump(d, open(DATA, "w"), ensure_ascii=False, separators=(",", ":"))
kun_main = [c for c, k in K.items() if k["pt"] == "kun"]
print("kanji:", changed, "| main reading is kun'yomi for", len(kun_main), "| word cards", before, "->", len(keep))
for c in "一人日中上下手山目田生今円会出入子本力分月年大小見行書畑込気水口学先車":
    if c in K: print(c, K[c]["pt"], K[c]["p"], dict(score[c].most_common(4)))
print("kun-main sample:", "".join(kun_main[:80]))
