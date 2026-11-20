// Python 정밀 어댑터: 저장소 안의 Python 프로젝트마다 scip-python(Pyright 기반, MIT)을 돌리고 SCIP 색인을 사실로 옮겨요.
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFacts, emptyFacts, IndexerMissing, type LanguageAdapter } from '../facts.ts';
import { listRepoFiles } from '../inferred/layer.ts';
import { runOrThrow } from '../run.ts';
import { scipToFacts } from '../scip/to-facts.ts';
import { isExcludedPython, ownsPython, projectOf, pythonProjects } from './python-conventions.ts';
import { refinePythonFacts } from './python-refine.ts';

/** 시험한 scip-python 버전. package.json의 의존성도 이 버전이에요. */
const SCIP_PYTHON_VERSION = '0.6.8';

export const SCIP_PYTHON_INSTALL = `npm install @sourcegraph/scip-python@${SCIP_PYTHON_VERSION} (code-atlas 폴더에서. npm ci면 함께 깔려요)`;

const require = createRequire(import.meta.url);
/** Windows에서 scip-python이 시작하자마자 멈추는 것을 막는 덧대기(scip-python-windows.cjs에 이유가 있어요). */
const WINDOWS_PATCH = fileURLToPath(new URL('./scip-python-windows.cjs', import.meta.url));

/** code-atlas의 의존성으로 깔린 scip-python의 시작 파일. 없으면 null. */
function scipPythonEntry(): string | null {
  try {
    return require.resolve('@sourcegraph/scip-python');
  } catch {
    return null;
  }
}

/**
 * scip-python 심볼은 OS와 무관해요(모듈 이름은 점으로 적어요). 고칠 것은 두 가지예요.
 * - 문서 경로(relative_path)가 Windows에서 '\'로 나와요 → '/'.
 * - 타입 표기가 붙은 모듈 수준 변수(`shippingFee: Final = 3000`)를 `shippingFee.shippingFee.`로 적어요 → `shippingFee.`.
 */
const normalize = (s: string) => s.replaceAll('\\', '/').replace(/^(.*[/#])([A-Za-z_]\w*)\.\2\.$/, '$1$2.');

/** 심볼 열쇠의 패키지 칸: 프로젝트 뿌리 경로(뿌리면 '.'). 공백은 SCIP 심볼의 칸 구분이라 '_'로 바꿔요. */
const projectName = (project: string) => (project === '' ? '.' : project.replace(/\s/g, '_'));

function readSource(root: string, path: string): string | null {
  try {
    return readFileSync(join(root, path), 'utf8');
  } catch {
    return null;
  }
}

export const pythonAdapter: LanguageAdapter = {
  name: 'scip-python',
  language: 'python',
  install: SCIP_PYTHON_INSTALL,

  applies: (repo) => [...listRepoFiles(repo)].some((p) => ownsPython(p) && !isExcludedPython(p, '')),

  async index(repo, workDir) {
    const entry = scipPythonEntry();
    if (!entry) throw new IndexerMissing(`scip-python을 찾지 못했어요.`, SCIP_PYTHON_INSTALL);
    const files = listRepoFiles(repo);
    const sources = [...files].filter((p) => ownsPython(p) && !isExcludedPython(p, ''));
    const all = pythonProjects(files);
    // Python 파일이 든 뿌리만 돌려요. 어느 뿌리에도 들지 않는 파일은 추정 층이 메워요.
    const projects = all.filter((p) => sources.some((f) => projectOf(f, all) === p));
    // 설치한 패키지 목록(pip)을 묻지 않게 빈 환경을 줘요. 저장소 밖 이름은 어차피 그래프에 넣지 않아요.
    const environment = join(workDir, 'python-environment.json');
    writeFileSync(environment, '[]');
    const readText = (path: string) => readSource(repo.root, path);
    const facts = emptyFacts();
    for (const [i, project] of projects.entries()) {
      const out = join(workDir, `python-${i}.scip`);
      // --cwd는 절대 경로로 줘요. 상대 경로면 scip-python 0.6.8이 파일을 하나도 내지 않아요(빈 색인).
      // 판(--project-version)은 고정해요. 주지 않으면 git 커밋이 들어가 커밋마다 심볼 열쇠가 바뀌어요.
      const cwd = resolve(repo.root, project);
      runOrThrow(
        process.execPath,
        ['-r', WINDOWS_PATCH, entry, 'index', '--cwd', cwd, '--output', out, '--environment', environment, '--project-name', projectName(project), '--project-version', '0', '--quiet'],
        cwd,
      );
      const raw = scipToFacts(out, { source: this.name, language: this.language, pathPrefix: project, normalize });
      appendFacts(facts, await refinePythonFacts(raw, { readText, files, projects: all }));
    }
    return facts;
  },
};
