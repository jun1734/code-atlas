from typing import Final


def withTax(price: int) -> int:
    """세금을 붙인 가격."""
    return price + price // 10


# 기본 배송비(모듈 수준 상수: Final).
shippingFee: Final = 3000

# 할인율(%). 모듈 수준 변수라 읽는 곳과 쓰는 곳이 다 있어요.
discountPercent = 0


def setDiscount(percent: int) -> None:
    global discountPercent
    discountPercent = percent
