import '../features/menu/menu_page.dart';
import '../util/fmt.dart';

/// 공통 틀. 메뉴 화면을 여는 단추가 있어요(허용 목록에 적힌 import).
String frame(String body) => '[${fmt(body)}] ${MenuPage}';
