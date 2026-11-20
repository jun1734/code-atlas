// 모듈: 파일 경로를 저장소 설정의 규칙에 맞춰 모듈 이름으로 바꿔요.
// check(흐름을 거스르는 import, 층), impact(모듈별 묶음), clusters(여러 모듈에 걸침)가 모두 이 함수를 써요.
import type { GraphStore } from './graph/store.ts';
import { loadRepoConfig, type ModuleRule, type RepoConfig } from './repo-config.ts';

const escape = (s: string) => s.replace(/[.+^$()|[\]\\]/g, '\\$&');

/**
 * glob을 정규식으로 바꿔요. 경로 구분자는 '/'.
 * `**`는 여러 칸(0칸 포함), `*`는 한 칸 안의 아무 글자, `?`는 한 글자, `{module}`은 한 칸을 잡아요.
 */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; ) {
    if (glob.startsWith('**/', i)) {
      re += '(?:.*/)?';
      i += 3;
    } else if (glob.startsWith('/**', i) && i + 3 === glob.length) {
      re += '(?:/.*)?';
      i += 3;
    } else if (glob.startsWith('**', i)) {
      re += '.*';
      i += 2;
    } else if (glob.startsWith('{module}', i)) {
      re += '([^/]+)';
      i += '{module}'.length;
    } else if (glob[i] === '*') {
      re += '[^/]*';
      i += 1;
    } else if (glob[i] === '?') {
      re += '[^/]';
      i += 1;
    } else {
      re += escape(glob[i]!);
      i += 1;
    }
  }
  return new RegExp(`^${re}$`);
}

/** 이름 glob(`*`는 아무 글자)을 정규식으로. 심볼 이름처럼 '/'가 없는 것에 써요. */
export function nameGlobToRegExp(glob: string): RegExp {
  return new RegExp(`^${glob.split('*').map((part) => escape(part).replace(/\?/g, '.')).join('.*')}$`);
}

export type ModuleOf = (path: string) => string | null;

/**
 * 설정의 모듈 규칙으로 "파일 경로 → 모듈" 함수를 만들어요.
 * 경로는 저장소 뿌리 기준, '/' 구분이에요. 앞에서부터 처음 맞는 규칙을 쓰고, 맞는 규칙이 없으면 null(검사 밖)이에요.
 */
export function moduleResolver(config: Pick<RepoConfig, 'modules'>): ModuleOf {
  const rules = config.modules.map((rule: ModuleRule) => {
    if (!rule.module && !rule.path.includes('{module}')) {
      throw new Error(`모듈 규칙에 module 이름도 {module} 자리도 없어요: ${rule.path}`);
    }
    return { re: globToRegExp(rule.path), module: rule.module };
  });
  const cache = new Map<string, string | null>();
  return (path) => {
    let found = cache.get(path);
    if (found !== undefined) return found;
    found = null;
    for (const rule of rules) {
      const m = rule.re.exec(path);
      if (m) {
        found = rule.module ?? m[1]!;
        break;
      }
    }
    cache.set(path, found);
    return found;
  };
}

/**
 * 색인한 저장소의 설정을 읽고 "파일 경로 → 모듈" 함수를 만들어요. check, impact, clusters가 모두 이것을 써요.
 * configPath가 없으면 색인한 저장소 뿌리(root를 주면 그 폴더)의 .code-atlas.json(없으면 기본 설정)이에요.
 * root는 색인한 자리가 지금은 없는 색인(detect_changes의 커밋 색인)에 지금 저장소의 설정을 쓸 때 줘요.
 */
export function repoModules(
  store: GraphStore,
  configPath?: string,
  root: string = store.meta().repoRoot,
): { config: RepoConfig; moduleOf: ModuleOf } {
  const config = loadRepoConfig(root, configPath);
  return { config, moduleOf: moduleResolver(config) };
}
