# 🎨 Codesu Logo & Branding

## Design Concept

The Codesu mark is a **silver "C" carrying a `</>` code glyph**, with motion streaks running off its left
side — the letter for the name, the glyph for what the app does, the streaks for how fast it moves.

### Visual Elements

- **The C** — heavy silver letterform, brushed-metal gradient, opening to the right
- **`</>`** — set inside the bowl, the coding cue
- **Motion streaks** — three lines trailing off the left of the C
- **App tile** — near-black rounded squircle, corner radius 23.3% of the side

### Sizing rule

The tile fills **89.8% of the icon canvas** (920 x 920 centered in 1024 x 1024), with the corners
transparent (not black) so the icon reads correctly on light backgrounds.

That number is deliberately *above* Apple's macOS icon grid, which puts a square icon body at
824 x 824 -- 80.5% of the canvas. Notes, Mail, Chrome and MongoDB Compass all sit on that grid.
Codesu followed it exactly for one release and looked visibly small beside them: the tile is
near-black, and a dark shape reads smaller than a light one of identical size. 920 is the size at
which it matches its dock neighbours by eye rather than by ruler.

Do not "fix" this back to 80.5%, and do not push it to 98% -- an earlier export filled almost the
whole canvas and made Codesu the biggest icon in the dock by a clear margin.

### Color Palette

| Color | Hex | Usage |
|-------|-----|-------|
| **White** | `#ffffff` | Highlight edge of the C |
| **Silver** | `#b8bcc2` | Body of the C and glyph |
| **Near-black** | `#0b0b0c` | App tile |

## Design Principles

✨ **Fluidity** — Smooth curves suggest seamless agent coordination  
🔗 **Connection** — Nodes represent interconnected agents  
🧠 **Intelligence** — Central orb symbolizes AI orchestration  
🎯 **Developer-Focused** — Clean, minimal, technical aesthetic  
📱 **Scalable** — Works from 16px favicon to 512px print  

## Logo Variants

### Primary Logo (256px+)
- Full design with gradient and depth
- Recommended for app icons, headers, presentations

### Favicon (16-32px)
- Simplified, optimized for small sizes
- Used in browser tabs and taskbars

### Monochrome (Future)
- Single-color version for black & white contexts
- Maintains recognition at all sizes

## File Locations

### Source Files
- `src-tauri/icons/logo_source.png` — Rendered source for icon generation (1024×1024)

### App Icons
```
src-tauri/icons/
├── icon.png              (512×512) — Main app icon
├── icon.icns             (macOS)
├── icon.ico              (Windows, multiple sizes)
├── 128x128.png          (HiDPI)
├── 128x128@2x.png       (HiDPI 2x)
├── 32x32.png            (Taskbar)
├── 64x64.png            (Medium)
└── Square*Logo.png      (Windows Store)
```

### Web & Branding
```
static/
└── favicon.png          (Web favicon)
```

## Usage Guidelines

### ✅ DO

- Use the full logo on light or dark backgrounds
- Scale proportionally to maintain aspect ratio
- Use minimum 32×32 for app icons
- Leave breathing room around the logo
- Use the provided color palette

### ❌ DON'T

- Distort or stretch the logo
- Change colors without permission
- Remove or alter design elements
- Use at sizes below 16×16
- Add drop shadows or effects
- Rotate or flip the design

## Favicon Usage

The favicon is automatically displayed:
- 📱 Browser tabs
- 🔖 Bookmarks
- 🖥️ App shortcuts
- 💾 Desktop icons

## Color Accessibility

The logo uses high-contrast colors:
- ✅ WCAG AA compliant (4.5:1 contrast ratio minimum)
- ✅ Readable on both light and dark backgrounds
- ✅ Distinguishable for colorblind users (multiple cues: shape, position, gradient)

## Logo History

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | Jul 2026 | Initial design - Water + Flow concept |
| 1.1 | Jul 2026 | Refined gradients and node positioning |
| 2.0 | Sep 2026 | "C" + `</>` mark with motion streaks; tile rescaled 80% → 98% of canvas |
| 2.1 | Sep 2026 | Tile rescaled 98% → 80.5% (Apple grid) → 89.8% for optical parity in the dock |

## Future Variations

Planned logo variants:
- [ ] Monochrome version (for printing)
- [ ] Animated version (for loading screens)
- [ ] SVG version (for web scaling)
- [ ] Icon set with related symbols
- [ ] 3D render (for marketing)

## Regenerating the icons

`src-tauri/icons/logo_source.png` (1024×1024, transparent corners) is the source of truth.
After replacing it:

1. Run `pnpm tauri icon src-tauri/icons/logo_source.png -o src-tauri/icons`
2. Delete the `ios/` and `android/` directories it also emits — Codesu is desktop-only
3. Copy a 512×512 version to `static/favicon.png`
4. Copy `128x128@2x.png` to `static/brand-mark.png` — the titlebar mark renders that file

Keep the tile at 89.8% of the canvas with transparent corners (see **Sizing rule** above).

> `src-tauri/icons/logo.svg` is an older vector experiment and does **not** match the shipped
> icons. Do not regenerate from it.

## License

The Codesu logo and branding are part of the Codesu project and are licensed under the MIT License. You may use the logo in:
- ✅ Project documentation
- ✅ Repository README
- ✅ Marketing materials
- ✅ Application packaging

For commercial use or modifications, please contact the project maintainers.

---

**Logo Design Concept**: Orchestration of AI agents through intelligent, fluid coordination.

*The logo embodies Codesu's mission: making AI-assisted development powerful, organized, and beautiful.*
