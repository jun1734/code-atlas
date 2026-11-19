import 'package:impact_sample/features/cart/cart.dart';

void main() {
  final cart = Cart()..add(100);
  assert(cart.total() == 110);
}
