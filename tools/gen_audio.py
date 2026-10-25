"""Generate pronunciation clips for Kanji Ladder with VOICEVOX (No.7, Announce style).

Bundles: audio/on.json (every on'yomi), audio/L01.json .. L60.json (kun'yomi of that level's kanji
+ that level's vocabulary). Each bundle maps a key to a base64 MP3:
  o:<hiragana>   an on'yomi        k:<kana>   a kun'yomi (okurigana folded in)       w:<word>   a vocabulary word
Clips are cached by text so the script can be stopped and resumed.
"""
import base64, hashlib, json, os, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = sys.argv[1]
OUT = sys.argv[2]
ONLY = sys.argv[3] if len(sys.argv) > 3 and not sys.argv[3].startswith("--") else None  # e.g. "on,1-10"
STYLE = 30  # No.7 / アナウンス
CACHE = os.path.join(HERE, "cache")
os.makedirs(CACHE, exist_ok=True); os.makedirs(OUT, exist_ok=True)

d = json.load(open(DATA))

def hira(s):
    return "".join(chr(ord(c) - 0x60) if "ァ" <= c <= "ヶ" else c for c in s)
def kata(s):
    return "".join(chr(ord(c) + 0x60) if "ぁ" <= c <= "ゖ" else c for c in s)

def on_list(k):
    out = []
    for r in k.get("on") or []:
        r = hira(r.replace("-", ""))
        if r and r not in out: out.append(r)
    return out

def kun_spoken(k):
    out = []
    for r in k.get("kun") or []:
        s = r.replace("-", "").replace(".", "")
        if s and s not in out: out.append(s)
    return out

# --- jobs, in bundle order ---
jobs = {}  # bundle -> list of (key, text, kana)
seen = set()
def add(bundle, key, text, kana):
    if key in seen: return
    seen.add(key); jobs.setdefault(bundle, []).append((key, text, kana))

for ch, k in d["kanji"].items():
    for r in on_list(k): add("on", "o:" + r, r, r)
for L in range(1, 61):
    b = "L%02d" % L
    for ch in d["levels"][L - 1]:
        for r in kun_spoken(d["kanji"][ch]): add(b, "k:" + r, r, r)
    for v in d["vocab"]:
        if v["L"] == L: add(b, "w:" + v["w"], v["w"], v["r"][0])

def wanted(b):
    if not ONLY: return True
    for part in ONLY.split(","):
        if part == b: return True
        if "-" in part and b.startswith("L"):
            lo, hi = map(int, part.split("-"))
            if lo <= int(b[1:]) <= hi: return True
    return False

if "--count" in sys.argv:
    print({b: len(v) for b, v in jobs.items() if wanted(b)}, "total", sum(len(v) for b, v in jobs.items() if wanted(b)))
    sys.exit()

from voicevox_core.blocking import Onnxruntime, OpenJtalk, Synthesizer, VoiceModelFile
ort = Onnxruntime.load_once(filename=os.path.join(HERE, "vc/onnxruntime/voicevox_onnxruntime-linux-x64-1.17.3/lib/libvoicevox_onnxruntime.so.1.17.3"))
syn = Synthesizer(ort, OpenJtalk(os.path.join(HERE, "vc/dict/open_jtalk_dic_utf_8-1.11")), cpu_num_threads=2)
with VoiceModelFile.open(os.path.join(HERE, "vc/models/6.vvm")) as m:
    syn.load_voice_model(m)

VOWEL = {}
for row, v in (("アカサタナハマヤラワガザダバパァャ", "a"), ("イキシチニヒミリギジヂビピィ", "i"), ("ウクスツヌフムユルグズヅブプゥュッ", "u"),
               ("エケセテネヘメレゲゼデベペェ", "e"), ("オコソトノホモヨロヲゴゾドボポォョ", "o")):
    for c in row: VOWEL[c] = v
def norm(s):
    """Katakana pronunciation, long vowels unified (じょうげ and ジョ'オゲ compare equal)."""
    s = kata(s)
    s = "".join(c for c in s if "ァ" <= c <= "ー")
    out = []
    for c in s:
        prev = VOWEL.get(out[-1]) if out else None
        if c == "ー" and prev: c = {"a": "ア", "i": "イ", "u": "ウ", "e": "エ", "o": "オ"}[prev]
        elif c == "ウ" and prev == "o": c = "オ"
        elif c == "イ" and prev == "e": c = "エ"
        out.append(c)
    return "".join(out)

def synth(text, kana):
    """Prefer the written word (natural pitch accent) when the engine reads it the way we teach it."""
    src = kana
    if text != kana:
        try:
            q = syn.create_audio_query(text, STYLE)
            if norm(q.kana) == norm(kana): src = text
        except Exception:
            pass
    h = hashlib.sha1(("v1|%d|%s" % (STYLE, src)).encode()).hexdigest()
    mp3 = os.path.join(CACHE, h + ".mp3")
    if not os.path.exists(mp3):
        q = syn.create_audio_query(src, STYLE)
        q.speed_scale = 0.95
        q.pre_phoneme_length = 0.05
        q.post_phoneme_length = 0.12
        wav = syn.synthesis(q, STYLE)
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
            f.write(wav); tmp = f.name
        subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", tmp, "-ac", "1", "-ar", "24000", "-b:a", "40k", mp3], check=True)
        os.unlink(tmp)
    return open(mp3, "rb").read(), src != kana

done = 0
for b, lst in jobs.items():
    if not wanted(b): continue
    bundle, from_text = {}, 0
    for key, text, kana in lst:
        data, used_text = synth(text, kana)
        bundle[key] = base64.b64encode(data).decode()
        from_text += used_text
        done += 1
    json.dump(bundle, open(os.path.join(OUT, b + ".json"), "w"), separators=(",", ":"))
    print(b, len(lst), "clips", "(%d from written form)" % from_text, flush=True)
print("done", done)
