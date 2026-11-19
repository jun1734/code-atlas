import 'package:riverpod/riverpod.dart';

import 'cart.dart';

final cartProvider = Provider<Cart>((ref) => Cart());

final totalProvider = Provider<int>((ref) => ref.watch(cartProvider).total());
