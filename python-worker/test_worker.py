import asyncio
import os
import unittest
from unittest.mock import AsyncMock, patch

import httpx
import main


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


if __name__ == "__main__":
    unittest.main(verbosity=2)
