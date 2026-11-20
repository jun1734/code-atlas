import '../../core/money.dart';
import '../cart/cart.dart';

String checkoutLine(Cart cart) => 'total ${won(cart.total())}';
