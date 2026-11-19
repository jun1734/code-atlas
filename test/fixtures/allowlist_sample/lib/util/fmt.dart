import '../features/menu/menu_page.dart';

/// 글자 다듬기. 메뉴 화면을 가져오는 것은 허용 목록에 없어요(같은 대상이라도 common만 허용이에요).
String fmt(String s) => '${s.trim()} ${MenuPage}';
