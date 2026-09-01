import { isIP } from "node:net";
import { chromium, type Browser } from "playwright";

export type BrowserRuntimeState = "disabled" | "not_started" | "starting" | "ready" | "error";

export interface BrowserRuntimeStatus {
  enabled: boolean;
  state: BrowserRuntimeState;
  engine: "playwright-chromium";
  transport: "local";
  error?: string;
}

export interface OxylabsHeadlessRuntimeStatus {
  configured: boolean;
  engine: "playwright-chromium";
  transport: "oxylabs-cdp";
  endpoint: "ubc.oxylabs.io";
}

export interface BrowserRenderResult {
  html: string;
  title: string;
  finalUrl: string;
  statusCode: number | null;
  links: Array<{ url: string; title: string }>;
}

export type CdpConnector = (
  endpointUrl: string,
  options?: { timeout?: number },
) => Promise<Browser>;

const enabled = !/^(0|false|off|no)$/i.test(process.env.PLAYWRIGHT_ENABLED?.trim() || "true");
let browserPromise: Promise<Browser> | null = null;
let state: BrowserRuntimeState = enabled ? "not_started" : "disabled";
let lastError: string | undefined;

function isPrivateIpv4(hostname: string): boolean {
  const octets = hostname.split(".").map(Number);
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return false;
  const [a, b] = octets;
  return a === 10
    || a === 127
    || a === 0
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127);
}

function isPrivateIpv6(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "::"
    || normalized === "::1"
    || normalized.startsWith("::ffff:")
    || normalized.startsWith("fc")
    || normalized.startsWith("fd")
    || /^fe[89ab]/.test(normalized)
    || normalized.startsWith("ff");
}

export function isBlockedTarget(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return true;
  }
  if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) return true;
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".internal")) return true;
  const ipVersion = isIP(hostname);
  return (ipVersion === 4 && isPrivateIpv4(hostname)) || (ipVersion === 6 && isPrivateIpv6(hostname));
}

function optionalEnv(...names: string[]): string | null {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return null;
}

function oxylabsCredentials(): { username: string; password: string } {
  const username = optionalEnv("OXYLABS_HEADLESS_USERNAME", "OXYLABS_USERNAME");
  const password = optionalEnv("OXYLABS_HEADLESS_PASSWORD", "OXYLABS_PASSWORD", "OXYLABS_KEY");
  if (!username || !password) {
    throw new Error("Oxylabs Headless Browser credentials are not configured on Railway");
  }
  return { username, password };
}

function authenticatedOxylabsEndpoint(username: string, password: string): string {
  const configured = optionalEnv("OXYLABS_HEADLESS_ENDPOINT") || "wss://ubc.oxylabs.io";
  const raw = /^wss:\/\//i.test(configured) ? configured : `wss://${configured}`;
  let endpoint: URL;
  try {
    endpoint = new URL(raw);
  } catch {
    throw new Error("OXYLABS_HEADLESS_ENDPOINT is not a valid WSS endpoint");
  }
  if (
    endpoint.protocol !== "wss:"
    || endpoint.hostname.toLowerCase() !== "ubc.oxylabs.io"
    || endpoint.port
    || endpoint.pathname !== "/"
    || endpoint.search
    || endpoint.hash
  ) {
    throw new Error("OXYLABS_HEADLESS_ENDPOINT must be wss://ubc.oxylabs.io");
  }
  endpoint.username = username;
  endpoint.password = password;
  return endpoint.toString();
}

export function sanitizeOxylabsConnectionError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (/timed?\s*out|timeout/i.test(message)) {
    return new Error("Oxylabs Headless Browser connection timed out");
  }
  if (/\b401\b|unauthori[sz]ed/i.test(message)) {
    return new Error("Oxylabs Headless Browser authentication was rejected (401)");
  }
  if (/\b403\b|forbidden/i.test(message)) {
    return new Error("Oxylabs Headless Browser access was rejected (403)");
  }
  return new Error("Oxylabs Headless Browser connection failed");
}

async function getBrowser(): Promise<Browser> {
  if (!enabled) throw new Error("Playwright renderer is disabled by PLAYWRIGHT_ENABLED");
  if (browserPromise) return browserPromise;

  state = "starting";
  lastError = undefined;
  browserPromise = chromium.launch({
    headless: true,
    args: ["--disable-dev-shm-usage", "--no-sandbox", "--disable-setuid-sandbox"],
  }).then((browser) => {
    state = "ready";
    browser.on("disconnected", () => {
      browserPromise = null;
      state = "not_started";
    });
    return browser;
  }).catch((error: unknown) => {
    browserPromise = null;
    state = "error";
    lastError = error instanceof Error ? error.message : String(error);
    throw error;
  });

  return browserPromise;
}

export function getBrowserRuntimeStatus(): BrowserRuntimeStatus {
  return {
    enabled,
    state,
    engine: "playwright-chromium",
    transport: "local",
    ...(lastError ? { error: lastError } : {}),
  };
}

export function getOxylabsHeadlessRuntimeStatus(): OxylabsHeadlessRuntimeStatus {
  return {
    configured: Boolean(
      optionalEnv("OXYLABS_HEADLESS_USERNAME", "OXYLABS_USERNAME")
      && optionalEnv("OXYLABS_HEADLESS_PASSWORD", "OXYLABS_PASSWORD", "OXYLABS_KEY"),
    ),
    engine: "playwright-chromium",
    transport: "oxylabs-cdp",
    endpoint: "ubc.oxylabs.io",
  };
}

export async function warmBrowserRenderer(): Promise<void> {
  if (!enabled) return;
  await getBrowser();
}

export async function renderWithPlaywright(url: string): Promise<string> {
  if (isBlockedTarget(url)) throw new Error("Playwright refused a non-public or invalid HTTP target");

  const browser = await getBrowser();
  const context = await browser.newContext({
    ignoreHTTPSErrors: false,
    javaScriptEnabled: true,
    locale: "en-US",
    serviceWorkers: "block",
    userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0 Safari/537.36 SiteHawk-ZoningScraper/2.4",
  });

  try {
    const page = await context.newPage();
    await page.route("**/*", async (route) => {
      const request = route.request();
      if (isBlockedTarget(request.url())) {
        await route.abort("blockedbyclient");
        return;
      }
      if (["image", "media", "font"].includes(request.resourceType())) {
        await route.abort("blockedbyclient");
        return;
      }
      await route.continue();
    });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
    return await page.content();
  } finally {
    await context.close();
  }
}

export async function renderWithOxylabsHeadless(
  url: string,
  connectOverCDP: CdpConnector = (endpointUrl, options) => chromium.connectOverCDP(endpointUrl, options),
): Promise<BrowserRenderResult> {
  if (isBlockedTarget(url)) {
    throw new Error("Oxylabs Headless Browser refused a non-public or invalid HTTP target");
  }

  const { username, password } = oxylabsCredentials();
  const endpointUrl = authenticatedOxylabsEndpoint(username, password);
  let browser: Browser;
  try {
    browser = await connectOverCDP(endpointUrl, { timeout: 20_000 });
  } catch (error) {
    throw sanitizeOxylabsConnectionError(error);
  }

  try {
    const page = await browser.newPage({
      ignoreHTTPSErrors: false,
      javaScriptEnabled: true,
      locale: "en-US",
      serviceWorkers: "block",
    });
    try {
      await page.route("**/*", async (route) => {
        const request = route.request();
        if (isBlockedTarget(request.url())) {
          await route.abort("blockedbyclient");
          return;
        }
        if (["image", "media", "font"].includes(request.resourceType())) {
          await route.abort("blockedbyclient");
          return;
        }
        await route.continue();
      });
      const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
      await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
      const rawLinks = await page.locator("a[href]").evaluateAll((anchors) => anchors.slice(0, 200).map((anchor) => ({
        url: (anchor as HTMLAnchorElement).href,
        title: (anchor.textContent || "").replace(/\s+/g, " ").trim(),
      })));
      const seenLinks = new Set<string>();
      const links = rawLinks.filter((link) => {
        if (!/^https?:\/\//i.test(link.url) || seenLinks.has(link.url)) return false;
        seenLinks.add(link.url);
        return true;
      }).slice(0, 100);
      return {
        html: await page.content(),
        title: await page.title(),
        finalUrl: page.url(),
        statusCode: response?.status() ?? null,
        links,
      };
    } finally {
      await page.close().catch(() => undefined);
    }
  } finally {
    await browser.close().catch(() => undefined);
  }
}
