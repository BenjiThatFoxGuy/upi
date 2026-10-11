// afterPack hook: ad-hoc sign the macOS app bundle.
//
// There is no Developer ID certificate yet, so electron-builder's own signing
// is turned off (mac.identity: null). Apple Silicon refuses to launch a bundle
// whose signature is broken, and repackaging breaks Electron's stock one, so
// re-sign everything (including the PyInstaller backend) with "-".
const { execFileSync } = require('child_process')
const path = require('path')

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return

  const appName = `${context.packager.appInfo.productFilename}.app`
  const appPath = path.join(context.appOutDir, appName)
  console.log(`  • ad-hoc signing  ${appPath}`)
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' })
}
