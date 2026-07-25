// No-op stub for CI: this app currently never lists OS drives, and the
// real package requires a Windows-native compile that fails on this VS
// image's ClangCL toolset (see .github/workflows/desktop-theia-build.yml's comment; ported from the M0 spike's spikes/theia-shell/stubs/).
exports.list = async function list() {
  return [];
};
