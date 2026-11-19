"""Minimal HTTP client for the Lens price oracle API (v1 routes).

No third-party dependencies — uses only the Python standard library.
Supports bearer-token auth and x402 payment headers.
"""
import json
import urllib.request
import urllib.error
from typing import Optional
from .models import PriceResponse, RouteResponse, CandleResponse, OracleComparison


class LensApiError(Exception):
    """Raised when the API returns a non-2xx response."""
    def __init__(self, status: int, body: str):
        self.status = status
        self.body = body
        super().__init__(f"Lens API error {status}: {body[:200]}")


class LensClient:
    """Typed client for the Lens v1 API.

    Args:
        base_url: Root URL of the Lens instance (e.g. ``http://localhost:3002``).
        api_key:  Optional bearer token for authenticated instances.
        payment:  Optional x402 payment token sent in ``X-PAYMENT``.
        timeout:  Per-request timeout in seconds.
    """

    def __init__(self, base_url: str, api_key: str = "", payment: str = "", timeout: int = 10):
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self._api_key = api_key
        self._payment = payment

    def _headers(self) -> dict:
        h = {"Accept": "application/json"}
        if self._api_key:
            h["Authorization"] = f"Bearer {self._api_key}"
        if self._payment:
            h["X-PAYMENT"] = self._payment
        return h

    def _get(self, path: str) -> dict:
        url = f"{self.base_url}{path}"
        req = urllib.request.Request(url, headers=self._headers())
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                return json.loads(resp.read().decode())
        except urllib.error.HTTPError as exc:
            body = ""
            try:
                body = exc.read().decode()
            except Exception:
                pass
            raise LensApiError(exc.code, body) from exc

    def get_price(self, asset_a: str, asset_b: str, network: str = "") -> PriceResponse:
        """Return the latest aggregated price for a trading pair (v1 route)."""
        q = f"?network={network}" if network else ""
        data = self._get(f"/v1/price/{asset_a}/{asset_b}{q}")
        return PriceResponse(
            asset_a=data.get("assetA", asset_a),
            asset_b=data.get("assetB", asset_b),
            pair_key=data.get("pairKey", f"{asset_a}/{asset_b}"),
            price=float(data["price"]),
            best_route=data.get("bestRoute", ""),
            vwap_1h=data.get("vwap1h"),
            timestamp=data.get("timestamp", ""),
        )

    def get_route(self, asset_a: str, asset_b: str, amount: float, network: str = "") -> RouteResponse:
        """Return the best swap route between two assets (v1 route)."""
        q = f"?amount={amount}" + (f"&network={network}" if network else "")
        data = self._get(f"/v1/price/{asset_a}/{asset_b}/route{q}")
        return RouteResponse(
            route=data.get("route", []),
            sdex_price=data.get("sdexPrice"),
            amm_price=data.get("ammPrice"),
            best_route=data.get("bestRoute", ""),
        )

    def get_candles(self, asset_a: str, asset_b: str, interval: str = "1h", limit: int = 24) -> list:
        """Return OHLCV candles for a pair (v1 route)."""
        data = self._get(f"/v1/candles/{asset_a}/{asset_b}?interval={interval}&limit={limit}")
        candles = data if isinstance(data, list) else data.get("candles", [])
        return [
            CandleResponse(
                pair_key=c.get("pairKey", ""),
                open=float(c["open"]),
                high=float(c["high"]),
                low=float(c["low"]),
                close=float(c["close"]),
                volume=float(c.get("volume", 0)),
                timestamp=c.get("timestamp", ""),
            )
            for c in candles
        ]

    def compare_oracle(self, asset: str, network: str = "") -> OracleComparison:
        """Compare Lens price vs external oracles for an asset (v1 route)."""
        q = f"?network={network}" if network else ""
        data = self._get(f"/v1/oracle/comparison{q}")
        comps = data if isinstance(data, list) else data.get("comparisons", [])
        match = next((c for c in comps if c.get("asset") == asset), comps[0] if comps else {})
        return OracleComparison(
            asset=match.get("asset", asset),
            lens_price=match.get("lensPrice"),
            oracle_price=match.get("oraclePrice"),
            deviation_pct=match.get("deviationPct"),
            oracle=match.get("oracle", ""),
        )

    def get_status(self) -> dict:
        """Return service health/status information."""
        return self._get("/v1/status")
