Font: Ioskeley Mono v2.2.0 (ahatem/IoskeleyMono, an Iosevka build), Medium (500) and Bold (700), SIL Open Font License 1.1 (no Reserved Font Name), see OFL-IoskeleyMono.txt. Shared by every native app (mp-shell, mp-files). The look of hooxoo's Noctalia setup (Noctalia Look plan, 2026-11-08): its bar draws this font at 15 px, matched on the picture (9 px a letter).

Trimmed from the release's Normal/Unhinted TTFs with fonttools `pyftsubset` (default layout features, all names kept) to Latin + Latin Extended, combining marks, Greek, Cyrillic, punctuation, currency, letterlike, arrows, maths, technical, box drawing + shapes, misc symbols:
`--unicodes=U+0020-007E,U+00A0-024F,U+0300-036F,U+0370-03FF,U+0400-04FF,U+1E00-1EFF,U+2000-206F,U+20A0-20CF,U+2100-214F,U+2190-21FF,U+2200-22FF,U+2300-23FF,U+2500-25FF,U+2600-26FF,U+FFFD`
1.5 MB -> 284 KB a weight: iced copies each loaded font into the heap (`iced_graphics` 0.14 `text.rs` `load_font`, `into_owned`), so every app carries what is embedded here.

Rubik.ttf + OFL.txt (the font before, Rubik variable, OFL 1.1) removed 2026-11-08 once Malthaiel signed the new look off (Noctalia Look steps 1-2); in git history before that commit.
