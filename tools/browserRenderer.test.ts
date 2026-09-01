import assert from "node:assert/strict";
import test from "node:test";
import type { Browser } from "playwright";
import {
  isBlockedTarget,
  renderWithOxylabsHeadless,
  sanitizeOxylabsConnectionError,
} from "./browserRenderer.js";

const OXYLABS_ENV_NAMES = [
  "OXYLABS_HEADLESS_USERNAME",
  "OXYLABS_HEADLESS_PASSWORD",
  "OXYLABS_HEADLESS_ENDPOINT",
  "OXYLABS_USERNAME",
  "OXYLABS_PASSWORD",
  "OXYLABS_KEY",
] as const;

async function withOxylabsEnv(
  values: Partial<Record<(typeof OXYLABS_ENV_NAMES)[number], string>>,
  fn: () => Promise<void>,
): Promise<void> {
  const original = Object.fromEntries(OXYLABS_ENV_NAMES.map((name) => [name, process.env[name]]));
  for (const name of OXYLABS_ENV_NAMES) delete process.env[name];
  Object.assign(process.env, values);
  try {
    await fn();
  } finally {
    for (const name of OXYLABS_ENV_NAMES) {
      const prior = original[name];
      if (prior === undefined) delete process.env[name];
      else process.env[name] = prior;
    }
  }
}

test("public-target guard rejects credentialed, local, private, and non-http URLs", () => {
  const rejected = [
    "file:///etc/passwd",
    "https://user:pass@example.com/zoning",
    "http://localhost:3000",
    "http://127.0.0.1/admin",
    "http://10.0.0.1/",
    "http://172.16.0.1/",
    "http://192.168.1.1/",
    "http://169.254.169.254/latest/meta-data",
    "http://[::1]/",
    "https://service.internal/zoning",
  ];
  for (const url of rejected) assert.equal(isBlockedTarget(url), true, url);
  assert.equal(isBlockedTarget("https://example.com/zoning"), false);
});

test("Oxylabs connection errors are categorized without echoing secrets", () => {
  const secretBearing = new Error("WebSocket 401 at wss://user:very-secret@ubc.oxylabs.io/");
  const sanitized = sanitizeOxylabsConnectionError(secretBearing);
  assert.equal(sanitized.message, "Oxylabs Headless Browser authentication was rejected (401)");
  assert.doesNotMatch(sanitized.message, /user|very-secret|wss:\/\//i);
});

test("Oxylabs renderer encodes credentials, returns page evidence, and closes the session", { concurrency: false }, async () => {
  await withOxylabsEnv({
    OXYLABS_HEADLESS_USERNAME: "headless-user",
    OXYLABS_HEADLESS_PASSWORD: "p@ss:/?word+",
    OXYLABS_HEADLESS_ENDPOINT: "wss://ubc.oxylabs.io",
  }, async () => {
    let connectedUrl = "";
    let pageClosed = false;
    let browserClosed = false;
    const browser = {
      newPage: async () => ({
        route: async () => undefined,
        goto: async () => ({ status: () => 200 }),
        waitForLoadState: async () => undefined,
        content: async () => "<html><body>Zoning ordinance evidence</body></html>",
        title: async () => "Official Zoning",
        url: () => "https://example.com/zoning/final",
        close: async () => { pageClosed = true; },
      }),
      close: async () => { browserClosed = true; },
    } as unknown as Browser;

    const result = await renderWithOxylabsHeadless(
      "https://example.com/zoning",
      async (endpointUrl, options) => {
        connectedUrl = endpointUrl;
        assert.equal(options?.timeout, 20_000);
        return browser;
      },
    );

    const endpoint = new URL(connectedUrl);
    assert.equal(endpoint.protocol, "wss:");
    assert.equal(endpoint.hostname, "ubc.oxylabs.io");
    assert.equal(endpoint.username, "headless-user");
    assert.equal(endpoint.password, "p%40ss%3A%2F%3Fword+");
    assert.deepEqual(result, {
      html: "<html><body>Zoning ordinance evidence</body></html>",
      title: "Official Zoning",
      finalUrl: "https://example.com/zoning/final",
      statusCode: 200,
    });
    assert.equal(pageClosed, true);
    assert.equal(browserClosed, true);
  });
});

test("invalid targets and missing credentials fail before opening a browser", { concurrency: false }, async () => {
  await withOxylabsEnv({}, async () => {
    let connectionAttempts = 0;
    const connector = async () => {
      connectionAttempts += 1;
      throw new Error("must not be called");
    };
    await assert.rejects(
      renderWithOxylabsHeadless("http://127.0.0.1", connector),
      /refused a non-public/i,
    );
    await assert.rejects(
      renderWithOxylabsHeadless("https://example.com", connector),
      /credentials are not configured on Railway/i,
    );
    assert.equal(connectionAttempts, 0);
  });
});
