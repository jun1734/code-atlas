// 상품 화면.
import '../../shared/header.dart';
import 'catalog_list.dart';

class CatalogPage {
  String render() => '${header('catalog')}\n${catalogList()}';
}
