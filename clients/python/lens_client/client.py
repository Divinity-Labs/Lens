import json
import urllib.request
import urllib.error
from typing import Optional
from .models import PriceResponse, RouteResponse, CandleResponse, OracleComparison


class LensClient:
    """Minimal HTTP client for the Lens price indexer API.

    No third-party dependencies — uses only the Python standard library.
    """

    def __init__(self, base_url: str, timeout: int = 10):
        self.base_url = base_url.rstrip('/')
        self.timeout = timeout

    def _get(self, path: str) -> dict:
        url = f"{self.base_url}{path}"
        req = urllib.request.Request(url, headers={"Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=self.timeout) as resp:
            return json.loads(resp.read().decode())

    def get_price(self, asset_a: str, asset_b: str) -> Optional[PriceResponse]:
        """Return the latest aggregated price for a trading pair."""
        try:
            data = self._get(f"/price/{asset_a}/{asset_b}")
            return PriceResponse(
                asset_a=data['assetA'],
                asset_b=data['assetB'],
                pair_key=data['pairKey'],
                price=float(data['price']),
                source=data.get('source', ''),
                timestamp=data.get('timestamp', ''),
            )
        except (urllib.error.HTTPError, KeyError):
            return None

    def get_route(self, from_asset: str, to_asset: str, amount: float) -> Optional[RouteResponse]:
        """Return the best swap route between two assets."""
        try:
            data = self._get(f"/route/{from_asset}/{to_asset}?amount={amount}")
            return RouteResponse(
                path=data.get('path', []),
                input_asset=data['inputAsset'],
                output_asset=data['outputAsset'],
                estimated_output=float(data['estimatedOutput']),
            )
        except (urllib.error.HTTPError, KeyError):
            return None

    def get_candles(self, asset_a: str, asset_b: str, interval: str = '1h', limit: int = 24) -> list:
        """Return OHLCV candles for a pair."""
        try:
            data = self._get(f"/candles/{asset_a}/{asset_b}?interval={interval}&limit={limit}")
            candles = data if isinstance(data, list) else data.get('candles', [])
            return [
                CandleResponse(
                    pair_key=c.get('pairKey', ''),
                    open=float(c['open']),
                    high=float(c['high']),
                    low=float(c['low']),
                    close=float(c['close']),
                    volume=float(c.get('volume', 0)),
                    timestamp=c.get('timestamp', ''),
                )
                for c in candles
            ]
        except (urllib.error.HTTPError, KeyError):
            return []

    def compare_oracle(self, asset: str) -> Optional[OracleComparison]:
        """Compare Lens price vs Reflector oracle for an asset."""
        try:
            data = self._get(f"/compare/{asset}")
            return OracleComparison(
                asset=data['asset'],
                lens=data.get('lens'),
                reflector=data.get('reflector'),
                deviation_pct=data.get('deviationPct'),
                status=data.get('status', 'unknown'),
                fetched_at=data.get('fetchedAt', ''),
            )
        except urllib.error.HTTPError:
            return None
