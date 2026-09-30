// Playwright runs against `yard dev` on its default port. Start it yourself
// (`yard dev --reset-db --reset-rooms` from the repository root) or let
// the webServer entry below start it. globalSetup empties the local database
// and rooms either way, so every run starts from nothing.
import { defineConfig } from "@playwright/test";

const proxy = process.env.HTTPS_PROXY;

export default defineConfig({
  testDir: ".",
  testMatch: /.*\.spec\.mjs$/,
  timeout: 60_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  globalSetup: "./global-setup.mjs",
  use: {
    baseURL: "http://localhost:9875/keyring/",
    // Behind a TLS-inspecting proxy (a CI sandbox, say) the font requests
    // need these; on a laptop they change nothing.
    ignoreHTTPSErrors: true,
    launchOptions: proxy ? { args: [`--proxy-server=${proxy}`, "--proxy-bypass-list=localhost;127.0.0.1"] } : {},
    viewport: { width: 1280, height: 860 },
    trace: "retain-on-failure",
  },
  webServer: {
    command: "yard dev --reset-db --reset-rooms",
    cwd: "..",
    url: "http://localhost:9875/keyring/",
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
