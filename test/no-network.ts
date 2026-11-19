// 네트워크 차단 장치: 테스트가 도구 프로세스에 `--import`로 달아요.
// 프로세스가 네트워크(TCP/UDP 연결, DNS 조회, fetch)를 쓰려 하면 stderr에 적고 종료 코드 97로 바로 멈춰요.
// 오류를 던지기만 하면 도구가 삼킬 수 있어서, 놓칠 수 없게 프로세스를 끝내요.
// 같은 컴퓨터 안의 파이프(stdio, 이름 있는 파이프·유닉스 소켓)는 네트워크가 아니라서 막지 않아요.
import dgram from 'node:dgram';
import dns from 'node:dns';
import net from 'node:net';

function block(what: string): never {
  process.stderr.write(`[no-network] 네트워크를 쓰려 했어요: ${what}\n`);
  process.exit(97);
}

const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
  const first = args[0];
  const isPipe =
    typeof first === 'string' ||
    (Array.isArray(first) && typeof first[0] === 'object' && first[0] !== null && 'path' in first[0]) ||
    (typeof first === 'object' && first !== null && !Array.isArray(first) && 'path' in first);
  if (!isPipe) block(`net.Socket.connect ${JSON.stringify(first)}`);
  return (connect as (...a: unknown[]) => net.Socket).apply(this, args);
} as typeof connect;

dgram.Socket.prototype.send = (() => block('dgram.Socket.send')) as never;
dns.lookup = (() => block('dns.lookup')) as never;
dns.promises.lookup = (() => block('dns.promises.lookup')) as never;
for (const name of ['resolve', 'resolve4', 'resolve6', 'resolveAny'] as const) {
  (dns as Record<string, unknown>)[name] = () => block(`dns.${name}`);
}
globalThis.fetch = (() => block('fetch')) as never;
