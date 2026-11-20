from .cart import Cart

# provider: 값을 만들어 주는 모듈 수준 값(Python에는 Riverpod이 없어서 함수 값으로 둬요).
cartProvider = lambda: Cart()

totalProvider = lambda: cartProvider().total()
