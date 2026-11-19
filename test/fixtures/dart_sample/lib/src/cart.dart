import 'pricing.dart';

class Cart {
  final List<int> prices = [];

  void add(int price) => prices.add(price);

  int total() {
    var sum = 0;
    for (final p in prices) {
      sum += withTax(p);
    }
    return sum + shippingFee;
  }
}

class Wishlist {
  final List<int> prices = [];

  void add(int price) => prices.add(price);
}
