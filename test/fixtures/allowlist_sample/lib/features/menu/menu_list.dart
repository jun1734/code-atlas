import '../../common/frame.dart';
import '../../util/fmt.dart';

/// 메뉴 목록. 공통 틀과 글자 다듬기를 써요.
String menuList(List<String> items) => frame(items.map(fmt).join(','));
