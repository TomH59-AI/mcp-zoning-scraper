"""Stateless ordinance retrieval. Only Base44 writes ZoningWorkbookReference."""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import io
import ipaddress
import os
import re
import socket
import time
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urljoin, urlsplit

from fastapi import FastAPI, Header, HTTPException
import httpx
from playwright.async_api import Browser, async_playwright
from pypdf import PdfReader
from pydantic import BaseModel, ConfigDict, Field, field_validator

PUBLISHERS = ("municode.com", "ecode360.com", "amlegal.com", "icccodesolutions.org", "elaws.us", "generalcode.com", "qcode.us", "codepublishing.com")
US_STATES = set("AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WI WV WY DC".split())
SOURCE_LIBRARIES = [
    {"name": "Municode", "url": "https://library.municode.com/", "role": "ordinance_directory"},
    {"name": "ICC / General Code / eCode360", "url": "https://www.icccodesolutions.org/library/", "role": "ordinance_directory", "aliases": ["https://www.generalcode.com/library/"]},
    {"name": "American Legal", "url": "https://codelibrary.amlegal.com/", "role": "ordinance_directory"},
    {"name": "eLaws", "url": "https://www.elaws.us/", "role": "ordinance_directory"},
    {"name": "QCode", "url": "https://qcode.us/", "role": "legacy_ordinance_host"},
    {"name": "Code Publishing", "url": "https://www.codepublishing.com/", "role": "legacy_ordinance_host"},
    {"name": "Zoneomics", "url": "https://www.zoneomics.com/", "role": "zoning_context_and_source_links"},
]
CONTAINERS = {
    "municode.com": ".chunk-content, #codesContent",
    "ecode360.com": "#code-content, .ecode-content, .law-content, #content, main",
    "amlegal.com": "#codecontent, .doc-body, .r-content, #main-content, main",
    "icccodesolutions.org": ".chapter-content, article, main",
    "elaws.us": ".law-content, #content, main",
    "generalcode.com": "#code-content, article, main, #content",
    "qcode.us": ".content, #content, #main-content, main, body",
    "codepublishing.com": "#codeContent, #content, .content, main, body",
}
TERMS = re.compile(r"\b(towers?|wireless|telecommunications?|antennas?|setbacks?)\b", re.I)
MAX_TEXT = 60_000
MAX_PDF_BYTES = 10_000_000
CACHE_TTL = 300
browser: Browser | None = None
slots = asyncio.Semaphore(2)
cache: dict[str, tuple[float, dict[str, Any]]] = {}
inflight: dict[str, asyncio.Task] = {}

# Use the same cleaned legal-text extraction for readiness and final output.
# American Legal's disclaimer/footer must never satisfy the hydration wait.
CONTENT_TEXT_JS = r"""selector => {
    const candidates = [...document.querySelectorAll(selector)].map(root => {
        const copy = root.cloneNode(true);
        copy.querySelectorAll('nav,header,footer,aside,script,style,noscript,[role="navigation"],.code-footer,.breadcrumb,.codenav__section-breadcrumb').forEach(e => e.remove());
        return (copy.innerText || copy.textContent || '').trim();
    }).filter(t => t.length >= 500 && /\b(towers?|wireless|telecommunications?|antennas?|setbacks?)\b/i.test(t));
    return candidates.sort((a,b) => b.length-a.length)[0] || '';
}"""


def source_payload(text: str, url: str, title: str, *, partial: bool = False) -> dict[str, Any]:
    text = re.sub(r"[ \t]+", " ", text).strip()
    if len(text) < 500 or not TERMS.search(text):
        raise HTTPException(422, "No substantive telecommunications ordinance text was retrieved")
    truncated = partial or len(text) > MAX_TEXT
    if len(text) > MAX_TEXT:
        lines = text.splitlines()
        indices = {i for n, line in enumerate(lines) if TERMS.search(line)
                   for i in range(max(0, n - 2), min(len(lines), n + 12))}
        text = "\n".join(lines[i] for i in sorted(indices))[:MAX_TEXT]
    if len(text) < 500:
        raise HTTPException(422, "No substantive telecommunications ordinance text was retrieved")
    return {"status": "success", "final_url": url, "page_title": title,
            "raw_ordinance_text": text, "text_sha256": hashlib.sha256(text.encode()).hexdigest(),
            "retrieved_at": datetime.now(timezone.utc).isoformat(),
            "truncated": truncated, "scope": "retrieved_page_only", "complete_code": False}


def pdf_text(data: bytes) -> tuple[str, str, bool, int, int]:
    if not data.startswith(b"%PDF-") or len(data) > MAX_PDF_BYTES:
        raise HTTPException(422, "Unsupported or oversized PDF source")
    reader = PdfReader(io.BytesIO(data), strict=False)
    if reader.is_encrypted:
        raise HTTPException(422, "Encrypted ordinance PDF requires a readable public source")
    page_count = len(reader.pages)
    parts: list[str] = []
    decoded_bytes = 0
    deadline = time.monotonic() + 25
    processed = 0
    for page in reader.pages[:600]:
        if time.monotonic() > deadline:
            break
        contents = page.get_contents()
        page_bytes = len(contents.get_data()) if contents is not None else 0
        decoded_bytes += page_bytes
        if page_bytes > 4_000_000 or decoded_bytes > 30_000_000:
            break
        parts.append((page.extract_text(extraction_mode="layout") or "") if contents is not None else "")
        processed += 1
    text = "\n".join(parts).strip()
    title = str(reader.metadata.title or "Official ordinance PDF") if reader.metadata else "Official ordinance PDF"
    return text, title, processed < page_count, page_count, processed


async def retrieve_pdf(target_url: str, host: str) -> dict[str, Any] | None:
    # Explicit PDFs and government document-download endpoints cannot render
    # as an HTML ordinance container. Retrieve their actual text instead.
    current = target_url
    async with httpx.AsyncClient(timeout=25, follow_redirects=False) as client:
        for _ in range(5):
            validate_url(current, document_host=host)
            await public_dns(host)
            async with client.stream("GET", current) as response:
                if response.status_code in (301, 302, 303, 307, 308):
                    current = urljoin(current, response.headers.get("location", ""))
                    continue
                if response.status_code >= 400:
                    raise HTTPException(502, f"Source returned HTTP {response.status_code}")
                mime = response.headers.get("content-type", "").lower()
                if "pdf" not in mime and not urlsplit(current).path.lower().endswith(".pdf"):
                    return None
                data = bytearray()
                async for chunk in response.aiter_bytes():
                    data.extend(chunk)
                    if len(data) > MAX_PDF_BYTES:
                        raise HTTPException(422, "Ordinance PDF exceeds the bounded retrieval size")
            text, title, partial, page_count, processed = await asyncio.to_thread(pdf_text, bytes(data))
            return {**source_payload(text, current, title, partial=partial), "source_format": "pdf",
                    "document_page_count": page_count, "processed_pages": processed}
    raise HTTPException(422, "Too many document redirects")


def host_matches(host: str, suffix: str) -> bool:
    return host == suffix or host.endswith("." + suffix)


def validate_url(url: str, *, assets: bool = False, document_host: str = "") -> str:
    """Reject credentials, unsafe schemes/ports, private targets and host spoofing."""
    parsed = urlsplit(url)
    host = (parsed.hostname or "").lower().rstrip(".")
    try:
        valid_port = parsed.port in (None, 443)
    except ValueError:
        valid_port = False
    if parsed.scheme != "https" or not host or not valid_port or parsed.username or parsed.password:
        raise ValueError("A public HTTPS ordinance URL is required")
    try:
        ipaddress.ip_address(host)
        raise ValueError("IP address URLs are not allowed")
    except ValueError as exc:
        if str(exc) == "IP address URLs are not allowed":
            raise
    if host == "localhost" or host.endswith((".local", ".internal", ".localhost")):
        raise ValueError("Private targets are not allowed")
    official = host.endswith(".gov") or any(host_matches(host, p) for p in PUBLISHERS)
    extra = [s.strip().lower() for s in os.getenv("OFFICIAL_EXTRA_HOSTS", "").split(",") if s.strip()]
    official = official or any(host_matches(host, p) for p in extra)
    if not assets and not official:
        raise ValueError("Host must be an approved code publisher or government site")
    # Main-document redirects stay on the original host. Publishers' static
    # CDN assets may use other public HTTPS hosts, but never local addresses.
    if document_host and host != document_host:
        raise ValueError("Cross-host document redirect requires a separately approved source URL")
    return host


async def public_dns(host: str) -> None:
    results = await asyncio.wait_for(
        asyncio.get_running_loop().getaddrinfo(host, 443, type=socket.SOCK_STREAM), 5
    )
    if not results or any(not ipaddress.ip_address(r[4][0]).is_global for r in results):
        raise ValueError("Target does not resolve exclusively to public addresses")


class ScrapeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    municipality: str = Field(min_length=1, max_length=180)
    state: str = Field(pattern=r"^[A-Z]{2}$")
    target_url: str = Field(min_length=10, max_length=2048)

    @field_validator("state")
    @classmethod
    def supported_state(cls, value: str) -> str:
        if value not in US_STATES:
            raise ValueError("Only U.S. states and DC are in this zoning workflow")
        return value


@asynccontextmanager
async def lifespan(app: FastAPI):
    global browser
    secret = os.getenv("SITEHAWK_API_KEY", "")
    if len(secret) < 32:
        raise RuntimeError("SITEHAWK_API_KEY must be configured with at least 32 characters")
    async with async_playwright() as engine:
        browser = await engine.chromium.launch(headless=True, args=["--no-sandbox", "--disable-dev-shm-usage"])
        try:
            yield
        finally:
            for task in list(inflight.values()):
                task.cancel()
            await browser.close()
            browser = None


app = FastAPI(title="SiteHawk Ordinance Retrieval", lifespan=lifespan, docs_url=None, redoc_url=None)


@app.get("/")
@app.get("/health")
async def health() -> dict[str, str]:
    if browser is None or not browser.is_connected():
        raise HTTPException(503, "Browser is unavailable")
    return {"status": "online", "service": "sitehawk-playwright-worker", "version": "1.2.0"}


@app.get("/sources")
async def sources() -> dict[str, Any]:
    return {"source_of_truth": "Base44.ZoningWorkbookReference", "states": sorted(US_STATES),
            "libraries": SOURCE_LIBRARIES, "retrieval_requires": "an exact jurisdiction ordinance URL"}


async def retrieve(target_url: str) -> dict[str, Any]:
    host = validate_url(target_url)
    await public_dns(host)
    if re.search(r"\.pdf(?:$|[?#])|/(?:DocumentCenter|AgendaCenter)/|/ViewFile/", target_url, re.I):
        async with slots:
            pdf = await retrieve_pdf(target_url, host)
        if pdf is not None:
            return pdf
    if browser is None:
        raise HTTPException(503, "Browser is unavailable")
    async with slots:
        context = await browser.new_context(service_workers="block", accept_downloads=False)
        blocked_document = False
        dns_checked: set[str] = set()

        async def guard(route):
            nonlocal blocked_document
            request = route.request
            try:
                is_document = request.resource_type == "document"
                h = validate_url(request.url, assets=not is_document, document_host=host if is_document else "")
                if h not in dns_checked:
                    await public_dns(h)
                    dns_checked.add(h)
                if request.resource_type in {"image", "media", "font"}:
                    await route.abort()
                else:
                    await route.continue_()
            except (ValueError, OSError, TimeoutError):
                if request.resource_type == "document":
                    blocked_document = True
                await route.abort()

        await context.route("**/*", guard)
        page = await context.new_page()
        page.set_default_timeout(15_000)
        try:
            response = await page.goto(target_url, wait_until="domcontentloaded", timeout=30_000)
            if blocked_document:
                raise HTTPException(422, "Document redirect was blocked; use the official final URL")
            if response and response.status >= 400:
                raise HTTPException(502, f"Source returned HTTP {response.status}")
            selector = next((s for p, s in CONTAINERS.items() if host_matches(host, p)), "article, main, #content")
            # Wait for substantive legal text, never merely a sidebar or body.
            await page.wait_for_function(
                "selector => (" + CONTENT_TEXT_JS + ")(selector).length >= 500",
                arg=selector, timeout=20_000,
            )
            await page.wait_for_timeout(1200)
            # Expand only explicit in-document disclosure buttons. Do not
            # change the source to a search-results page or navigate chapters.
            await page.evaluate("""selector => {
                for (const root of document.querySelectorAll(selector)) {
                    for (const d of root.querySelectorAll('details')) d.open = true;
                }
            }""", selector)
            text = await page.evaluate(CONTENT_TEXT_JS, selector)
            final_url, title = page.url, await page.title()
            validate_url(final_url, document_host=host)
            return source_payload(text, final_url, title)
        finally:
            await context.close()


async def bounded_retrieve(url: str) -> dict[str, Any]:
    try:
        async with asyncio.timeout(65):
            result = await retrieve(url)
        if len(cache) >= 64:
            cache.pop(next(iter(cache)))
        cache[url] = (time.monotonic(), result)
        return result
    finally:
        inflight.pop(url, None)


@app.post("/scrape-municipality")
async def scrape_municipality(req: ScrapeRequest, x_api_key: str | None = Header(default=None)) -> dict[str, Any]:
    expected = os.getenv("SITEHAWK_API_KEY", "")
    if not expected or not hmac.compare_digest((x_api_key or "").encode(), expected.encode()):
        raise HTTPException(401, "Invalid API key")
    try:
        validate_url(req.target_url)
        cached = cache.get(req.target_url)
        if cached and time.monotonic() - cached[0] < CACHE_TTL:
            result = cached[1]
        else:
            if req.target_url not in inflight:
                if len(inflight) >= 8:
                    raise HTTPException(429, "Worker is busy; retry later")
                inflight[req.target_url] = asyncio.create_task(bounded_retrieve(req.target_url))
            result = await asyncio.shield(inflight[req.target_url])
        return {**result, "municipality": req.municipality, "state": req.state}
    except HTTPException:
        raise
    except ValueError:
        raise HTTPException(422, "Unsupported source URL") from None
    except TimeoutError:
        raise HTTPException(504, "Ordinance retrieval timed out") from None
    except Exception:
        raise HTTPException(502, "Source retrieval failed; no zoning values were changed") from None
