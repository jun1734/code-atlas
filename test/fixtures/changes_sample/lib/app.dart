import 'features/cart/cart.dart';
import 'features/checkout/checkout.dart';
import 'features/shipping/shipping.dart';

String runApp() {
  final cart = Cart()..add(1000);
  return '${checkoutLine(cart)} ${shippingFee(cart.total())}';
}
