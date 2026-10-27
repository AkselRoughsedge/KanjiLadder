"""Add each kanji's visual components (field "r") to public/data.json from KRADFILE (EDRDG, CC BY-SA 4.0),
as published by jmdict-simplified (kradfile-*.json). Memory hooks are built from these parts.

Usage: python3 tools/add_components.py path/to/kradfile-x.y.z.json public/data.json
"""
import json, sys

# KRADFILE writes some components with a stand-in character; show the real shape instead.
STAND_IN = {
    "化": "亻", "个": "𠆢", "并": "丷", "刈": "刂", "込": "⻌", "尚": "⺌", "忙": "忄", "扎": "扌",
    "汁": "氵", "犯": "犭", "艾": "艹", "邦": "⻏", "阡": "⻖", "老": "耂", "杰": "灬", "礼": "礻",
    "疔": "疒", "禹": "禸", "初": "衤", "買": "罒", "乞": "𠂉",
}

krad = json.load(open(sys.argv[1]))["kanji"]
data = json.load(open(sys.argv[2]))
n = 0
for k, v in data["kanji"].items():
    parts = [STAND_IN.get(p, p) for p in krad.get(k, []) if p != k]
    if parts:
        v["r"] = parts
        n += 1
json.dump(data, open(sys.argv[2], "w"), ensure_ascii=False, separators=(",", ":"))
print("components added for", n, "of", len(data["kanji"]), "kanji")
