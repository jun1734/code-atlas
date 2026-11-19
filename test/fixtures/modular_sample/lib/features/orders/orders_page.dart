// 주문 화면. 상품 화면과 provider는 가져다 써도 되지만, 가격 도우미는 리뷰 후보예요.
import '../../shared/header.dart';
import '../../shared/strings.dart';
import '../catalog/catalog_page.dart';
import '../catalog/catalog_provider.dart';
import '../catalog/price_format.dart';
import 'order_status.dart';

class OrdersPage {
  String render() => [
        header('orders'),
        title(labelOf(OrderStatus.placed)),
        announce(OrderStatus.shipped),
        formatPrice(catalogProvider.length),
        CatalogPage().render(),
      ].join('\n');
}
