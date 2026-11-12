# Docs fonts

Geist and Geist Mono for the docs site, set in `theme.fonts` in
`../blume.config.ts`. Keeping them here means a build never downloads them; it
used to fetch them from Google Fonts, and a slow `fonts.gstatic.com` failed the
whole build.

They are the files Google Fonts served Blume for its `geist` and `geist-mono`
slugs: the Latin subset, upright and italic, each a variable font with a
100–900 weight axis. Google's CSS declared them as weights 400–700 (Geist) and
400–600 (Geist Mono), so heavier text rendered at those maximums. Blume cannot
declare a range for a local file (Astro reads it from the font), so each file's
`fvar` axis is narrowed to that range, and an `avar` map scales it back onto the
original axis. The outlines and variations are Google's unchanged, and the docs
render as they did. Done with fontTools:

```python
font = TTFont(source)  # fontTools.ttLib
(axis,) = font["fvar"].axes  # wght: 100, default 400, max 900; no avar
axis.minValue, axis.maxValue = 400.0, maximum  # 700 for Geist, 600 for Geist Mono
font["fvar"].instances = [i for i in font["fvar"].instances if 400 <= i.coordinates["wght"] <= maximum]
font["avar"] = newTable("avar")
font["avar"].segments = {"wght": {-1.0: -1.0, 0.0: 0.0, 1.0: (maximum - 400) / 500}}
font.flavor = "woff2"
font.save(target)
```

Both families are licensed under the SIL Open Font License 1.1 (`OFL.txt`). It
allows redistributing them, modified or not, bundled with other software, with
the copyright notice and licence kept beside them. The licence reserves no font
name, so the modified files can keep the names Geist and Geist Mono.
