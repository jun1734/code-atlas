import 'catalog_list.dart';
import 'price_format.dart';

class Badge {
  String get text => 'new';
}

String catalogItem(String name) => '${listTitle()} $name ${formatPrice(1000)} ${Badge().text}';
