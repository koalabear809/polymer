# Releasing Polymer

Builds for macOS (Apple Silicon and Intel), Windows and Linux are made by GitHub Actions
and published as GitHub Releases. Installed copies check the latest release, verify its
signature with the public key built into the app, and offer to update. No server needed.

## Ship a new version

```sh
scripts/release.sh 0.2.0
```

That sets `version` in `src-tauri/Cargo.toml` (the one place the version lives), commits,
tags `v0.2.0` and pushes. Then:

1. Watch the build: `gh run watch` (about 15-25 minutes; Windows and the Mac builds are slowest).
2. Open the **draft** release on GitHub, check the assets (a `.dmg` per Mac architecture, a
   Windows installer, an AppImage, a `.deb`, and `latest.json`), edit the release notes, and
   click **Publish release**.
3. Installed copies offer the update at their next start, or immediately with `SPC h u`.

The release stays a draft until you publish it, so a broken build never reaches users.
Delete the draft and the tag to start over: `gh release delete v0.2.0 --cleanup-tag`.

## Try the build without releasing

Actions tab → **Release** → *Run workflow* (or `gh workflow run release.yml`). It builds
every platform and keeps the installers as run artifacts; it does not create a release.

## One-time setup (done)

- An update-signing key pair, made with `cargo tauri signer generate`. The **public** key is
  in `src-tauri/tauri.conf.json`; the **private** key is the repository secret
  `TAURI_SIGNING_PRIVATE_KEY` (a copy is in `~/.polymer-keys/updater.key` on the machine
  that created it; the key has no password). **If it is lost, installed copies can never
  update again** and people must reinstall by hand, so keep a backup somewhere safe.
- The updater endpoint is
  `https://github.com/koalabear809/polymer/releases/latest/download/latest.json`.

## Notes

- Builds are **not code-signed** (no Apple or Microsoft certificate). The update signature
  protects updates; it does not remove first-install warnings. Add Apple signing and
  notarization later by setting the `APPLE_*` secrets documented by `tauri-action`.
- macOS builds are ad-hoc signed so Apple Silicon Macs will run them.
- To change where updates come from, edit `plugins.updater.endpoints` in `tauri.conf.json`.
