import 'package:dart_sample/dart_sample.dart';
import 'package:riverpod/riverpod.dart';

void main() {
  discountPercent = 10;
  final container = ProviderContainer();
  final cart = container.read(cartProvider)..add(1000);
  final tax = withTax;
  print(tax(500) + withTax(500));
  print(cart.total() + container.read(totalProvider));
  print(GiftCart().label);
  final Cart spare = Cart();
  spare.add(1);
}
