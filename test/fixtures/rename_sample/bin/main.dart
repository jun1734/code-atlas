import 'package:rename_sample/rename_sample.dart' show Account, Money, withTax;

void main() {
  final account = Account()..deposit(100);
  final spare = Money(5);
  print('세금 $withTax ${withTax(spare.cents)} ${account.summary}');
}
