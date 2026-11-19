from dataclasses import dataclass
from typing import Optional


@dataclass
class PriceResponse:
    asset_a: str
    asset_b: str
    pair_key: str
    price: float
    best_route: str = ""
    vwap_1h: Optional[float] = None
    timestamp: str = ""


@dataclass
class RouteResponse:
    route: list
    sdex_price: Optional[float] = None
    amm_price: Optional[float] = None
    best_route: str = ""


@dataclass
class CandleResponse:
    pair_key: str
    open: float
    high: float
    low: float
    close: float
    volume: float
    timestamp: str = ""


@dataclass
class OracleComparison:
    asset: str
    lens_price: Optional[float] = None
    oracle_price: Optional[float] = None
    deviation_pct: Optional[float] = None
    oracle: str = ""
