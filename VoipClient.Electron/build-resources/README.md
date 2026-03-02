# Build Resources

Place your app icons here before running `npm run dist:win`, `npm run dist:mac`, or `npm run dist:linux`.

## Required files

| File | Platform | Size |
|------|----------|------|
| `icon.ico` | Windows | 256×256 recommended (multi-size ICO) |
| `icon.icns` | macOS | 512×512 recommended |
| `icon.png` | Fallback / Linux | 512×512 PNG |

## Quick way to generate icons

1. Start with a 1024×1024 PNG (`icon.png`).
2. **Windows ICO** — use https://www.icoconverter.com or ImageMagick:
   ```
   magick icon.png -define icon:auto-resize=256,128,64,48,32,16 icon.ico
   ```
3. **macOS ICNS** — on a Mac:
   ```
   mkdir icon.iconset
   sips -z 512 512 icon.png --out icon.iconset/icon_512x512.png
   iconutil -c icns icon.iconset -o icon.icns
   ```

If no icons are present, electron-builder will use its default Electron icon.
