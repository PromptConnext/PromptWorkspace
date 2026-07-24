// No-op stub for CI: this spike's smoke test never lists OS drives, and the
// real package requires a Windows-native compile that fails on this VS
// image's ClangCL toolset (see workflow comment for the upstream issue).
exports.list = async function list() {
  return [];
};
