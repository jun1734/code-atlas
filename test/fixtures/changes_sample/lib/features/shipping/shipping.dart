import '../../core/money.dart';
import 'zones.dart';

int shippingFee(int amount) => rounded(amount) + zones.length;
