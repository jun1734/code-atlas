// SCIP 심볼 문자열을 읽어 이름과 바깥 타입을 꺼내요.
// 문법: https://github.com/scip-code/scip/blob/main/scip.proto 의 Symbol 설명.
//   <scheme> ' ' <manager> ' ' <package-name> ' ' <version> ' ' <descriptor>+
//   local <id>

export type DescriptorSuffix = 'namespace' | 'type' | 'term' | 'method' | 'type-parameter' | 'parameter' | 'meta' | 'macro';

export interface Descriptor {
  name: string;
  suffix: DescriptorSuffix;
}

export interface ParsedSymbol {
  local: boolean;
  descriptors: Descriptor[];
}

/** 공백으로 나뉜 앞쪽 네 칸(scheme, manager, package, version)을 건너뛰어요. '  '는 칸 안의 공백이에요. */
function skipHeader(symbol: string): number {
  let i = 0;
  for (let field = 0; field < 4; field++) {
    while (i < symbol.length) {
      if (symbol[i] === ' ') {
        if (symbol[i + 1] === ' ') {
          i += 2;
          continue;
        }
        i++;
        break;
      }
      i++;
    }
  }
  return i;
}

function readName(s: string, i: number): [string, number] {
  if (s[i] === '`') {
    let name = '';
    i++;
    while (i < s.length) {
      if (s[i] === '`') {
        if (s[i + 1] === '`') {
          name += '`';
          i += 2;
          continue;
        }
        return [name, i + 1];
      }
      name += s[i];
      i++;
    }
    return [name, i];
  }
  const start = i;
  while (i < s.length && /[\w+$-]/.test(s[i]!)) i++;
  return [s.slice(start, i), i];
}

export function parseSymbol(symbol: string): ParsedSymbol {
  if (symbol.startsWith('local ')) return { local: true, descriptors: [] };
  const descriptors: Descriptor[] = [];
  let i = skipHeader(symbol);
  while (i < symbol.length) {
    const c = symbol[i];
    if (c === '[' || c === '(') {
      // 타입 매개변수 [name] 또는 매개변수 (name)
      const close = c === '[' ? ']' : ')';
      const [name, next] = readName(symbol, i + 1);
      i = next;
      if (symbol[i] === close) i++;
      descriptors.push({ name, suffix: c === '[' ? 'type-parameter' : 'parameter' });
      continue;
    }
    const [name, next] = readName(symbol, i);
    i = next;
    const suffixChar = symbol[i];
    if (suffixChar === '/') {
      descriptors.push({ name, suffix: 'namespace' });
      i++;
    } else if (suffixChar === '#') {
      descriptors.push({ name, suffix: 'type' });
      i++;
    } else if (suffixChar === '.') {
      descriptors.push({ name, suffix: 'term' });
      i++;
    } else if (suffixChar === ':') {
      descriptors.push({ name, suffix: 'meta' });
      i++;
    } else if (suffixChar === '!') {
      descriptors.push({ name, suffix: 'macro' });
      i++;
    } else if (suffixChar === '(') {
      // 메서드: name(disambiguator).
      const end = symbol.indexOf(').', i);
      i = end < 0 ? symbol.length : end + 2;
      descriptors.push({ name, suffix: 'method' });
    } else {
      // 문법에 맞지 않는 나머지는 버려요.
      break;
    }
  }
  return { local: false, descriptors };
}

/** 심볼의 짧은 이름과 바깥 타입을 붙인 이름. 파일·폴더(namespace)는 이름에 넣지 않아요. */
export function symbolNames(parsed: ParsedSymbol): { name: string; qualifiedName: string } | null {
  const named = parsed.descriptors.filter((d) => d.suffix !== 'namespace' && d.suffix !== 'meta');
  const last = named.at(-1);
  if (!last) return null;
  return { name: last.name, qualifiedName: named.map((d) => d.name).join('.') };
}

/**
 * 정밀 색인기(scip-dart, scip-typescript)의 열쇠를 사람이 묻는 이름에 맞춰요.
 *   Cart#`<constructor>`().    → Cart#          (이름 없는 생성자를 부르는 곳은 클래스를 쓰는 곳이에요)
 *   Labeled#`<get>label`.      → Labeled#label. (getter. scip-typescript는 끝에 ()를 붙여 `<get>label`(). 로 적어요)
 *   Labeled#`<set>label`.      → Labeled#label. (setter)
 */
export function canonicalKey(key: string): { key: string; accessor?: 'getter' | 'setter' } {
  if (key.endsWith('#`<constructor>`().')) return { key: key.slice(0, -'`<constructor>`().'.length) };
  const m = /`<(get|set)>([^`]+)`(?:\(\))?\.$/.exec(key);
  if (!m) return { key };
  const name = /^[\w+$-]+$/.test(m[2]!) ? m[2]! : `\`${m[2]}\``;
  return { key: `${key.slice(0, m.index)}${name}.`, accessor: m[1] === 'get' ? 'getter' : 'setter' };
}
