# Report typefaces

- Plantin Now Variable Upright / Italic, Departure Mono, Commit Mono: obtained from the corresponding publicly served assets on https://pi.dev/fonts/ on 2026-09-23. The user expressly authorized matching the Pi website and stated they have permission. Original font metadata is preserved; this note does not grant downstream font rights.
- EvalPi Serif: static subsets of Noto Serif SC, weights 400 and 500. Source: https://github.com/google/fonts/tree/main/ofl/notoserifsc . See NotoSerifSC-OFL.txt.
- EvalPi Sans: earlier Noto Sans SC static subsets; retained for compatibility. See OFL.txt.

`scripts/prepare-report-fonts.py` builds the local static fonts used by PDF export. Browser previews use the same Chinese font subsets and original Pi web fonts.
