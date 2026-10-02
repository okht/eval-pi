# Report font sources

- Plantin Now Variable (upright/italic), Departure Mono and Commit Mono were obtained from https://pi.dev/fonts/ on 2026-09-23. The project owner stated that they have permission to use the Pi assets. Preserve original metadata. This record does not grant downstream font rights or place these fonts under the Noto license.
- Plantin static TTFs and mono TTFs are PDF-compatible derivatives of those local web assets.
- EvalPi Serif Regular/Medium are Noto Serif SC subsets (400/500), under the accompanying NotoSerifSC-OFL.txt. Source: https://github.com/google/fonts/tree/main/ofl/notoserifsc . These subsets cover the current demo only. Arbitrary model-generated Chinese needs full coverage or a subset generated from the actual report text.
- reports/theme.json records the Web and PDF family/file mapping. Copy the assets locally at build time; never embed GitHub credentials in reports.
