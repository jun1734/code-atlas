# 빌드 산출물이에요. 색인에서 기본으로 빠져야 해요.
from shop import withTax


def receipt(price: int) -> int:
    return withTax(price)
