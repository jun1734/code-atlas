// 공용 머리말. 허용 목록에 적힌 대로 상품 목록 provider를 읽어요.
import '../features/catalog/catalog_provider.dart';
import 'strings.dart';

String header(String name) => '${title(name)} (${catalogProvider.length})';

// 생성자를 따로 적지 않은 클래스. 기본 생성자로만 쓰여도 쓰인 거예요.
class HeaderStyle {}
