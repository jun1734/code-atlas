// scip-python 0.6.8을 Windows에서 돌리기 위한 덧대기(node -r로 먼저 불러요).
// scip-python은 시작할 때 `new RegExp(path.sep, 'g')`를 만드는데, Windows의 path.sep '\'는 정규식으로 잘못된 글이라
// 바로 SyntaxError로 멈춰요. 그 한 글('\' 하나)만 '\\'(역슬래시 글자 하나에 맞는 정규식)로 바꿔 줘요.
// 다른 정규식은 건드리지 않아요. Linux에서는 path.sep이 '/'라 아무 일도 하지 않아요.
'use strict';
const Original = globalThis.RegExp;
const fix = (args) => (args[0] === '\\' ? ['\\\\', ...args.slice(1)] : args);
globalThis.RegExp = new Proxy(Original, {
  construct: (target, args) => new target(...fix(args)),
  apply: (target, self, args) => target(...fix(args)),
});
