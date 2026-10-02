"""Prepare Pi reference typefaces and the matching Chinese serif for reports.

Pi web fonts are used at the user's express authorization. Preserve their
original metadata. Noto Serif SC is distributed under the included SIL OFL.
"""
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tmp/python-deps'))
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
from fontTools import subset
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.pens.cu2quPen import Cu2QuPen

OUT = ROOT / 'public/fonts'
characters = set(chr(code) for code in range(32, 127))
for path in (ROOT / 'src').rglob('*'):
    if path.suffix in ('.ts', '.tsx', '.css'):
        characters.update(path.read_text(encoding='utf-8'))
characters.update('≤≥¥π→↗·×—「」：，。；？！％（）…')

def save(font, name):
    font.flavor = None
    font.save(OUT / name)
    print(name, (OUT / name).stat().st_size)

for weight, label in [(400, 'Regular'), (500, 'Medium')]:
    source = TTFont(ROOT / 'tmp/fonts/NotoSerifSC-Variable.ttf')
    font = instantiateVariableFont(source, {'wght': weight}, inplace=True)
    options = subset.Options()
    options.name_IDs = [0, 1, 2, 3, 4, 5, 6, 13, 14]
    options.name_legacy = True
    processor = subset.Subsetter(options=options)
    processor.populate(text=''.join(characters))
    processor.subset(font)
    for entry in font['name'].names:
        value = {1: 'EvalPi Serif', 2: label, 4: f'EvalPi Serif {label}', 6: f'EvalPiSerif-{label}'}.get(entry.nameID)
        if value:
            entry.string = value.encode(entry.getEncoding())
    save(font, f'EvalPiSerif-{label}.ttf')
    plantin = instantiateVariableFont(TTFont(OUT / 'PlantinNowVariable-Upright.woff2'), {'wght': weight, 'opsz': 18}, inplace=True)
    save(plantin, f'Plantin-{label}.ttf')

for source, name in [('DepartureMono-Regular.woff2', 'DepartureMono-Regular.ttf'), ('CommitMono-400-Regular.otf', 'CommitMono-Regular.ttf')]:
    font = TTFont(OUT / source)
    if 'CFF ' in font:
        glyph_set = font.getGlyphSet()
        glyphs = {}
        for glyph_name in font.getGlyphOrder():
            pen = TTGlyphPen(glyph_set)
            glyph_set[glyph_name].draw(Cu2QuPen(pen, max_err=1.0, reverse_direction=True))
            glyphs[glyph_name] = pen.glyph()
        del font['CFF ']
        if 'VORG' in font:
            del font['VORG']
        font.sfntVersion = '\x00\x01\x00\x00'
        builder = FontBuilder(font=font, isTTF=True)
        builder.isTTF = True
        builder.setupGlyf(glyphs)
        builder.setupMaxp()
        builder.setupPost()
    save(font, name)
