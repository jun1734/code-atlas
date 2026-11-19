import '../../common/frame.dart';
import '../../util/fmt.dart';

/// 메뉴 화면. 공통 틀과 글자 다듬기를 써요.
class MenuPage {
  String render() => frame(fmt('menu'));
}
