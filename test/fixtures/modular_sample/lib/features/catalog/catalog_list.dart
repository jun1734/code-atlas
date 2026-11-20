// 상품 목록과 상품 한 줄이 서로를 가져다 써요(서로 물린 파일).
import '../../shared/strings.dart';
import 'catalog_item.dart';
import 'catalog_provider.dart';

String catalogList() => catalogProvider.map(catalogItem).join('\n');

String listTitle() => title('list');
