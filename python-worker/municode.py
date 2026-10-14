"""Find a jurisdiction's macro-tower siting sections through Municode's public API.

The stored ordinance URL is often a code root or a district/use-table node, so
rendering that one page returns no tower rules. This module resolves the URL's
client, walks every CODES product's table of contents, ranks tower/wireless
sections by macro-siting signal, and returns those sections' text with their
headings so section references and verbatim quotes can be checked downstream.
It only reads; Base44 still decides what may be written to the master.
"""
from __future__ import annotations

import asyncio
import html
import re
import time
from typing import Any
from urllib.parse import parse_qs, urlsplit

import httpx

API = "https://library.municode.com/api"
CLIENTS_API = "https://api.municode.com/Clients/stateAbbr"
HEADERS = {"X-CSRF": "1", "Accept": "application/json", "User-Agent": "SiteHawk-ordinance-retrieval/1.4"}
MAX_TEXT = 60_000
MAX_CANDIDATES = 8
MAX_LEAVES = 40

# Headings that name tower/wireless siting rules. "Towers" alone is accepted,
# but water/observation towers are excluded below.
HEAD_STRONG = re.compile(
    r"communications?\s+(?:towers?|facilit)|telecommunications?\s+(?:towers?|facilit|antenna|structures?)"
    r"|wireless\s+(?:communications?|telecommunications?|facilit|support|towers?|antenna|service)"
    r"|towers?\s+(?:and|&)\s+antenna|antenna(?:s|e)?\s+(?:and|&)\s+(?:support\s+)?(?:towers?|structures?)"
    r"|personal\s+wireless|commercial\s+mobile\s+radio|\bcmrs\b|cell(?:ular)?\s+towers?|monopoles?"
    r"|radio\s+(?:and|&|or)\s+television\s+towers?|transmission\s+towers?", re.I)
HEAD_WEAK = re.compile(r"\btowers?\b|\btelecommunications?\b|\bantenna", re.I)
# Not macro siting: small cells in the right-of-way, taxes/franchises, dishes,
# amateur radio, water towers, definitions.
HEAD_NEG = re.compile(
    r"small\s+(?:wireless|cell)|rights?[\s-]+of[\s-]+way|franchis|\btax|911|surcharge|satellite|\bdish"
    r"|amateur|ham\s+radio|cable\s+(?:television|tv|system|communications?)|utility\s+poles?|water\s+towers?"
    r"|observation|\bfees?\b|\bdefinitions?\b|business\s+licen", re.I)
ANCESTOR_NEG = re.compile(r"rights?[\s-]+of[\s-]+way|franchis|\btaxation\b|\btaxes\b|business\s+tax|utilit(?:y|ies)\s+(?:tax|service)", re.I)
ZONING_ANCESTOR = re.compile(r"zoning|land\s+development|unified\s+development|development\s+(?:code|regulations|standards)|land\s+use", re.I)

MACRO = re.compile(
    r"set\s*-?back|fall\s*(?:zone|radius)|collapse|break\s*point|height|separat|co-?locat|monopole|lattice|guyed"
    r"|stealth|camouflag|special\s+exception|conditional\s+use|special\s+use|residential|engineer", re.I)
SWA = re.compile(r"small\s+wireless\s+facilit|small\s+cell|\b911\b|\btax(?:es)?\b|franchise", re.I)

_clients: dict[str, tuple[float, list[dict[str, Any]]]] = {}
_tocs: dict[int, tuple[float, int, dict[str, Any]]] = {}


class MunicodeUnresolved(Exception):
    """The URL could not be tied to one Municode client; fall back to rendering."""


def slug(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", (value or "").lower()).strip("_")


def parse_url(url: str) -> tuple[str, str, str, str]:
    parts = urlsplit(url)
    segs = [s for s in parts.path.split("/") if s]
    if len(segs) < 2 or len(segs[0]) != 2:
        raise MunicodeUnresolved("not a jurisdiction URL")
    product = segs[3] if len(segs) >= 4 and segs[2] == "codes" else ""
    node = parse_qs(parts.query).get("nodeId", [""])[0]
    return segs[0].lower(), segs[1], product, node


def html_text(content: str) -> str:
    content = re.sub(r"(?i)<br\s*/?>|</(?:p|div|li|tr|h\d|table)>", "\n", content or "")
    content = re.sub(r"(?i)</t[dh]>", " | ", content)
    text = html.unescape(re.sub(r"<[^>]+>", " ", content))
    lines = [re.sub(r"[ \t ]+", " ", ln).strip() for ln in text.splitlines()]
    return "\n".join(ln for ln in lines if ln)


async def _get(client: httpx.AsyncClient, url: str, **params: Any) -> Any:
    for attempt in range(3):
        resp = await client.get(url, params=params or None)
        if resp.status_code == 204:
            return None  # terminal: e.g. a product with no published job
        if resp.status_code in (429, 500, 502, 503, 504) and attempt < 2:
            await asyncio.sleep(1 + attempt)
            continue
        resp.raise_for_status()
        return resp.json()
    return None


async def state_clients(client: httpx.AsyncClient, state: str) -> list[dict[str, Any]]:
    hit = _clients.get(state)
    if hit and time.monotonic() - hit[0] < 86_400:
        return hit[1]
    rows = await _get(client, CLIENTS_API, stateAbbr=state) or []
    _clients[state] = (time.monotonic(), rows)
    return rows


async def product_toc(client: httpx.AsyncClient, product_id: int, job_id: int) -> dict[str, Any]:
    hit = _tocs.get(product_id)
    if hit and hit[1] == job_id:
        return hit[2]
    toc = await _get(client, f"{API}/codesToc/fullTree/latest", productId=product_id) or {}
    if len(_tocs) >= 12:
        _tocs.pop(next(iter(_tocs)))
    _tocs[product_id] = (time.monotonic(), job_id, toc)
    return toc


def candidates(toc: dict[str, Any], wanted_node: str) -> list[dict[str, Any]]:
    """Score every TOC node whose own heading names tower/wireless siting."""
    found: list[dict[str, Any]] = []

    def walk(node: dict[str, Any], ancestors: list[str]) -> None:
        heading = node.get("Heading") or ""
        path = " / ".join(ancestors)
        score = 0
        if HEAD_STRONG.search(heading):
            score = 10
        elif HEAD_WEAK.search(heading):
            score = 5
        if node.get("Id") == wanted_node:
            score = max(score, 4)
        if score and (HEAD_NEG.search(heading) or ANCESTOR_NEG.search(path)):
            score = 0
        if score:
            if ZONING_ANCESTOR.search(path + " " + heading):
                score += 3
            found.append({"node": node, "heading": heading, "path": path, "score": score})
        for child in node.get("Children") or []:
            walk(child, ancestors + [heading])

    walk(toc, [])
    # Keep the highest node when a parent and its children both match.
    ids = {c["node"].get("Id") for c in found}
    def has_matching_ancestor(c: dict[str, Any]) -> bool:
        parent = c["node"].get("ParentId")
        return parent in ids
    kept = [c for c in found if not has_matching_ancestor(c)]
    return sorted(kept, key=lambda c: -c["score"])[:MAX_CANDIDATES]


def leaves(node: dict[str, Any]) -> list[str]:
    out: list[str] = []
    def walk(n: dict[str, Any]) -> None:
        if len(out) >= MAX_LEAVES:
            return
        out.append(n.get("Id"))
        for ch in n.get("Children") or []:
            walk(ch)
    walk(node)
    return [i for i in out if i]


async def node_docs(client: httpx.AsyncClient, product_id: int, job_id: int, node: dict[str, Any]) -> list[tuple[str, str, str]]:
    docs: list[tuple[str, str, str]] = []
    for node_id in leaves(node):
        data = await _get(client, f"{API}/CodesContent", jobId=job_id, nodeId=node_id, productId=product_id, groupChunks="false")
        for doc in (data or {}).get("Docs") or []:
            if doc.get("Id") == node_id:
                docs.append((node_id, (doc.get("Title") or "").strip(), html_text(doc.get("Content") or "")))
    return docs


def macro_score(text: str) -> int:
    return len(MACRO.findall(text)) - 2 * len(SWA.findall(text))


async def find_tower_sections(target_url: str, municipality: str = "") -> dict[str, Any]:
    state, client_slug, url_product, url_node = parse_url(target_url)
    async with httpx.AsyncClient(headers=HEADERS, timeout=30) as client:
        roster = await state_clients(client, state)
        matches = [c for c in roster if slug(c.get("ClientName", "")) == client_slug.lower()]
        if len(matches) != 1:
            raise MunicodeUnresolved("client slug does not match exactly one Municode client")
        muni = matches[0]
        products = [p for p in await _get(client, f"{API}/Products/clientId/{muni['ClientID']}") or []
                    if (p.get("ContentType") or {}).get("Id") == "CODES"]
        if not products:
            raise MunicodeUnresolved("client has no published code product")
        scored: list[dict[str, Any]] = []
        for product in products:
            job = await _get(client, f"{API}/Jobs/latest/{product['ProductID']}")
            if not job:
                continue
            toc = await product_toc(client, product["ProductID"], job["Id"])
            for cand in candidates(toc, url_node):
                docs = await node_docs(client, product["ProductID"], job["Id"], cand["node"])
                body = "\n".join(f"{title}\n{text}" for _, title, text in docs if title or text)
                if not body.strip():
                    continue
                scored.append({"product": product, "node_id": cand["node"].get("Id"), "heading": cand["heading"],
                               "path": cand["path"], "body": body,
                               "rank": cand["score"] + min(macro_score(body), 40)})
        scored = [s for s in scored if macro_score(s["body"]) >= 3]
        if not scored:
            raise MunicodeUnresolved("no macro tower siting section found in any code product")
        scored.sort(key=lambda s: -s["rank"])
        best = scored[0]
        state_name = (muni.get("State") or {}).get("StateName") or state.upper()
        parts = [f"{muni['ClientName']}, {state_name} - Municode library"]
        used: list[dict[str, str]] = []
        for s in scored:
            block = f"\n\n[{s['product']['ProductName']} - {s['path']}]\n{s['body']}"
            if sum(len(p) for p in parts) + len(block) > MAX_TEXT:
                if not used:
                    block = block[: MAX_TEXT - sum(len(p) for p in parts)]
                else:
                    continue
            parts.append(block)
            used.append({"node_id": s["node_id"], "heading": s["heading"], "product": s["product"]["ProductName"]})
        product_slug = url_product if slug(best["product"]["ProductName"]) == slug(url_product) else slug(best["product"]["ProductName"])
        final_url = f"https://library.municode.com/{state}/{client_slug}/codes/{product_slug}?nodeId={best['node_id']}"
        return {"text": "".join(parts), "final_url": final_url, "page_title": best["heading"],
                "sections": used, "client_name": muni["ClientName"], "client_id": muni["ClientID"],
                "truncated": len(used) < len(scored)}
