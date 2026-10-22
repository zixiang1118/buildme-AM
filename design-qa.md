# BuildMe Desktop — Design QA

> Historical design record for earlier desktop versions. The current product introduction is in [README.md](README.md); referenced local QA captures are not distributed.

## Source and viewport
- Source reference: `artifacts/buildme-reference.png` (2092 × 1444 px)
- Implementation capture: `artifacts/buildme-v037-implementation.png` (2080 × 1440 px)
- Normalized side-by-side comparison: `artifacts/buildme-v037-design-qa-comparison.png`
- Runtime viewport: 1040 × 720 CSS px on a 2× Retina display

## Comparison history

### Pass 1
- **P1 — Brand mark:** the previous letter-B tile did not match the supplied isometric cube mark.
- **P1 — Typography:** mixed serif styling and the undersized product line diverged from the macOS SF Pro / PingFang reference.
- **P1 — Proportions:** sidebar width, welcome block scale, and composer width drifted from the 250 px / 1040 × 720 reference geometry.
- **P2 — Surface treatment:** the earlier radial accent and heavy shadows were stronger than the restrained source.

Actions: generated the cube asset from the supplied reference with ImageGen, used it in both identity and welcome states, switched to native SF Pro/PingFang typography, restored the 250 px sidebar and neutral surfaces, and retuned the welcome/composer geometry.

### Pass 2
- **P0:** none.
- **P1:** none.
- **P2:** none.

### Pass 3 — typography and optical icon sizing
- Identified the reference typography as the native macOS system stack: SF Pro Display/Text for Latin glyphs and PingFang SC for Chinese glyphs.
- Applied Semibold 600 to product and welcome headings, Regular 400 to body/control copy, reference-matched line heights, and slightly tightened display-letter spacing.
- Removed transparent padding from the generated cube artwork so the visible cube—not the bitmap canvas—defines the sidebar and welcome icon sizes.
- Verified the 44 × 36 px sidebar image box and 62 × 58 px welcome image box at a 1040 × 720 CSS viewport.

The final capture preserves the reference hierarchy, split layout, header/composer placement, neutral palette, control density, and native macOS typography. Intentional product-specific differences are the `BuildMe` name, enlarged learning line, cube brand mark, model value, and empty-session state.

## Final verdict
**Passed** — no remaining P0/P1/P2 visual issues for the requested BuildMe variant.
