import '../misc/receipt_format.dart';
import 'line_item.dart';
import 'tax.dart';

class Invoice {
  final List<LineItem> items;
  Invoice(this.items);
  double total() => items.fold(0, (sum, item) => sum + item.amount());
  double totalWithTax() => withTax(total());
  double taxOnly() => items.fold(0, (sum, item) => sum + lineTax(item));
  String render() => formatReceipt(this);
}
