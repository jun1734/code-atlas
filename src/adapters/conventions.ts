// 언어 관례(*-conventions.ts)가 함께 쓰는 꼴. 표시(정규식) 자체는 언어마다 달라서 각 관례 파일에 있어요.

/** 생성기 표시를 찾는 파일 머리의 길이(글자 수). 생성기는 표시를 파일 맨 앞에 달아요. */
export const HEAD_LENGTH = 1000;

/** 파일 머리(앞 HEAD_LENGTH자)에 생성기 표시가 있는지. text는 파일 글 전체여도, 이미 자른 머리여도 돼요. */
export function hasGeneratedMark(text: string, mark: RegExp): boolean {
  return mark.test(text.slice(0, HEAD_LENGTH));
}
