# SillyGoose Configuration Tool (hosted build)

This folder serves the live web app at
<https://patrick-mcguire.github.io/sillygoose/>.

**Do not edit these files by hand.** `index.html`, `manifest.webmanifest`, and
`service-worker.js` are generated artifacts. The source now lives in the
[SillyGooseTool](https://github.com/Patrick-McGuire/SillyGooseTool) repository
(`src/`, built by `build.mjs`). A GitHub Action in that repo rebuilds and pushes
the artifacts here on every change, so this URL always serves the latest build.

To change the app, edit `src/` in SillyGooseTool and push to its `main` branch.
