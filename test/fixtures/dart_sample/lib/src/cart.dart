import 'pricing.dart';

/// 합계를 내는 것.
abstract interface class Totaled {
  int total();
}

/// 이름표를 붙이는 mixin.
mixin Labeled {
  String get label => 'cart';
}

class Cart with Labeled implements Totaled {
  final List<int> prices = [];

  void add(int price) => prices.add(price - price * discountPercent ~/ 100);

  @override
  int total() {
    var sum = 0;
    for (final p in prices) {
      sum += withTax(p);
    }
    return sum + shippingFee;
  }
}

class GiftCart extends Cart {}

class Wishlist {
  final List<int> prices = [];

  void add(int price) => prices.add(price);
}
