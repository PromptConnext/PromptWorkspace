import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const config = {
  runner: "local",
  specs: ["./wdio-e2e/**/*.spec.js"],
  maxInstances: 1,
  capabilities: [{}],
  logLevel: "info",
  waitforTimeout: 20000,
  connectionRetryTimeout: 120000,
  connectionRetryCount: 3,
  framework: "mocha",
  reporters: ["spec"],
  mochaOpts: {
    ui: "bdd",
    timeout: 2700000,
  },
  services: [
    [
      "tauri",
      {
        appBinaryPath: path.join(
          __dirname,
          "src-tauri/target/debug/promptworkspace-desktop",
        ),
        driverProvider: "embedded",
        webdriverPort: 4445,
      },
    ],
  ],
};
