// No-op stub for CI: this app currently never queries the OS keyboard
// layout, and the real package requires a Windows-native compile that fails
// on this VS image's ClangCL toolset (see workflow comment for the upstream
// issue).
exports.getCurrentKeyboardLayout = function getCurrentKeyboardLayout() {
  return null;
};
exports.getKeyMap = function getKeyMap() {
  return [];
};
exports.onDidChangeKeyboardLayout = function onDidChangeKeyboardLayout() {};
exports.isISOKeyboard = function isISOKeyboard() {
  return false;
};
