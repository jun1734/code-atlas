import '../../core/money.dart';

class Cart {
  final List<int> prices = [];

  void add(int price) => prices.add(price);

  int total() => withVat(prices.fold(0, (a, b) => a + b));
}
