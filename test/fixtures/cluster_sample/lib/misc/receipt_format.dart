// 결제 덩어리에 꼭 붙어 있지만 폴더는 misc에 있어요(여러 모듈에 걸친 묶음).
import '../billing/invoice.dart';
import '../billing/line_item.dart';
import '../billing/tax.dart';

String formatReceipt(Invoice invoice) {
  final lines = invoice.items.map((LineItem item) => '${item.qty} x ${item.price}').join('\n');
  return '$lines\n합계 ${withTax(invoice.total())} (세율 $taxRate)';
}
