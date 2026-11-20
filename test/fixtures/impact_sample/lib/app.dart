import 'features/cart/cart.dart';
import 'features/checkout/checkout.dart';

String runApp() {
  final cart = Cart()..add(1000);
  return checkoutLine(cart);
}
