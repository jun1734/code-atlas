import '../../core/money.dart';
import '../cart/cart.dart';

String checkoutLine(Cart cart) => '합계 ${won(cart.total())}';
