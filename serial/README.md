# Serial Monitor

A standalone single-file Web Serial monitor for the GitHub Pages site.
Browse to `/serial/` and you can talk to any USB serial device from Chrome/Edge 89+.

Features: Console (filterable text view), Terminal (xterm.js with ANSI/VT100),
Hex view, Live plotter, per-session log files, settings, auto-reconnect on
USB replug.

## Layout

```
serial/
├── index.html          # ASSEMBLED standalone output - do not edit by hand
├── build.ps1           # PowerShell assembly script
├── README.md           # this file
├── LICENSES.md         # MIT notices for bundled libraries
└── src/
    ├── app.js          # application logic        ← edit this
    ├── app.css         # custom styles            ← edit this
    ├── body.html       # <body> markup            ← edit this
    └── lib/
        ├── xterm.min.js
        ├── xterm.min.css
        └── xterm-addon-fit.min.js
```

## Editing & building

1. Edit any file in `src/`.
2. From this directory, run:
   ```powershell
   .\build.ps1
   ```
3. Commit `index.html` along with the source change.

The build is plain concatenation — no node/npm required.
`src/lib/` is shipped with a snapshot of xterm.js and is rarely touched.

## Note for Claude / future automated edits

Don't open or rebuild `src/lib/xterm.min.js`. It's 280 KB of minified code
that just exposes `window.Terminal` and `window.FitAddon`. Treat it as opaque.
All app logic lives in `src/app.js`. After any source edit, run
`.\build.ps1` from `serial/` to regenerate `index.html`.

## Updating xterm.js

```powershell
$lib = ".\src\lib"
Invoke-WebRequest "https://cdn.jsdelivr.net/npm/xterm@<VERSION>/lib/xterm.min.js"          -OutFile "$lib\xterm.min.js"          -UseBasicParsing
Invoke-WebRequest "https://cdn.jsdelivr.net/npm/xterm@<VERSION>/css/xterm.min.css"         -OutFile "$lib\xterm.min.css"         -UseBasicParsing
Invoke-WebRequest "https://cdn.jsdelivr.net/npm/xterm-addon-fit@<VERSION>/lib/xterm-addon-fit.min.js" -OutFile "$lib\xterm-addon-fit.min.js" -UseBasicParsing
```

Then update version numbers in `build.ps1` (banners) and `LICENSES.md`,
and re-run `.\build.ps1`.
