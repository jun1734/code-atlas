// 저장소 밖 심볼의 열쇠에서 패키지 이름을 꺼내요. 코드 지도의 "외부 SDK가 닿는 파일"이 써요.
// 열쇠는 SCIP 심볼 문자열이에요: <scheme> <manager> <package-name> <version> <descriptor>+ (scip.proto의 Symbol 설명).
// 정밀 어댑터는 모두 SCIP 색인기를 돌리니 언어와 상관없이 같은 꼴이에요. 꼴이 다른 열쇠(추정 어댑터 등)는 null이에요.
import { parseSymbol } from '../scip/symbol.ts';

/** 공백으로 나뉜 앞쪽 칸들을 읽어요. 칸 안의 공백은 '  '(두 칸)으로 적혀요. */
function headerFields(symbol: string, count: number): string[] | null {
  const fields: string[] = [];
  let current = '';
  let i = 0;
  while (i < symbol.length && fields.length < count) {
    if (symbol[i] === ' ') {
      if (symbol[i + 1] === ' ') {
        current += ' ';
        i += 2;
        continue;
      }
      fields.push(current);
      current = '';
      i++;
      continue;
    }
    current += symbol[i];
    i++;
  }
  return fields.length === count ? fields : null;
}

/**
 * 열쇠가 가리키는 패키지 이름.
 * 기본은 라이브러리(파일) 자체를 가리키는 열쇠만 셈해요: 그 파일이 패키지를 import했다는 뜻이에요.
 * 패키지 안의 이름을 쓴 곳까지 세면, import하지 않고 남이 준 값의 메서드만 부른 파일도 들어가서예요.
 * 언어 기본 라이브러리(`dart:async`처럼 이름에 ':'이 든 것)는 SDK가 아니라 빼요.
 * `anySymbol`이면 어떤 심볼이든 패키지 이름을 줘요(저장소 자신의 패키지를 알아낼 때).
 */
export function externalPackageOf(key: string, opts: { anySymbol?: boolean } = {}): string | null {
  if (key.startsWith('local ')) return null;
  const fields = headerFields(key, 4);
  if (!fields) return null;
  const pkg = fields[2]!;
  if (pkg === '' || pkg === '.' || pkg.includes(':')) return null;
  if (opts.anySymbol) return pkg;
  const { descriptors } = parseSymbol(key);
  if (descriptors.length === 0 || descriptors.some((d) => d.suffix !== 'namespace')) return null;
  return pkg;
}
