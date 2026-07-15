# MINE PWA Icons

This folder needs three PNG icons for full PWA support across all platforms:

| File | Size | Usage |
|---|---|---|
| `icon-192.png` | 192×192 | Android home screen, basic PWA |
| `icon-512.png` | 512×512 | Android splash, share thumbnails |
| `icon-180.png` | 180×180 | iOS home screen ("Add to Home Screen") |

## How to generate them

**Option 1 — Use an online PWA icon generator** (5 minutes):
- https://realfavicongenerator.net/ — paste your MINE logo, downloads all sizes
- Drop the three required files into this folder

**Option 2 — From your existing brand kit:**
- Take your MINE logomark (square version)
- Export at 192×192, 512×512, and 180×180 as PNG
- Background can be transparent or solid `#6366F1` (matches `theme_color`)
- Use "maskable" safe zone: keep important content within central 80%

## Until icons exist

The PWA still functions — it just shows the default browser-supplied icon.
"Add to Home Screen" works. Service worker caches assets. Offline still works.

Add the real icons when convenient, no urgency.
