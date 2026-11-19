// 저장소별 설정: 모듈을 나누는 기준, 공용 폴더, 조립 폴더, 허용 목록 위치 같은 것.
// 저장소 뿌리의 `.code-atlas.json`에 두고, 명령줄 `--config`로 다른 파일을 줄 수도 있어요.
// 형식은 docs/architecture.md의 "저장소 설정"에 있어요.
import { existsSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { SymbolKind } from './facts.ts';
import type { Param } from './queries.ts';

/** 저장소 뿌리에서 찾는 설정 파일 이름. */
export const CONFIG_FILE = '.code-atlas.json';

/** 경로 → 모듈 규칙 하나. `path`는 glob(`*` 한 칸, `**` 여러 칸, `{module}` 한 칸을 모듈 이름으로 잡음). */
export interface ModuleRule {
  path: string;
  /** 모듈 이름. 없으면 `path`의 `{module}`이 잡은 칸이 이름이에요. */
  module?: string;
}

/** 이름(glob: `*`는 아무 글자)과 종류로 심볼을 고르는 조건. */
export interface SymbolMatcher {
  kinds?: SymbolKind[];
  name: string;
}

export interface RepoConfig {
  /** 설정을 읽은 파일(저장소 뿌리 기준, '/' 구분). 기본 설정이면 null. */
  path: string | null;
  /** 앞에서부터 처음 맞는 규칙이 파일의 모듈을 정해요. 어느 규칙에도 맞지 않는 파일은 검사 밖이에요. */
  modules: ModuleRule[];
  /** 모두가 쓰라고 둔 모듈. 다른 모듈이 가져다 써도 리뷰 후보가 아니에요. */
  shared: string[];
  /** 다른 모듈을 모아 조립하는 모듈. 이 모듈이 가져다 쓰는 것은 리뷰 후보가 아니에요. */
  composers: string[];
  /** 흐름을 거슬러도 된다고 적어 둔 (가져다 쓰는 쪽, 대상 파일) 목록들의 위치. 없으면 빈 배열. */
  allowlist: AllowlistSource[];
  /** 다른 모듈에서 가져다 써도 되는 파일(화면, provider 등). 파일 이름이나 그 파일이 정의한 심볼로 골라요. */
  openToOtherModules: { files: string[]; symbols: SymbolMatcher[] };
  /** 쓰이지 않는 공개 이름 검사. `private`에 맞는 이름은 공개가 아니에요. `ignore`는 일부러 빼는 이름(진입점 등). */
  unused: { private: string; ignore: string[] };
}

/**
 * 허용 목록: 파일(`file`, 저장소 뿌리 기준) 안에서 `block` 정규식의 첫 묶음을 잘라 내고(없으면 파일 전체),
 * 거기서 `item` 정규식의 첫 묶음마다 항목 하나(저장소 뿌리 기준 경로)를 읽어요.
 * 테스트 코드 안의 상수처럼, 저장소가 이미 쓰는 목록을 그대로 읽으려는 거예요.
 * 설정에 `items`로 목록을 바로 적어도 돼요.
 *
 * 허용은 (가져다 쓰는 쪽, 대상) 쌍이에요. `from`이 이 목록의 대상을 가져다 써도 되는 쪽(모듈 이름이나 파일 glob)이고,
 * 다른 모듈이 같은 대상을 거꾸로 가져오면 새 위반이에요. 가져다 쓰는 쪽마다 목록이 다르면 `allowlist`를 배열로 적어요.
 */
export interface AllowlistSource {
  /** 이 목록의 대상을 가져다 써도 되는 쪽. 모듈 이름(`modules`)이나 파일 glob(`files`, 저장소 뿌리 기준) 중 하나라도 맞으면 돼요. */
  from: { modules?: string[]; files?: string[] };
  file?: string;
  block?: string;
  item?: string;
  items?: string[];
}

/** 설정 파일이 없을 때: 뿌리 바로 아래 폴더 하나가 모듈 하나예요. */
const DEFAULTS: Omit<RepoConfig, 'path'> = {
  modules: [{ path: '{module}/**' }],
  shared: [],
  composers: [],
  allowlist: [],
  openToOtherModules: { files: [], symbols: [] },
  unused: { private: '_*', ignore: ['main'] },
};

const toSlash = (p: string) => p.replaceAll('\\', '/');

/**
 * 저장소 설정을 읽어요. `explicitPath`가 있으면 그 파일을, 없으면 저장소 뿌리의 `.code-atlas.json`을,
 * 그것도 없으면 기본 설정을 써요. 빠진 칸은 기본값으로 채워요.
 */
export function loadRepoConfig(repoRoot: string, explicitPath?: string): RepoConfig {
  const file = explicitPath ? resolve(explicitPath) : join(repoRoot, CONFIG_FILE);
  if (!existsSync(file)) {
    if (explicitPath) throw new Error(`설정 파일이 없어요: ${file}`);
    return { path: null, ...DEFAULTS };
  }
  let raw: Partial<RepoConfig>;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<RepoConfig>;
  } catch (e) {
    throw new Error(`설정 파일을 읽지 못했어요: ${file}\n${e instanceof Error ? e.message : String(e)}`);
  }
  const rel = toSlash(relative(repoRoot, file));
  return {
    path: rel.startsWith('..') ? toSlash(file) : rel,
    modules: raw.modules ?? DEFAULTS.modules,
    shared: raw.shared ?? DEFAULTS.shared,
    composers: raw.composers ?? DEFAULTS.composers,
    allowlist: allowlistOf(raw.allowlist),
    openToOtherModules: {
      files: raw.openToOtherModules?.files ?? [],
      symbols: raw.openToOtherModules?.symbols ?? [],
    },
    unused: {
      private: raw.unused?.private ?? DEFAULTS.unused.private,
      ignore: raw.unused?.ignore ?? DEFAULTS.unused.ignore,
    },
  };
}

/** 설정의 `allowlist`(객체 하나 또는 배열)를 배열로 맞추고, 가져다 쓰는 쪽(`from`)이 적혔는지 봐요. */
function allowlistOf(raw: unknown): AllowlistSource[] {
  if (raw === undefined || raw === null) return [];
  const sources = (Array.isArray(raw) ? raw : [raw]) as AllowlistSource[];
  for (const s of sources) {
    if (!s.from?.modules?.length && !s.from?.files?.length) {
      throw new Error(
        `허용 목록에 가져다 쓰는 쪽(from.modules 또는 from.files)이 없어요. 허용은 (가져다 쓰는 쪽, 대상) 쌍이에요: ${JSON.stringify(s)}`,
      );
    }
  }
  return sources;
}

/** 허용 목록 하나의 대상(저장소 뿌리 기준 경로)을 읽어요. 목록 파일이 없으면 오류예요. */
export function readAllowlist(repoRoot: string, source: AllowlistSource): string[] {
  const items = [...(source.items ?? [])];
  if (source.file) {
    const file = join(repoRoot, source.file);
    if (!existsSync(file)) throw new Error(`허용 목록 파일이 없어요: ${source.file}`);
    let text = readFileSync(file, 'utf8');
    if (source.block) {
      const m = new RegExp(source.block).exec(text);
      if (!m) throw new Error(`허용 목록 파일에서 block 정규식에 맞는 곳을 찾지 못했어요: ${source.file}`);
      text = m[1] ?? m[0];
    }
    const item = new RegExp(source.item ?? `^\\s*(\\S+)\\s*$`, 'gm');
    for (const m of text.matchAll(item)) if (m[1]) items.push(m[1]);
  }
  return items;
}

/** 저장소 설정을 고르는 질의 인자(check, impact, clusters가 같이 써요). 명령줄 `--config`, MCP `config`. */
export const CONFIG_PARAM: Param = {
  name: 'config',
  type: 'string',
  description: '저장소 설정 파일 경로(모듈 기준). 없으면 색인한 저장소 뿌리의 .code-atlas.json, 그것도 없으면 기본 설정(뿌리 바로 아래 폴더 하나가 모듈 하나).',
};
