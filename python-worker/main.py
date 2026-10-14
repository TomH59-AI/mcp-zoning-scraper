"""Stateless ordinance retrieval. Only Base44 writes ZoningWorkbookReference."""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import io
import ipaddress
import json
import os
import re
import socket
import time
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable
from urllib.parse import parse_qs, quote_plus, urljoin, urlsplit

from fastapi import FastAPI, Header, HTTPException
import httpx
from playwright.async_api import Browser, TimeoutError as PlaywrightTimeoutError, async_playwright
from pypdf import PdfReader
from pydantic import BaseModel, ConfigDict, Field, field_validator

PUBLISHERS = ("municode.com", "ecode360.com", "amlegal.com", "icccodesolutions.org", "elaws.us", "generalcode.com", "qcode.us", "codepublishing.com")
GOV_DOCUMENT_PREFIXES = ('https://s3.us-east-2.amazonaws.com/assets.birminghamal.gov/',)
US_STATES = set("AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WI WV WY DC".split())
STATE_NAMES = dict(pair.split('|') for pair in 'AL|Alabama;AK|Alaska;AZ|Arizona;AR|Arkansas;CA|California;CO|Colorado;CT|Connecticut;DE|Delaware;FL|Florida;GA|Georgia;HI|Hawaii;ID|Idaho;IL|Illinois;IN|Indiana;IA|Iowa;KS|Kansas;KY|Kentucky;LA|Louisiana;ME|Maine;MD|Maryland;MA|Massachusetts;MI|Michigan;MN|Minnesota;MS|Mississippi;MO|Missouri;MT|Montana;NE|Nebraska;NV|Nevada;NH|New Hampshire;NJ|New Jersey;NM|New Mexico;NY|New York;NC|North Carolina;ND|North Dakota;OH|Ohio;OK|Oklahoma;OR|Oregon;PA|Pennsylvania;RI|Rhode Island;SC|South Carolina;SD|South Dakota;TN|Tennessee;TX|Texas;UT|Utah;VT|Vermont;VA|Virginia;WA|Washington;WV|West Virginia;WI|Wisconsin;WY|Wyoming;DC|District of Columbia'.split(';'))
WORKER_VERSION = '1.4.0'
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
MAX_PDF_BYTES = 20_000_000
CACHE_TTL = 300
browser: Browser | None = None
slots = asyncio.Semaphore(2)
cache: dict[str, tuple[float, dict[str, Any]]] = {}
inflight: dict[str, asyncio.Task] = {}
research_cache: dict[str, tuple[float, dict[str, Any]]] = {}
research_inflight: dict[str, asyncio.Task] = {}

# Use the same cleaned legal-text extraction for readiness and final output.
# American Legal's disclaimer/footer must never satisfy the hydration wait.
CONTENT_TEXT_JS = r"""({selector, authorityPage}) => {
    const candidates = [...document.querySelectorAll(selector)].map(root => {
        const copy = root.cloneNode(true);
        copy.querySelectorAll('nav,header,footer,aside,script,style,noscript,[role="navigation"],.code-footer,.breadcrumb,.codenav__section-breadcrumb').forEach(e => e.remove());
        return (copy.innerText || copy.textContent || '').trim();
    }).filter(t => t.length >= 500 && (/\b(towers?|wireless|telecommunications?|antennas?|setbacks?)\b/i.test(t) || (authorityPage && /zoning|planning|building permits?|land development|ordinances?/i.test(t))));
    return candidates.sort((a,b) => b.length-a.length)[0] || '';
}"""


def source_payload(text: str, url: str, title: str, *, partial: bool = False, authority_page: bool = False) -> dict[str, Any]:
    text = re.sub(r"[ \t]+", " ", text).strip()
    if len(text) < 500 or not (TERMS.search(text) or authority_page and re.search(r'zoning|planning|building permits?|land development|ordinances?', text, re.I)):
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


def relevant_source_links(links: list[dict[str, str]], page_url: str) -> list[dict[str, str]]:
    """Bounded research leads, not legal claims or a second source of truth."""
    found: dict[str, dict[str, str]] = {}
    page_host = urlsplit(page_url).hostname
    for link in links:
        target = urljoin(page_url, link.get('href', ''))
        label = re.sub(r'\s+', ' ', link.get('text', '')).strip()[:200]
        embedded = parse_qs(urlsplit(target).query).get('document', [''])[0]
        if any(embedded.startswith(prefix) for prefix in GOV_DOCUMENT_PREFIXES) and (page_host or '').removeprefix('www.') == 'birminghamal.gov':
            target = embedded
        if not target or target == page_url or re.search(r'maps?|\bgis\b|arcgis|facebook|twitter|youtube', target + ' ' + label, re.I):
            continue
        if not re.search(r'tower|wireless|telecom|antenna|(?:zoning|development|municipal|land.use).{0,30}(?:code|ordinance|regulation)|(?:code|ordinance|regulation).{0,30}(?:zoning|development)|\.pdf(?:$|[?#])', target + ' ' + label, re.I):
            continue
        try:
            host = validate_url(target)
        except ValueError:
            continue
        if host != page_host and not any(host_matches(host, p) for p in PUBLISHERS) and not ((page_host or '').removeprefix('www.') == 'birminghamal.gov' and any(target.startswith(prefix) for prefix in GOV_DOCUMENT_PREFIXES)):
            continue
        score = 0 if re.search(r'tower|wireless|telecom|antenna', target + ' ' + label, re.I) else 1
        found.setdefault(target, {'url': target, 'label': label, 'parent_url': page_url, 'priority': score})
    return sorted(found.values(), key=lambda x: (x['priority'], x['url']))[:12]


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
    official = host.endswith(".gov") or any(host_matches(host, p) for p in PUBLISHERS) or any(url.startswith(prefix) for prefix in GOV_DOCUMENT_PREFIXES)
    extra = [s.strip().lower() for s in os.getenv("OFFICIAL_EXTRA_HOSTS", "").split(",") if s.strip()]
    official = official or any(host_matches(host, p) for p in extra)
    if not assets and not official:
        raise ValueError("Host must be an approved code publisher or government site")
    # Main-document redirects stay on the original host. Publishers' static
    # CDN assets may use other public HTTPS hosts, but never local addresses.
    if document_host and host.removeprefix('www.') != document_host.removeprefix('www.'):
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
    search_query: str = Field(default='wireless telecommunications facilities communication tower monopole setback height fall zone collocation stealth', max_length=500)
    run_secondary_recon: bool = True

    @field_validator("state")
    @classmethod
    def supported_state(cls, value: str) -> str:
        if value not in US_STATES:
            raise ValueError("Only U.S. states and DC are in this zoning workflow")
        return value


class HarvestStateRequest(BaseModel):
    model_config = ConfigDict(extra='forbid', str_strip_whitespace=True)
    state_abbr: str = Field(default='FL', pattern=r'^[A-Z]{2}$')
    state_name: str | None = Field(default=None, max_length=64)
    platforms: list[str] = Field(default_factory=lambda: ['municode', 'amlegal', 'elaws', 'generalcode', 'icc', 'zoneomics', 'qcode', 'codepub'], min_length=1, max_length=8)
    exclude_counties: bool = True

    @field_validator('state_abbr')
    @classmethod
    def supported_state(cls, value: str) -> str:
        if value not in STATE_NAMES:
            raise ValueError('Only the 50 U.S. states and DC are supported')
        return value

    @field_validator('platforms')
    @classmethod
    def supported_platforms(cls, value: list[str]) -> list[str]:
        if any(p not in {'municode', 'amlegal', 'elaws', 'generalcode', 'icc', 'zoneomics', 'qcode', 'codepub'} for p in value):
            raise ValueError('Unknown source platform')
        return list(dict.fromkeys(value))


def authenticate(x_api_key: str | None) -> None:
    expected = os.getenv('SITEHAWK_API_KEY', '')
    if not expected or not hmac.compare_digest((x_api_key or '').encode(), expected.encode()):
        raise HTTPException(401, 'Invalid API key')


async def research_page(url: str, *, search: bool = False, context_directory: bool = False, state_name: str | None = None) -> dict[str, Any]:
    """Read bounded public research pages. Returned links are leads, never laws."""
    host = validate_url(url, assets=search or context_directory)
    if search and host != 'html.duckduckgo.com':
        raise ValueError('Search must use the configured public search host')
    if context_directory and host not in {'www.zoneomics.com', 'zoneomics.com'}:
        raise ValueError('Context discovery must use the configured directory')
    await public_dns(host)
    if browser is None:
        raise HTTPException(503, 'Browser is unavailable')
    async with slots:
        context = await browser.new_context(service_workers='block', accept_downloads=False)
        page = await context.new_page()
        checked = set()
        async def guard(route):
            try:
                request = route.request
                is_doc = request.resource_type == 'document'
                if is_doc and request.frame != page.main_frame:
                    await route.abort(); return
                h = validate_url(request.url, assets=not is_doc or search or context_directory,
                                 document_host=host if is_doc else '')
                if h not in checked:
                    await public_dns(h); checked.add(h)
                if request.resource_type in {'image', 'media', 'font'}:
                    await route.abort()
                else:
                    await route.continue_()
            except (ValueError, OSError, TimeoutError, asyncio.TimeoutError):
                await route.abort()
        await context.route('**/*', guard)
        try:
            response = await page.goto(url, wait_until='domcontentloaded', timeout=12_000)
            if response and response.status >= 400:
                raise HTTPException(502, f'Source returned HTTP {response.status}')
            validate_url(page.url, assets=search or context_directory, document_host=host)
            await page.wait_for_timeout(1500)
            selected = False
            if state_name:
                selects = page.locator('select')
                for i in range(min(await selects.count(), 4)):
                    select = selects.nth(i)
                    try:
                        if await select.is_visible():
                            await select.select_option(label=state_name, timeout=2000)
                            selected = True; break
                    except PlaywrightTimeoutError:
                        pass
                if not selected:
                    link = page.get_by_role('link', name=state_name, exact=True)
                    if await link.count() == 1 and await link.is_visible():
                        await link.click(timeout=3000); selected = True
                if selected:
                    await page.wait_for_timeout(1500)
            links = {}
            for _ in range(5 if state_name or '/regions/' in url or 'library.municode.com' in url else 1):
                visible_links = await page.evaluate("""() => [...document.querySelectorAll('a[href]')].map(a=>({
                    name:(a.innerText||a.textContent||'').trim().replace(/\\s+/g,' '),url:a.href,
                    context:(a.closest('tr,li,section')?.innerText||'').slice(0,600)
                })).slice(0,2500)""")
                for link in visible_links:
                    links.setdefault((link['url'], link['name']), link)
                await page.evaluate('window.scrollBy(0,1200)')
                await page.wait_for_timeout(500)
            text = await page.evaluate("""() => {
                const copy = document.body.cloneNode(true);
                copy.querySelectorAll('script,style,nav,header,footer,aside,noscript,[role="navigation"]').forEach(e=>e.remove());
                return (copy.innerText || copy.textContent || '').trim().slice(0,18000);
            }""")
            return {'url': page.url, 'title': await page.title(), 'text': text,
                    'links': list(links.values()), 'state_filter_selected': selected}
        finally:
            await context.close()


def department_role(label: str, url: str) -> str | None:
    text = (label + ' ' + url).lower()
    if re.search(r'\bgis\b|arcgis|zoning.?map|map.?portal', text):
        return 'gis'
    if re.search(r'building|permits?|inspections?', text):
        return 'building'
    if re.search(r'planning|zoning|community.?development|development.?services', text):
        return 'planning'
    return None


def recon_candidates(links: list[dict[str, str]]) -> list[dict[str, str]]:
    result = {}
    for link in links:
        url = link.get('url') or link.get('href') or ''
        if (urlsplit(url).hostname or '').endswith('duckduckgo.com'):
            url = parse_qs(urlsplit(url).query).get('uddg', [''])[0]
        label = link.get('name') or link.get('text') or ''
        role = department_role(label, url)
        if not role or len(url) > 2048 or re.search(r'login|sign.?in|facebook|twitter|youtube', url, re.I):
            continue
        try:
            host = validate_url(url)
        except ValueError:
            continue
        if not host.endswith('.gov'):
            continue
        result.setdefault(url, {'url': url, 'role': role, 'label': label[:200]})
    return sorted(result.values(), key=lambda item: (item['role'] == 'gis', item['url']))[:8]


async def municipal_recon(municipality: str, state: str, primary: dict[str, Any]) -> dict[str, Any]:
    payload = {'official_website': None, 'planning_dept_url': None, 'building_dept_url': None,
               'gis_portal_url': None, 'extracted_emails': [], 'extracted_phones': [],
               'contact_snippets': '', 'source_pages': [], 'research_only': True,
               'jurisdiction_verification_required': True, 'status': 'no_verified_department_pages'}
    leads = recon_candidates(primary.get('official_portal_links', []))
    if not leads:
        query = quote_plus(f'{municipality} {state} official planning zoning building department GIS contact')
        try:
            found = await research_page('https://html.duckduckgo.com/html/?q=' + query, search=True)
            leads = recon_candidates(found['links'])
        except (HTTPException, ValueError, OSError, TimeoutError, asyncio.TimeoutError, PlaywrightTimeoutError):
            payload['status'] = 'search_unavailable'
            return payload
    payload['source_leads'] = leads
    for lead in leads:
        if lead['role'] == 'gis':
            payload['gis_portal_url'] = lead['url']
            continue
        if len(payload['source_pages']) >= 2:
            break
        try:
            page = await research_page(lead['url'])
            if len(page['text']) < 500 or not re.search(r'planning|zoning|building|permit|development', page['text'], re.I):
                continue
            packet = source_payload(page['text'], page['url'], page['title'], authority_page=True)
            packet.update({'role': lead['role'], 'research_only': True})
            payload['source_pages'].append(packet)
            payload['official_website'] = payload['official_website'] or page['url']
            payload[lead['role'] + '_dept_url'] = page['url']
            payload['extracted_emails'] += re.findall(r'[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}', page['text'])
            payload['extracted_phones'] += re.findall(r'\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}', page['text'])
        except (HTTPException, ValueError, OSError, TimeoutError, asyncio.TimeoutError, PlaywrightTimeoutError):
            continue
    payload['extracted_emails'] = list(dict.fromkeys(payload['extracted_emails']))[:5]
    payload['extracted_phones'] = list(dict.fromkeys(payload['extracted_phones']))[:5]
    payload['contact_snippets'] = '\n'.join(p['raw_ordinance_text'][:5000] for p in payload['source_pages'])[:10000]
    if payload['source_pages']:
        payload['status'] = 'source_pages_retrieved'
    return payload


def clean_municipal_link(name: str, state: str, exclude_counties: bool) -> bool:
    if not 3 <= len(name) <= 80:
        return False
    if re.search(r'\b(login|sign in|register|contact|privacy|terms|help|support|about|home|pricing|blog|cookie|back to)\b', name, re.I):
        return False
    if exclude_counties and re.search(r'\b(county|parish|regional|water management|fire district|school district|authority|commission)\b', name, re.I):
        return False
    return not (exclude_counties and state == 'AK' and re.search(r'\bborough\b', name, re.I))


def harvest_candidates(page: dict[str, Any], state: str, platform: str, exclude_counties: bool, *, scoped: bool) -> list[dict[str, Any]]:
    result = {}
    for link in page['links']:
        name, url = link.get('name', ''), link.get('url', '')
        if not clean_municipal_link(name, state, exclude_counties):
            continue
        try:
            host = validate_url(url, assets=platform == 'zoneomics')
        except ValueError:
            continue
        is_code = (host_matches(host, 'municode.com') and re.search(r'/[a-z]{2}/[^/]+', urlsplit(url).path)) or (host_matches(host, 'amlegal.com') and '/codes/' in url) or (host_matches(host, 'ecode360.com') and re.search(r'/(?:[A-Z]{2}\d+|\d+)', urlsplit(url).path)) or (host_matches(host, 'elaws.us') and urlsplit(url).path != '/') or (host_matches(host, 'qcode.us') and '/codes/' in urlsplit(url).path and urlsplit(url).path.rstrip('/') != '/codes') or (host_matches(host, 'codepublishing.com') and re.search(r'/[A-Z]{2}/[^/]+', urlsplit(url).path)) or (platform == 'zoneomics' and host_matches(host, 'zoneomics.com') and re.search(r'/(?:city|zoning-maps)/[^/]+', urlsplit(url).path))
        if not is_code:
            continue
        path_state = re.search(r'/([A-Za-z]{2})/[^/]+', urlsplit(url).path)
        explicit_state = (host_matches(host, 'municode.com') or host_matches(host, 'codepublishing.com')) and path_state and path_state[1].upper() == state
        context_state = bool(re.search(r'\b' + re.escape(STATE_NAMES[state]) + r'\b', link.get('context', ''), re.I))
        if not (scoped or explicit_state or context_state):
            continue
        if (host_matches(host, 'municode.com') or host_matches(host, 'codepublishing.com')) and path_state and path_state[1].upper() != state:
            continue
        normalized = url.split('#')[0].rstrip('/')
        kind = 'township' if re.search(r'\btownship\b', name, re.I) else 'municipality'
        result.setdefault(normalized, {'municipality': name, 'state': state, 'jurisdiction_type': kind,
            'platform': platform, 'url': normalized, 'discovered_from': page['url'],
            'source_role': 'zoning_context' if platform == 'zoneomics' else 'ordinance',
            'research_only': True, 'identity_verification_required': True})
    return list(result.values())


async def harvest_state(req: HarvestStateRequest) -> dict[str, Any]:
    name = STATE_NAMES[req.state_abbr]
    if req.state_name and req.state_name.casefold() != name.casefold():
        raise HTTPException(422, 'State name and abbreviation disagree')
    abbr = req.state_abbr.lower()
    routes = {'municode': (f'https://library.municode.com/{abbr}', True),
              'amlegal': (f'https://codelibrary.amlegal.com/regions/{abbr}', True),
              'elaws': (f'https://{abbr}.elaws.us/', True),
              'generalcode': ('https://www.generalcode.com/library/', False),
              'icc': ('https://www.icccodesolutions.org/library/', False),
              'zoneomics': ('https://www.zoneomics.com/zoning-maps', False),
              'qcode': ('https://qcode.us/codes/', False),
              'codepub': ('https://www.generalcode.com/library/', False)}
    result = {'state': name, 'state_abbr': req.state_abbr, 'total_urls': 0, 'platforms': {},
              'research_only': True, 'new_master_records': 0, 'exclude_counties': req.exclude_counties}
    started = time.monotonic()
    for platform in req.platforms:
        if time.monotonic() - started > 120:
            result['platforms'][platform] = {'count': 0, 'municipalities': [], 'status': 'not_attempted_time_budget'}
            continue
        url, scoped = routes[platform]
        try:
            page = await asyncio.wait_for(research_page(url, state_name=None if scoped else name, context_directory=platform == 'zoneomics'), 25)
            candidates = harvest_candidates(page, req.state_abbr, platform, req.exclude_counties, scoped=scoped or page['state_filter_selected'])
            result['platforms'][platform] = {'count': len(candidates), 'municipalities': candidates,
                'status': 'research_candidates' if candidates else 'no_state_verified_links', 'source_url': page['url']}
        except (HTTPException, ValueError, OSError, TimeoutError, asyncio.TimeoutError, PlaywrightTimeoutError):
            result['platforms'][platform] = {'count': 0, 'municipalities': [], 'status': 'source_unavailable'}
    unique = {}
    for platform in result['platforms'].values():
        for candidate in platform['municipalities']:
            unique.setdefault(candidate['url'], candidate)
    result['municipalities'] = list(unique.values())
    result['total_urls'] = len(unique)
    result['complete_directory'] = False
    result['retrieved_at'] = datetime.now(timezone.utc).isoformat()
    return result


async def cached_research(key: str, factory: Callable[[], Awaitable[dict[str, Any]]], timeout: float) -> dict[str, Any]:
    prior = research_cache.get(key)
    if prior and time.monotonic() - prior[0] < CACHE_TTL:
        return prior[1]
    if key not in research_inflight:
        if len(research_inflight) >= 8:
            raise HTTPException(429, 'Worker is busy; retry later')
        async def run() -> dict[str, Any]:
            try:
                result = await asyncio.wait_for(factory(), timeout)
                if len(research_cache) >= 64:
                    research_cache.pop(next(iter(research_cache)))
                research_cache[key] = (time.monotonic(), result)
                return result
            finally:
                research_inflight.pop(key, None)
        research_inflight[key] = asyncio.create_task(run())
    return await asyncio.shield(research_inflight[key])


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
            for task in list(inflight.values()) + list(research_inflight.values()):
                task.cancel()
            await browser.close()
            browser = None


app = FastAPI(title="SiteHawk Ordinance Retrieval", lifespan=lifespan, docs_url=None, redoc_url=None)


@app.get("/")
@app.get("/health")
async def health() -> dict[str, str]:
    if browser is None or not browser.is_connected():
        raise HTTPException(503, "Browser is unavailable")
    return {"status": "online", "service": "HawkScraper Two-Pass Playwright Worker", "version": WORKER_VERSION}


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
                # Analytics and embedded-video frames are not a main-page
                # redirect. Block those frames without invalidating the source.
                if is_document and request.frame != page.main_frame:
                    await route.abort()
                    return
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
            selector = next((s for p, s in CONTAINERS.items() if host_matches(host, p)), "article, main, #content, body")
            settings = {"selector": selector, "authorityPage": host.endswith('.gov')}
            # Wait for substantive legal text, never merely a sidebar or body.
            await page.wait_for_function(
                "settings => (" + CONTENT_TEXT_JS + ")(settings).length >= 500",
                arg=settings, timeout=20_000,
            )
            await page.wait_for_timeout(1200)
            # Expand only explicit in-document disclosure buttons. Do not
            # change the source to a search-results page or navigate chapters.
            await page.evaluate("""selector => {
                for (const root of document.querySelectorAll(selector)) {
                    for (const d of root.querySelectorAll('details')) d.open = true;
                }
            }""", selector)
            text = await page.evaluate(CONTENT_TEXT_JS, settings)
            final_url, title = page.url, await page.title()
            validate_url(final_url, document_host=host)
            links = await page.evaluate("""selector => [...document.querySelectorAll(selector)].flatMap(root => [...root.querySelectorAll('a[href]')].map(a => ({href: a.href, text: a.innerText || a.textContent || ''})))""", selector)
            return {**source_payload(text, final_url, title, authority_page=settings['authorityPage']),
                    'official_portal_links': [{'url': l['href'], 'name': l['text']} for l in links if (urlsplit(l['href']).hostname or '').endswith('.gov')][:40],
                    'discovered_source_urls': relevant_source_links(links, final_url)}
        finally:
            await context.close()


async def bounded_retrieve(url: str) -> dict[str, Any]:
    try:
        result = await asyncio.wait_for(retrieve(url), 65)
        if len(cache) >= 64:
            cache.pop(next(iter(cache)))
        cache[url] = (time.monotonic(), result)
        return result
    finally:
        inflight.pop(url, None)


@app.post("/scrape-municipality")
async def scrape_municipality(req: ScrapeRequest, x_api_key: str | None = Header(default=None)) -> dict[str, Any]:
    authenticate(x_api_key)
    started = time.monotonic()
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
        recon = {'status': 'disabled', 'research_only': True, 'source_pages': []}
        budget = min(25, 64 - (time.monotonic() - started))
        if req.run_secondary_recon and budget >= 5:
            key = 'recon:' + json.dumps([req.state, req.municipality.casefold(), result['final_url']])
            try:
                recon = await cached_research(key, lambda: municipal_recon(req.municipality, req.state, result), budget)
            except (HTTPException, TimeoutError, asyncio.TimeoutError, PlaywrightTimeoutError, ValueError, OSError):
                recon = {'status': 'unavailable_or_time_budget', 'research_only': True, 'source_pages': []}
        return {**result, "municipality": req.municipality, "state": req.state,
                'municipal_recon': recon, 'worker_version': WORKER_VERSION}
    except HTTPException:
        raise
    except ValueError:
        raise HTTPException(422, "Unsupported source URL") from None
    except (TimeoutError, asyncio.TimeoutError, PlaywrightTimeoutError):
        raise HTTPException(504, "Ordinance retrieval timed out") from None
    except Exception:
        raise HTTPException(502, "Source retrieval failed; no zoning values were changed") from None


@app.post('/harvest-state')
async def harvest_state_urls(req: HarvestStateRequest, x_api_key: str | None = Header(default=None)) -> dict[str, Any]:
    authenticate(x_api_key)
    key = 'harvest:' + json.dumps(req.model_dump(), sort_keys=True)
    try:
        return await cached_research(key, lambda: harvest_state(req), 150)
    except HTTPException:
        raise
    except (TimeoutError, asyncio.TimeoutError, PlaywrightTimeoutError):
        raise HTTPException(504, 'Directory research timed out') from None
    except Exception:
        raise HTTPException(502, 'Directory research failed; no master records were changed') from None
