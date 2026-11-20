import 'line_item.dart';

const taxRate = 1.1;

double withTax(double value) => value * taxRate;

double lineTax(LineItem item) => item.amount() * (taxRate - 1);
