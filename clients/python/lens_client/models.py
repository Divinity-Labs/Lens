from dataclasses import dataclass
from typing import Optional


@dataclass
class PriceResponse:
    asset_a: str
    asset_b: str
    pair_key: str
    price: float
    source: str
    timestamp: str


@dataclass
class RouteResponse:
    path: list
    input_asset: str
    output_asset: str
    estimated_output: float


@dataclass
class CandleResponse:
    pair_key: str
    open: float
    high: float
    low: float
    close: float
    volume: float
    timestamp: str


@dataclass
class OracleComparison:
    asset: str
    lens: Optional[float]
    reflector: Optional[float]
    deviation_pct: Optional[float]
    status: str
    fetched_at: str
