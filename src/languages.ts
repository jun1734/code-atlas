// 언어 목록: 언어마다 정밀 어댑터(SCIP 색인기)와 추정 규칙(Tree-sitter). 둘 중 하나만 있어도 돼요.
// 새 언어는 여기 한 줄을 더해요. 색인기(src/indexer.ts)가 정밀 → 추정 순서로 돌리고, 정밀이 없거나 실패하면 추정으로 메워요.
import { dartAdapter } from './adapters/dart.ts';
import { pythonAdapter } from './adapters/python.ts';
import { typescriptAdapter } from './adapters/typescript.ts';
import type { LanguageAdapter } from './facts.ts';
import { dartInferred } from './inferred/dart.ts';
import type { InferredLanguage } from './inferred/layer.ts';
import { pythonInferred } from './inferred/python.ts';
import { typescriptInferred } from './inferred/typescript.ts';

export interface LanguageSetup {
  language: string;
  /** 정밀 어댑터(SCIP 색인기). 없으면 그 언어는 늘 추정 층으로 색인해요. */
  precise?: LanguageAdapter;
  /** 추정 규칙. 없으면 정밀 색인기가 없을 때 그 언어를 건너뛰어요(안내는 나와요). */
  inferred?: InferredLanguage;
}

export const LANGUAGES: LanguageSetup[] = [
  { language: 'dart', precise: dartAdapter, inferred: dartInferred },
  { language: 'python', precise: pythonAdapter, inferred: pythonInferred },
  // JavaScript와 TypeScript는 한 프로그램으로 함께 읽어야 서로 가져다 쓰는 것이 이어져서 한 줄이에요.
  // 파일의 language는 확장자대로 javascript 또는 typescript예요.
  { language: 'typescript', precise: typescriptAdapter, inferred: typescriptInferred },
];

/** 파일 사실의 language(정밀 어댑터의 language와 같은 이름)에 맞는 추정 규칙. 없으면 undefined. */
export function inferredFor(language: string): InferredLanguage | undefined {
  return LANGUAGES.find((l) => l.language === language)?.inferred;
}
