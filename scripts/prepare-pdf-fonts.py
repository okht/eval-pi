"""Build static, locally served OFL font subsets for the example PDF UI.

Source: google/fonts/ofl/notosanssc/NotoSansSC[wght].ttf (SIL OFL).
The OFL license is retained in public/fonts/OFL.txt.
"""
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tmp/python-deps"))
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
from fontTools import subset

source = ROOT / "tmp/fonts/NotoSansSC-Variable.ttf"
if not source.exists():
    raise SystemExit("Download the official Noto Sans SC variable TTF into tmp/fonts first.")

characters = set(chr(code) for code in range(32, 127))
for path in (ROOT / "src").rglob("*"):
    if path.suffix in (".ts", ".tsx", ".css"):
        characters.update(path.read_text(encoding="utf-8"))
characters.update("≤≥¥π→↗·×—「」：，。；？！％（）…")

for weight, name in ((400, "Regular"), (600, "SemiBold")):
    font = instantiateVariableFont(TTFont(source), {"wght": weight}, inplace=True)
    options = subset.Options()
    options.name_IDs = [0, 1, 2, 3, 4, 5, 6, 13, 14]
    options.name_legacy = True
    options.name_languages = [0x409]
    processor = subset.Subsetter(options=options)
    processor.populate(text="".join(characters))
    processor.subset(font)
    for entry in font["name"].names:
        replacement = {1: "EvalPi Sans", 2: name, 4: f"EvalPi Sans {name}", 6: f"EvalPiSans-{name}"}.get(entry.nameID)
        if replacement:
            entry.string = replacement.encode(entry.getEncoding())
    target = ROOT / f"public/fonts/EvalPiSans-{name}.ttf"
    font.save(target)
    print(f"{target.name}: {target.stat().st_size} bytes")
