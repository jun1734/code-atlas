// 그래프 저장소: 언어와 무관한 스키마를 SQLite 파일 하나에 둬요.
// 바깥에는 "사실을 넣는다"(replaceAll)와 "그래프에 묻는다"(아래 질의 함수)만 보여요.
// 스키마 설명은 docs/architecture.md에 있어요.
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Confidence, Facts, RelationKind, SymbolKind } from '../facts.ts';

const SCHEMA_VERSION = '1';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  language TEXT NOT NULL
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
  to_file_id INTEGER REFERENCES files(id),
  confidence TEXT NOT NULL,
  source TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS relations_to_symbol ON relations(to_symbol_key);
CREATE INDEX IF NOT EXISTS relations_to_file ON relations(to_file_id);
`;

export interface IndexMeta {
  repoRoot: string;
  /** 색인한 커밋. git 저장소가 아니면 null. */
  commit: string | null;
  indexedAt: string;
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
  kind: RelationKind;
  /** 사용처를 감싸는 심볼의 이름. 파일 최상위면 없음. */
  in?: string;
  confidence: Confidence;
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

  /** 색인 파일을 열어요. 없으면 만들어요. */
  static open(path: string): GraphStore {
    mkdirSync(dirname(path), { recursive: true });
    const db = new DatabaseSync(path);
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

  /** 그래프 전체를 이 사실로 바꿔요(한 트랜잭션). */
  replaceAll(facts: Facts, meta: IndexMeta): void {
    const db = this.db;
    db.exec('BEGIN');
    try {
      db.exec('DELETE FROM relations; DELETE FROM symbols; DELETE FROM files; DELETE FROM meta;');
      const putMeta = db.prepare('INSERT INTO meta(key, value) VALUES (?, ?)');
      putMeta.run('schema', SCHEMA_VERSION);
      putMeta.run('repoRoot', meta.repoRoot);
      if (meta.commit) putMeta.run('commit', meta.commit);
      putMeta.run('indexedAt', meta.indexedAt);

      const fileIds = new Map<string, number>();
      const putFile = db.prepare('INSERT INTO files(path, language) VALUES (?, ?)');
      for (const f of facts.files) {
        if (fileIds.has(f.path)) continue;
        fileIds.set(f.path, Number(putFile.run(f.path, f.language).lastInsertRowid));
      }
      const fileId = (path: string) => {
        const id = fileIds.get(path);
        if (id === undefined) throw new Error(`사실에 없는 파일을 가리켜요: ${path}`);
        return id;
      };

      const putSymbol = db.prepare(
        `INSERT OR IGNORE INTO symbols(key, name, qualified_name, kind, file_id, line, col, end_line, end_col, parent_key, confidence, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const s of facts.symbols) {
        putSymbol.run(
          s.key,
          s.name,
          s.qualifiedName,
          s.kind,
          fileId(s.path),
          s.range.startLine,
          s.range.startColumn,
          s.range.endLine,
          s.range.endColumn,
          s.parentKey ?? null,
          s.confidence,
          s.source,
        );
      }

      const putRelation = db.prepare(
        `INSERT INTO relations(kind, from_file_id, from_symbol_key, line, col, end_line, end_col, to_symbol_key, to_file_id, confidence, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const r of facts.relations) {
        const toPath = 'path' in r.to ? r.to.path : null;
        putRelation.run(
          r.kind,
          fileId(r.from.path),
          r.from.symbolKey ?? null,
          r.from.range.startLine,
          r.from.range.startColumn,
          r.from.range.endLine,
          r.from.range.endColumn,
          'symbolKey' in r.to ? r.to.symbolKey : null,
          toPath === null ? null : (fileIds.get(toPath) ?? null),
          r.confidence,
          r.source,
        );
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  meta(): IndexMeta {
    const rows = this.db.prepare('SELECT key, value FROM meta').all() as { key: string; value: string }[];
    const m = new Map(rows.map((r) => [r.key, r.value]));
    return { repoRoot: m.get('repoRoot') ?? '', commit: m.get('commit') ?? null, indexedAt: m.get('indexedAt') ?? '' };
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
          `SELECT s.key, s.name, s.qualified_name AS qualifiedName, s.kind, f.path, s.line, s.col, s.confidence, s.source
           FROM symbols s JOIN files f ON f.id = s.file_id
           WHERE s.${column} = ? AND s.kind NOT IN ('file', 'parameter')
           ORDER BY f.path, s.line, s.col`,
        )
        .all(query) as { key: string; name: string; qualifiedName: string; kind: SymbolKind; path: string; line: number; col: number; confidence: Confidence; source: string }[];
      if (rows.length > 0) {
        return rows.map((r) => ({
          key: r.key,
          name: r.name,
          qualifiedName: r.qualifiedName,
          kind: r.kind,
          definition: toLocation(r.path, r.line, r.col),
          confidence: r.confidence,
          source: r.source,
        }));
      }
    }
    return [];
  }

  /** 심볼의 사용처 전체 개수와 앞에서부터 limit개. */
  usesOf(key: string, limit: number): { total: number; items: UseRow[] } {
    const total = Number(
      (this.db.prepare('SELECT COUNT(*) AS n FROM relations WHERE to_symbol_key = ?').get(key) as { n: number }).n,
    );
    const rows = this.db
      .prepare(
        `SELECT f.path, r.line, r.col, r.kind, r.confidence, r.source, s.qualified_name AS inName
         FROM relations r
         JOIN files f ON f.id = r.from_file_id
         LEFT JOIN symbols s ON s.key = r.from_symbol_key
         WHERE r.to_symbol_key = ?
         ORDER BY f.path, r.line, r.col
         LIMIT ?`,
      )
      .all(key, limit) as { path: string; line: number; col: number; kind: RelationKind; confidence: Confidence; source: string; inName: string | null }[];
    return {
      total,
      items: rows.map((r) => ({
        ...toLocation(r.path, r.line, r.col),
        kind: r.kind,
        ...(r.inName ? { in: r.inName } : {}),
        confidence: r.confidence,
        source: r.source,
      })),
    };
  }

  /** 색인된 파일 경로 전부(경로순). */
  filePaths(): string[] {
    return (this.db.prepare('SELECT path FROM files ORDER BY path').all() as { path: string }[]).map((r) => r.path);
  }

  /** 저장소 안 파일 사이의 import 간선. 같은 (from, to) 쌍은 처음 적힌 줄(1부터) 하나로 모아요. */
  fileImports(): { from: string; to: string; line: number }[] {
    const rows = this.db
      .prepare(
        `SELECT f.path AS "from", t.path AS "to", MIN(r.line) AS line
         FROM relations r
         JOIN files f ON f.id = r.from_file_id
         JOIN files t ON t.id = r.to_file_id
         WHERE r.kind = 'import'
         GROUP BY f.path, t.path
         ORDER BY f.path, t.path`,
      )
      .all() as { from: string; to: string; line: number }[];
    return rows.map((r) => ({ from: r.from, to: r.to, line: r.line + 1 }));
  }

  /** 정의된 심볼 전부(파일, 매개변수 제외). 경로와 위치순. */
  definitions(): DefinitionRow[] {
    const rows = this.db
      .prepare(
        `SELECT s.key, s.name, s.qualified_name AS qualifiedName, s.kind, s.parent_key AS parentKey, f.path, s.line, s.col
         FROM symbols s JOIN files f ON f.id = s.file_id
         WHERE s.kind NOT IN ('file', 'parameter')
         ORDER BY f.path, s.line, s.col`,
      )
      .all() as { key: string; name: string; qualifiedName: string; kind: SymbolKind; parentKey: string | null; path: string; line: number; col: number }[];
    return rows.map((r) => ({
      key: r.key,
      name: r.name,
      qualifiedName: r.qualifiedName,
      kind: r.kind,
      parentKey: r.parentKey,
      definition: toLocation(r.path, r.line, r.col),
    }));
  }

  /** 사용처(어느 종류의 관계든)가 하나라도 있는 심볼의 열쇠. */
  referencedKeys(): Set<string> {
    const rows = this.db
      .prepare('SELECT DISTINCT to_symbol_key AS key FROM relations WHERE to_symbol_key IS NOT NULL')
      .all() as { key: string }[];
    return new Set(rows.map((r) => r.key));
  }
}

export interface DefinitionRow {
  key: string;
  name: string;
  qualifiedName: string;
  kind: SymbolKind;
  /** 바로 바깥 심볼. 최상위 선언이면 null. */
  parentKey: string | null;
  definition: Location;
}
