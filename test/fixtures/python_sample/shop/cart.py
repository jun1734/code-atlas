from typing import Protocol

from . import pricing
from .pricing import shippingFee, withTax


class Totaled(Protocol):
    """합계를 내는 것(인터페이스)."""

    def total(self) -> int: ...


class Labeled:
    """이름표를 붙이는 바탕 타입(Python에는 mixin 문법이 없어서 바탕 타입으로 섞어요)."""

    @property
    def label(self) -> str:
        return 'cart'


class Cart(Labeled, Totaled):
    def __init__(self) -> None:
        self.prices: list[int] = []

    def add(self, price: int) -> None:
        self.prices.append(price - price * pricing.discountPercent // 100)

    def total(self) -> int:
        sum = 0
        for p in self.prices:
            sum += withTax(p)
        return sum + shippingFee


class GiftCart(Cart):
    pass


class Wishlist:
    def __init__(self) -> None:
        self.prices: list[int] = []

    def add(self, price: int) -> None:
        self.prices.append(price)
