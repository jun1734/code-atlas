// 조립하는 곳: 기능 화면을 모아 앱을 세워요.
import 'features/catalog/catalog_page.dart';
import 'features/catalog/price_format.dart';
import 'features/orders/orders_page.dart';
import 'shared/header.dart';

void main() {
  print(CatalogPage().render());
  print(OrdersPage().render());
  print(formatPrice(1200));
  print(HeaderStyle());
}
