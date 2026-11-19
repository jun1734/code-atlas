// 그래프 저장소: 언어와 무관한 스키마를 SQLite 파일 하나에 둬요.
// 바깥에는 "사실을 넣는다"(applyFacts)와 "그래프에 묻는다"(아래 질의 함수)만 보여요.
// 스키마 설명은 docs/architecture.md에 있어요.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Confidence, Facts, FileRole, RelationFact, RelationKind, SymbolFact, SymbolKind } from '../facts.ts';

const SCHEMA_VERSION = '3';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  language TEXT NOT NULL,
  role TEXT NOT NULL,
  hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS symbols (
  id INTEGER PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  qualified_name TEXT NOT NULL,
  kind TEXT NOT NULL,
  file_id INTEGER NOT NULL REFERENCES files(id),
  line INTEGER NOT NULL,
  col INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  end_col INTEGER NOT NULL,
  parent_key TEXT,
  confidence TEXT NOT NULL,
  source TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS symbols_name ON symbols(name);
CREATE INDEX IF NOT EXISTS symbols_qualified_name ON symbols(qualified_name);
CREATE INDEX IF NOT EXISTS symbols_file ON symbols(file_id);
CREATE TABLE IF NOT EXISTS relations (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  from_file_id INTEGER NOT NULL REFERENCES files(id),
  from_symbol_key TEXT,
  line INTEGER NOT NULL,
  col INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  end_col INTEGER NOT NULL,
  to_symbol_key TEXT,
  to_path TEXT,
  confidence TEXT NOT NULL,
  kind_confidence TEXT NOT NULL,
  source TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS relations_to_symbol ON relations(to_symbol_key);
CREATE INDEX IF NOT EXISTS relations_to_path ON relations(to_path);
CREATE INDEX IF NOT EXISTS relations_from_file ON relations(from_file_id);
`;

export interface IndexMeta {
  repoRoot: string;
  /** 색인한 커밋. git 저장소가 아니면 null. */
  commit: string | null;
  /** 색인할 때 작업 트리에서 커밋과 달랐던 파일들의 지문(src/freshness.ts). git 저장소가 아니면 null. */
  worktree: string | null;
  indexedAt: string;
}

/** 한 번 넣을 때 파일 단위로 무엇이 바뀌었는지. */
export interface FileChanges {
  /** 그래프에 없던 파일. */
  added: number;
  /** 사실이 달라져 다시 넣은 파일. */
  modified: number;
  /** 사실에서 사라져 뺀 파일. */
  removed: number;
  /** 사실이 같아 건드리지 않은 파일. */
  unchanged: number;
}

/** 언어 하나의 개수와 관계의 정밀/추정 비율(0~1, 관계가 없으면 null). */
export interface LanguageCounts {
  files: number;
  symbols: number;
  relations: number;
  precise: number | null;
  inferred: number | null;
}

interface FilePart {
  language: string;
  role: FileRole;
  symbols: SymbolFact[];
  relations: RelationFact[];
  /** 이 파일의 사실 전체의 해시. */
  hash: string;
}

/** 사실을 파일별로 나누고 파일마다 해시를 내요. 심볼은 정의된 파일, 관계는 적힌 파일에 속해요. */
function groupByFile(facts: Facts): Map<string, FilePart> {
  const parts = new Map<string, FilePart>();
  for (const f of facts.files) {
    if (!parts.has(f.path)) parts.set(f.path, { language: f.language, role: f.role, symbols: [], relations: [], hash: '' });
  }
  const part = (path: string) => {
    const p = parts.get(path);
    if (!p) throw new Error(`사실에 없는 파일을 가리켜요: ${path}`);
    return p;
  };
  for (const s of facts.symbols) part(s.path).symbols.push(s);
  for (const r of facts.relations) part(r.from.path).relations.push(r);
  for (const p of parts.values()) {
    p.hash = createHash('sha256').update(JSON.stringify([p.language, p.role, p.symbols, p.relations])).digest('hex');
  }
  return parts;
}

export interface Location {
  path: string;
  /** 1부터 세는 줄. */
  line: number;
  /** 1부터 세는 열. */
  column: number;
}

export interface SymbolRow {
  key: string;
  name: string;
  qualifiedName: string;
  kind: SymbolKind;
  definition: Location;
  confidence: Confidence;
  source: string;
}

export interface UseRow extends Location {
  /** 사용처가 있는 파일의 역할(앱 코드인지 테스트인지). */
  role: FileRole;
  kind: RelationKind;
  /** kind를 색인기가 알려 줬으면(또는 색인기의 사실로 확인했으면) precise, 문법으로 가렸으면 inferred. */
  kindConfidence: Confidence;
  /** 사용처를 감싸는 심볼의 이름. 파일 최상위면 없음. */
  in?: string;
  confidence: Confidence;
  source: string;
}

/** 사용처를 고르는 조건. 뒤의 질의(impact는 테스트 파일만, trace는 호출만)가 그래프에서 다시 물을 때 써요. */
export interface UseFilter {
  roles?: FileRole[];
  kinds?: RelationKind[];
}

export interface FileRow {
  path: string;
  language: string;
  role: FileRole;
}

/** 다른 파일과의 연결(가져오기, 쓰기). 여러 관계를 묶은 것이라 하나라도 추정이면 inferred예요. */
export interface FileLink {
  path: string;
  role: FileRole;
  confidence: Confidence;
  /** 관계를 낸 색인기들(쉼표로 이어요). */
  source: string;
}

/** 저장소 안의 0부터 세는 줄·열을 답에 쓰는 1부터 세는 위치로. */
function toLocation(path: string, line: number, col: number): Location {
  return { path, line: line + 1, column: col + 1 };
}

export class GraphStore {
  private readonly db: DatabaseSync;

  private constructor(db: DatabaseSync) {
    this.db = db;
  }

  /** 색인 파일을 열어요. 없으면 만들어요. 스키마 버전이 다른 옛 색인이면 비우고 새로 만들어요(다음 넣기가 처음부터 색인이 돼요). */
  static open(path: string): GraphStore {
    mkdirSync(dirname(path), { recursive: true });
    const db = new DatabaseSync(path);
    const hasMeta = db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'`).get();
    const version = hasMeta
      ? (db.prepare(`SELECT value FROM meta WHERE key = 'schema'`).get() as { value: string } | undefined)?.value
      : undefined;
    if (hasMeta && version !== SCHEMA_VERSION) {
      db.exec('DROP TABLE IF EXISTS relations; DROP TABLE IF EXISTS symbols; DROP TABLE IF EXISTS files; DROP TABLE IF EXISTS meta;');
    }
    db.exec(SCHEMA);
    return new GraphStore(db);
  }

  /** 이미 있는 색인 파일만 열어요. 파일이 없으면 null, 스키마 버전이 다르면 다시 색인하라는 오류를 던져요. */
  static openExisting(path: string): GraphStore | null {
    if (!existsSync(path)) return null;
    const db = new DatabaseSync(path, { readOnly: true });
    const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema'`).get() as { value: string } | undefined;
    if (row?.value !== SCHEMA_VERSION) {
      db.close();
      throw new Error(
        `색인의 스키마 버전(${row?.value ?? '없음'})이 이 도구(${SCHEMA_VERSION})와 달라요. code-atlas index 로 다시 색인해요: ${path}`,
      );
    }
    return new GraphStore(db);
  }

  close(): void {
    this.db.close();
  }

  /**
   * 저장소 전체의 사실을 받아, 그래프와 달라진 파일의 사실만 바꿔요(한 트랜잭션).
   * 파일마다 "그 파일의 사실"(파일 자신, 그 파일에 정의된 심볼, 그 파일에서 나가는 관계)의 해시를 두고,
   * 해시가 같은 파일은 건드리지 않아요. 파일 내용이 그대로여도 가리키는 심볼의 열쇠가 바뀌면
   * (다른 파일의 이름 바꾸기 등) 사실이 달라지니 다시 반영해요.
   */
  applyFacts(facts: Facts, meta: IndexMeta): FileChanges {
    const db = this.db;
    const byFile = groupByFile(facts);
    const stored = new Map(
      (db.prepare('SELECT id, path, hash FROM files').all() as { id: number; path: string; hash: string }[]).map((r) => [r.path, r]),
    );
    const changes: FileChanges = { added: 0, modified: 0, removed: 0, unchanged: 0 };

    db.exec('BEGIN');
    try {
      db.exec('DELETE FROM meta');
      const putMeta = db.prepare('INSERT INTO meta(key, value) VALUES (?, ?)');
      putMeta.run('schema', SCHEMA_VERSION);
      putMeta.run('repoRoot', meta.repoRoot);
      if (meta.commit) putMeta.run('commit', meta.commit);
      if (meta.worktree) putMeta.run('worktree', meta.worktree);
      putMeta.run('indexedAt', meta.indexedAt);

      const dropSymbols = db.prepare('DELETE FROM symbols WHERE file_id = ?');
      const dropRelations = db.prepare('DELETE FROM relations WHERE from_file_id = ?');
      const dropFile = db.prepare('DELETE FROM files WHERE id = ?');
      // 사실에서 사라진 파일
      for (const [path, row] of stored) {
        if (byFile.has(path)) continue;
        dropRelations.run(row.id);
        dropSymbols.run(row.id);
        dropFile.run(row.id);
        changes.removed++;
      }

      const putFile = db.prepare('INSERT INTO files(path, language, role, hash) VALUES (?, ?, ?, ?)');
      const updateFile = db.prepare('UPDATE files SET language = ?, role = ?, hash = ? WHERE id = ?');
      const putSymbol = db.prepare(
        `INSERT OR IGNORE INTO symbols(key, name, qualified_name, kind, file_id, line, col, end_line, end_col, parent_key, confidence, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const putRelation = db.prepare(
        `INSERT INTO relations(kind, from_file_id, from_symbol_key, line, col, end_line, end_col, to_symbol_key, to_path, confidence, kind_confidence, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      // 새로 생겼거나 사실이 달라진 파일. 경로 순으로 넣어 같은 사실이면 같은 그래프가 되게 해요.
      for (const [path, part] of [...byFile].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
        const old = stored.get(path);
        if (old?.hash === part.hash) {
          changes.unchanged++;
          continue;
        }
        let fileId: number;
        if (old) {
          dropRelations.run(old.id);
          dropSymbols.run(old.id);
          updateFile.run(part.language, part.role, part.hash, old.id);
          fileId = old.id;
          changes.modified++;
        } else {
          fileId = Number(putFile.run(path, part.language, part.role, part.hash).lastInsertRowid);
          changes.added++;
        }
        for (const s of part.symbols) {
          putSymbol.run(
            s.key,
            s.name,
            s.qualifiedName,
            s.kind,
            fileId,
            s.range.startLine,
            s.range.startColumn,
            s.range.endLine,
            s.range.endColumn,
            s.parentKey ?? null,
            s.confidence,
            s.source,
          );
        }
        for (const r of part.relations) {
          putRelation.run(
            r.kind,
            fileId,
            r.from.symbolKey ?? null,
            r.from.range.startLine,
            r.from.range.startColumn,
            r.from.range.endLine,
            r.from.range.endColumn,
            'symbolKey' in r.to ? r.to.symbolKey : null,
            'path' in r.to ? r.to.path : null,
            r.confidence,
            r.kindConfidence,
            r.source,
          );
        }
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    return changes;
  }

  meta(): IndexMeta {
    const rows = this.db.prepare('SELECT key, value FROM meta').all() as { key: string; value: string }[];
    const m = new Map(rows.map((r) => [r.key, r.value]));
    return {
      repoRoot: m.get('repoRoot') ?? '',
      commit: m.get('commit') ?? null,
      worktree: m.get('worktree') ?? null,
      indexedAt: m.get('indexedAt') ?? '',
    };
  }

  /** 언어별 파일·심볼·관계 수와 관계의 정밀/추정 비율. 관계와 심볼의 언어는 그것이 적힌 파일의 언어예요. */
  languages(): Record<string, LanguageCounts> {
    const out: Record<string, LanguageCounts> = {};
    const files = this.db.prepare('SELECT language, COUNT(*) AS n FROM files GROUP BY language ORDER BY language').all() as { language: string; n: number }[];
    for (const f of files) out[f.language] = { files: Number(f.n), symbols: 0, relations: 0, precise: null, inferred: null };
    const symbols = this.db
      .prepare('SELECT f.language, COUNT(*) AS n FROM symbols s JOIN files f ON f.id = s.file_id GROUP BY f.language')
      .all() as { language: string; n: number }[];
    for (const s of symbols) out[s.language]!.symbols = Number(s.n);
    const relations = this.db
      .prepare(
        `SELECT f.language, COUNT(*) AS n, SUM(r.confidence = 'precise') AS precise
         FROM relations r JOIN files f ON f.id = r.from_file_id GROUP BY f.language`,
      )
      .all() as { language: string; n: number; precise: number }[];
    const ratio = (part: number, whole: number) => Math.round((part / whole) * 1000) / 1000;
    for (const r of relations) {
      const lang = out[r.language]!;
      lang.relations = Number(r.n);
      lang.precise = ratio(Number(r.precise), lang.relations);
      lang.inferred = ratio(lang.relations - Number(r.precise), lang.relations);
    }
    return out;
  }

  counts(): { files: number; symbols: number; relations: number } {
    const count = (table: string) =>
      Number((this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
    return { files: count('files'), symbols: count('symbols'), relations: count('relations') };
  }

  /** 열쇠, 바깥 타입을 붙인 이름, 짧은 이름 순으로 맞는 심볼을 찾아요. 처음 맞는 단계의 결과만 돌려줘요. */
  findSymbols(query: string): SymbolRow[] {
    for (const column of ['key', 'qualified_name', 'name']) {
      const rows = this.db
        .prepare(
          `SELECT ${SYMBOL_COLUMNS}
           FROM symbols s JOIN files f ON f.id = s.file_id
           WHERE s.${column} = ? AND s.kind NOT IN ('file', 'parameter')
           ORDER BY f.path, s.line, s.col`,
        )
        .all(query) as unknown as SymbolSqlRow[];
      if (rows.length > 0) return rows.map(toSymbolRow);
    }
    return [];
  }

  /**
   * 심볼의 사용처. 전체 개수, 역할별 개수, 앞에서부터 limit개.
   * 앱 코드의 사용처가 먼저, 테스트의 사용처가 뒤에 와요(각각 경로, 줄, 열 순).
   * filter로 역할(app/test)이나 관계 종류(call 등)를 고를 수 있어요. 개수도 고른 것만 세요.
   */
  usesOf(key: string, limit: number, filter: UseFilter = {}): { total: number; byRole: Record<FileRole, number>; items: UseRow[] } {
    const where = ['r.to_symbol_key = ?'];
    const params: (string | number)[] = [key];
    if (filter.roles) {
      where.push(`f.role IN (${filter.roles.map(() => '?').join(', ')})`);
      params.push(...filter.roles);
    }
    if (filter.kinds) {
      where.push(`r.kind IN (${filter.kinds.map(() => '?').join(', ')})`);
      params.push(...filter.kinds);
    }
    const from = `FROM relations r JOIN files f ON f.id = r.from_file_id WHERE ${where.join(' AND ')}`;
    const counts = this.db.prepare(`SELECT f.role AS role, COUNT(*) AS n ${from} GROUP BY f.role`).all(...params) as { role: FileRole; n: number }[];
    const byRole: Record<FileRole, number> = { app: 0, test: 0 };
    for (const c of counts) byRole[c.role] = Number(c.n);
    const rows = this.db
      .prepare(
        `SELECT f.path, f.role, r.line, r.col, r.kind, r.kind_confidence AS kindConfidence, r.confidence, r.source,
                (SELECT s.qualified_name FROM symbols s WHERE s.key = r.from_symbol_key) AS inName
         ${from}
         ORDER BY CASE f.role WHEN 'app' THEN 0 ELSE 1 END, f.path, r.line, r.col
         LIMIT ?`,
      )
      .all(...params, limit) as {
      path: string;
      role: FileRole;
      line: number;
      col: number;
      kind: RelationKind;
      kindConfidence: Confidence;
      confidence: Confidence;
      source: string;
      inName: string | null;
    }[];
    return {
      total: byRole.app + byRole.test,
      byRole,
      items: rows.map((r) => ({
        ...toLocation(r.path, r.line, r.col),
        role: r.role,
        kind: r.kind,
        kindConfidence: r.kindConfidence,
        ...(r.inName ? { in: r.inName } : {}),
        confidence: r.confidence,
        source: r.source,
      })),
    };
  }

  /** 경로가 정확히 맞는 파일. 없으면 null. */
  findFile(path: string): FileRow | null {
    const row = this.db.prepare('SELECT path, language, role FROM files WHERE path = ?').get(path) as FileRow | undefined;
    return row ? { path: row.path, language: row.language, role: row.role } : null;
  }

  /** 파일이 정의하는 이름(파일과 매개변수는 빼요). 위치 순. */
  definedIn(path: string): SymbolRow[] {
    const rows = this.db
      .prepare(
        `SELECT ${SYMBOL_COLUMNS}
         FROM symbols s JOIN files f ON f.id = s.file_id
         WHERE f.path = ? AND s.kind NOT IN ('file', 'parameter')
         ORDER BY s.line, s.col`,
      )
      .all(path) as unknown as SymbolSqlRow[];
    return rows.map(toSymbolRow);
  }

  /** 이 파일이 가져오거나 다시 내보내는 저장소 안의 파일(import 관계). */
  importsOf(path: string): FileLink[] {
    return this.links(
      `SELECT t.path, t.role, r.confidence, r.source
       FROM relations r JOIN files f ON f.id = r.from_file_id JOIN files t ON t.path = r.to_path
       WHERE r.kind = 'import' AND f.path = ?`,
      path,
    );
  }

  /** 이 파일을 가져오거나 다시 내보내는 파일(import 관계). */
  importersOf(path: string): FileLink[] {
    return this.links(
      `SELECT f.path, f.role, r.confidence, r.source
       FROM relations r JOIN files f ON f.id = r.from_file_id JOIN files t ON t.path = r.to_path
       WHERE r.kind = 'import' AND t.path = ?`,
      path,
    );
  }

  /**
   * 이 파일이 정의한 이름을 쓰는 다른 파일과 사용처 수. 어느 파일을 거쳐 가져왔든(barrel 포함) 이름으로 이어져요.
   * 앱 코드가 먼저, 테스트가 뒤에 와요.
   */
  usersOf(path: string): (FileLink & { uses: number })[] {
    const rows = this.db
      .prepare(
        `SELECT u.path, u.role, MIN(r.confidence) AS minConfidence, MAX(r.confidence) AS maxConfidence,
                GROUP_CONCAT(DISTINCT r.source) AS sources, COUNT(*) AS n
         FROM relations r
         JOIN symbols s ON s.key = r.to_symbol_key
         JOIN files d ON d.id = s.file_id
         JOIN files u ON u.id = r.from_file_id
         WHERE d.path = ? AND u.id != d.id
         GROUP BY u.id
         ORDER BY CASE u.role WHEN 'app' THEN 0 ELSE 1 END, u.path`,
      )
      .all(path) as unknown as LinkSqlRow[];
    return rows.map((r) => ({ ...toLink(r), uses: Number(r.n) }));
  }

  /** 색인된 파일 경로 전부(경로순). */
  filePaths(): string[] {
    return (this.db.prepare('SELECT path FROM files ORDER BY path').all() as { path: string }[]).map((r) => r.path);
  }

  /** 정의된 심볼 전부(파일, 매개변수 제외)와 바로 바깥 심볼. 경로와 위치순. */
  definitions(): DefinitionRow[] {
    const rows = this.db
      .prepare(
        `SELECT ${SYMBOL_COLUMNS}, s.parent_key AS parentKey
         FROM symbols s JOIN files f ON f.id = s.file_id
         WHERE s.kind NOT IN ('file', 'parameter')
         ORDER BY f.path, s.line, s.col`,
      )
      .all() as unknown as (SymbolSqlRow & { parentKey: string | null })[];
    return rows.map((r) => ({ ...toSymbolRow(r), parentKey: r.parentKey }));
  }

  /** 사용처(어느 종류의 관계든)가 하나라도 있는 심볼의 열쇠. */
  referencedKeys(): Set<string> {
    const rows = this.db
      .prepare('SELECT DISTINCT to_symbol_key AS key FROM relations WHERE to_symbol_key IS NOT NULL')
      .all() as { key: string }[];
    return new Set(rows.map((r) => r.key));
  }

  /** 파일 사이 관계를 파일별로 묶어요. 앱 코드가 먼저, 테스트가 뒤에 와요. */
  private links(sql: string, path: string): FileLink[] {
    const rows = this.db
      .prepare(
        `SELECT path, role, MIN(confidence) AS minConfidence, MAX(confidence) AS maxConfidence,
                GROUP_CONCAT(DISTINCT source) AS sources
         FROM (${sql})
         GROUP BY path
         ORDER BY CASE role WHEN 'app' THEN 0 ELSE 1 END, path`,
      )
      .all(path) as unknown as LinkSqlRow[];
    return rows.map(toLink);
  }
}

const SYMBOL_COLUMNS = 's.key, s.name, s.qualified_name AS qualifiedName, s.kind, f.path, s.line, s.col, s.confidence, s.source';

interface SymbolSqlRow {
  key: string;
  name: string;
  qualifiedName: string;
  kind: SymbolKind;
  path: string;
  line: number;
  col: number;
  confidence: Confidence;
  source: string;
}

function toSymbolRow(r: SymbolSqlRow): SymbolRow {
  return {
    key: r.key,
    name: r.name,
    qualifiedName: r.qualifiedName,
    kind: r.kind,
    definition: toLocation(r.path, r.line, r.col),
    confidence: r.confidence,
    source: r.source,
  };
}

interface LinkSqlRow {
  path: string;
  role: FileRole;
  /** 'inferred' < 'precise'(글자 순)라서 MIN이 inferred면 하나라도 추정이에요. */
  minConfidence: Confidence;
  maxConfidence: Confidence;
  sources: string;
  n?: number;
}

function toLink(r: LinkSqlRow): FileLink {
  return {
    path: r.path,
    role: r.role,
    confidence: r.minConfidence,
    source: r.sources.split(',').sort().join(','),
  };
}

/** 정의 하나와 바로 바깥 심볼(최상위 선언이면 null). */
export interface DefinitionRow extends SymbolRow {
  parentKey: string | null;
}
