import 'db.dart';

/// 감사 기록도 같은 표에 써요.
void logAudit(int id) => writeRow(-id);
