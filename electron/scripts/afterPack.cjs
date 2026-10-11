// afterPack hook: ad-hoc sign the macOS app bundle (Sparkle-aware).
//
// On macOS this uses electron-sparkle-updater's adHocSignAfterPack which
// re-signs the .app after electron-builder stages extraFiles (including
// Sparkle.framework) — Sparkle's generate_appcast refuses archives whose
// .app doesn't pass codesign --verify --deep --strict.
//
// On non-darwin platforms this is a no-op.
const { adHocSignAfterPack } = require('electron-sparkle-updater/builder')

module.exports = adHocSignAfterPack
