import asyncio
import os
import unittest
from unittest.mock import AsyncMock, patch

import httpx
import main
import municode


class WorkerTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.env = patch.dict(os.environ, {"SITEHAWK_API_KEY": "x" * 40})
        self.env.start()
        main.cache.clear()
        main.inflight.clear()
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url="http://test")

    async def asyncTearDown(self):
        await self.client.aclose()
        self.env.stop()

    def test_url_boundaries(self):
        for url in ["http://library.municode.com/fl/x", "https://library.municode.com.evil.test/x",
                    "https://127.0.0.1/x", "https://user:pw@library.municode.com/x",
                    "https://library.municode.com:8080/x", "https://foo.internal/x"]:
            with self.subTest(url=url), self.assertRaises(ValueError):
                main.validate_url(url)
        self.assertEqual(main.validate_url("https://library.municode.com/fl/lake_mary/codes/code_of_ordinances"), "library.municode.com")

    async def test_private_dns(self):
        with patch.object(asyncio.get_running_loop(), "getaddrinfo", new=AsyncMock(return_value=[(2, 1, 6, "", ("127.0.0.1", 443))])):
            with self.assertRaises(ValueError):
                await main.public_dns("example.gov")

    async def test_unauthorized_no_retrieval(self):
        with patch.object(main, "retrieve", new=AsyncMock()) as retrieve:
            response = await self.client.post("/scrape-municipality", json={"municipality": "Lake Mary", "state": "FL", "target_url": "https://library.municode.com/fl/lake_mary"})
            self.assertEqual(response.status_code, 401)
            retrieve.assert_not_called()

    async def test_state_is_required(self):
        response = await self.client.post("/scrape-municipality", headers={"x-api-key": "x" * 40}, json={"municipality": "Lake Mary", "target_url": "https://library.municode.com/fl/lake_mary"})
        self.assertEqual(response.status_code, 422)

    async def test_shared_retrieval_and_cache(self):
        async def delayed(url):
            await asyncio.sleep(.02)
            return {"status": "success", "raw_ordinance_text": "tower " * 100}
        body = {"municipality": "Lake Mary", "state": "FL", "target_url": "https://library.municode.com/fl/lake_mary"}
        with patch.object(main, "retrieve", new=AsyncMock(side_effect=delayed)) as retrieve:
            responses = await asyncio.gather(*[self.client.post("/scrape-municipality", headers={"x-api-key": "x" * 40}, json=body) for _ in range(2)])
            self.assertTrue(all(r.status_code == 200 for r in responses))
            await self.client.post("/scrape-municipality", headers={"x-api-key": "x" * 40}, json=body)
            self.assertEqual(retrieve.await_count, 1)

    async def test_failure_never_cached(self):
        body = {"municipality": "Lake Mary", "state": "FL", "target_url": "https://library.municode.com/fl/lake_mary"}
        with patch.object(main, "retrieve", new=AsyncMock(side_effect=RuntimeError("private diagnostics"))):
            response = await self.client.post("/scrape-municipality", headers={"x-api-key": "x" * 40}, json=body)
            self.assertEqual(response.status_code, 502)
            self.assertNotIn("private diagnostics", response.text)
            self.assertFalse(main.cache)
            self.assertFalse(main.inflight)


    async def test_municode_url_uses_api_sections_without_browser(self):
        text = "Montverde, Florida - Municode library\n\nSec. 10-89. - Communication towers.\n" + \
            "Towers shall be set back from any residential property line a distance equal to the tower height. " * 8
        found = {"text": text, "final_url": "https://library.municode.com/fl/montverde/codes/code_of_ordinances?nodeId=X",
                 "page_title": "Sec. 10-89. - Communication towers.", "sections": [{"node_id": "X"}], "truncated": False}
        with patch.object(main, "public_dns", new=AsyncMock()), \
             patch.object(main.municode, "find_tower_sections", new=AsyncMock(return_value=found)):
            result = await main.retrieve("https://library.municode.com/fl/montverde")
        self.assertEqual(result["source_format"], "municode_api")
        self.assertEqual(result["final_url"], found["final_url"])
        self.assertEqual(result["scope"], "retrieved_page_only")
        self.assertFalse(result["complete_code"])
        self.assertEqual(result["text_sha256"], main.hashlib.sha256(result["raw_ordinance_text"].encode()).hexdigest())

    async def test_unresolved_municode_falls_back_to_browser_path(self):
        with patch.object(main, "public_dns", new=AsyncMock()), patch.object(main, "browser", None), \
             patch.object(main.municode, "find_tower_sections", new=AsyncMock(side_effect=main.municode.MunicodeUnresolved("x"))):
            with self.assertRaises(main.HTTPException) as caught:
                await main.retrieve("https://library.municode.com/fl/montverde")
        self.assertEqual(caught.exception.status_code, 503)  # reached the Playwright path

    async def test_short_api_text_falls_back_instead_of_padding(self):
        found = {"text": "Sec. 1. - Cell towers.\nCell towers only in I-1.", "final_url": "https://library.municode.com/fl/a/codes/c?nodeId=X",
                 "page_title": "Cell towers", "sections": [], "truncated": False}
        with patch.object(main.municode, "find_tower_sections", new=AsyncMock(return_value=found)):
            self.assertIsNone(await main.retrieve_municode("https://library.municode.com/fl/a"))


class MunicodeFinderTests(unittest.TestCase):
    def toc(self):
        node = lambda i, h, parent, kids=(): {"Id": i, "Heading": h, "ParentId": parent, "Children": list(kids)}
        return node("root", "Code", None, [
            node("ch22", "Chapter 22 - PUBLIC RIGHTS-OF-WAY", "root", [node("row", "ARTICLE II. - TELECOMMUNICATIONS", "ch22")]),
            node("tax", "Sec. 36-92. - Communications services tax rate", "root"),
            node("dish", "Sec. 4-371. - Satellite dish antenna standards.", "root"),
            node("ch10", "Chapter 10 - ZONING REGULATIONS", "root", [
                node("twr", "Sec. 10-89. - Communication towers.", "ch10"),
                node("districts", "Sec. 10-2. - Mapping districts.", "ch10")]),
        ])

    def test_candidates_keep_tower_sections_and_drop_row_tax_dish(self):
        ids = [c["node"]["Id"] for c in municode.candidates(self.toc(), "")]
        self.assertEqual(ids, ["twr"])

    def test_stored_node_stays_a_low_ranked_candidate(self):
        ranked = {c["node"]["Id"]: c["score"] for c in municode.candidates(self.toc(), "districts")}
        self.assertGreater(ranked["twr"], ranked["districts"])

    def test_section_numbers_group_numbered_subsections(self):
        parent = municode.SECTION_NO.match("7.11.22. - Wireless communications facilities.").group(1)
        child = municode.SECTION_NO.match("7.11.22.01. - Purpose.").group(1)
        other = municode.SECTION_NO.match("7.11.23. - Fences.").group(1)
        self.assertTrue(child.startswith(parent + "."))
        self.assertFalse(other.startswith(parent + "."))

    def test_swa_only_text_does_not_count_as_macro_rules(self):
        self.assertFalse(municode.keeps_tower_rules("Small wireless facilities in the right-of-way are permitted."))
        self.assertTrue(municode.keeps_tower_rules(
            "Communication towers require a special exception; setback equal to height; separation of 1,000 feet."))


if __name__ == "__main__":
    unittest.main(verbosity=2)
