// Dart 관례: 어느 파일이 생성된 코드·빌드 산출물이고 어느 파일이 테스트인지.
// 정밀 어댑터(dart-refine.ts)와 추정 층의 Dart 규칙(src/inferred/dart.ts)이 같은 규칙을 써요.
import type { FileRole } from '../facts.ts';

/** build_runner 등이 만드는 파일의 꼬리. */
const GENERATED_SUFFIXES = ['.g.dart', '.freezed.dart', '.mocks.dart', '.gr.dart', '.gen.dart'];
/** Dart 생성기가 파일 머리에 다는 표시. */
const GENERATED_MARK = /GENERATED CODE - DO NOT MODIFY BY HAND|^\/\/ *@generated/m;
/** 패키지 뿌리 바로 아래의 빌드 산출물·도구 폴더. */
const OUTPUT_DIRS = ['build/', '.dart_tool/'];
/** 패키지 뿌리 바로 아래의 테스트 폴더. */
const TEST_DIRS = ['test/', 'integration_test/', 'test_driver/'];

/**
 * 생성된 코드나 빌드 산출물인지.
 * @param inPackage 패키지 뿌리 기준 경로
 * @param head 파일 머리 글(앞 1000자면 충분해요). 읽지 못하면 빈 글.
 */
export function isGeneratedDart(inPackage: string, head: string): boolean {
  if (OUTPUT_DIRS.some((d) => inPackage.startsWith(d))) return true;
  if (GENERATED_SUFFIXES.some((s) => inPackage.endsWith(s))) return true;
  return GENERATED_MARK.test(head.slice(0, 1000));
}

/** 테스트 파일인지. inPackage는 패키지 뿌리 기준 경로. */
export function dartRole(inPackage: string): FileRole {
  return TEST_DIRS.some((d) => inPackage.startsWith(d)) || inPackage.endsWith('_test.dart') ? 'test' : 'app';
}
