// 그래프 저장소: 언어와 무관한 스키마를 SQLite 파일 하나에 둬요.
// 바깥에는 "사실을 넣는다"(applyFacts)와 "그래프에 묻는다"(아래 질의 함수)만 보여요.
// 스키마 설명은 docs/architecture.md에 있어요.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Confidence, Facts, RelationFact, RelationKind, SymbolFact, SymbolKind } from '../facts.ts';

const SCHEMA_VERSION = '2';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  language TEXT NOT NULL,
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
  symbols: SymbolFact[];
  relations: RelationFact[];
  /** 이 파일의 사실 전체의 해시. */
  hash: string;
}

/** 사실을 파일별로 나누고 파일마다 해시를 내요. 심볼은 정의된 파일, 관계는 적힌 파일에 속해요. */
function groupByFile(facts: Facts): Map<string, FilePart> {
  const parts = new Map<string, FilePart>();
  for (const f of facts.files) {
    if (!parts.has(f.path)) parts.set(f.path, { language: f.language, symbols: [], relations: [], hash: '' });
  }
  const part = (path: string) => {
    const p = parts.get(path);
    if (!p) throw new Error(`사실에 없는 파일을 가리켜요: ${path}`);
    return p;
  };
  for (const s of facts.symbols) part(s.path).symbols.push(s);
  for (const r of facts.relations) part(r.from.path).relations.push(r);
  for (const p of parts.values()) {
    p.hash = createHash('sha256').update(JSON.stringify([p.language, p.symbols, p.relations])).digest('hex');
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

      const putFile = db.prepare('INSERT INTO files(path, language, hash) VALUES (?, ?, ?)');
      const updateFile = db.prepare('UPDATE files SET language = ?, hash = ? WHERE id = ?');
      const putSymbol = db.prepare(
        `INSERT OR IGNORE INTO symbols(key, name, qualified_name, kind, file_id, line, col, end_line, end_col, parent_key, confidence, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const putRelation = db.prepare(
        `INSERT INTO relations(kind, from_file_id, from_symbol_key, line, col, end_line, end_col, to_symbol_key, to_path, confidence, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          updateFile.run(part.language, part.hash, old.id);
          fileId = old.id;
          changes.modified++;
        } else {
          fileId = Number(putFile.run(path, part.language, part.hash).lastInsertRowid);
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

  /**
   * 저장소 안 파일 사이의 import 간선. 같은 (from, to) 쌍은 처음 적힌 줄(1부터) 하나로 모아요.
   * 신뢰도는 그 쌍의 간선 가운데 가장 낮은 것(추정이 하나라도 있으면 inferred), 출처는 낸 색인기들(쉼표로 이음)이에요.
   */
  fileImports(): FileImportRow[] {
    const rows = this.db
      .prepare(
        `SELECT f.path AS "from", t.path AS "to", MIN(r.line) AS line,
                MIN(r.confidence) AS confidence, GROUP_CONCAT(DISTINCT r.source) AS source
         FROM relations r
         JOIN files f ON f.id = r.from_file_id
         JOIN files t ON t.id = r.to_file_id
         WHERE r.kind = 'import'
         GROUP BY f.path, t.path
         ORDER BY f.path, t.path`,
      )
      .all() as { from: string; to: string; line: number; confidence: Confidence; source: string }[];
    return rows.map((r) => ({
      from: r.from,
      to: r.to,
      line: r.line + 1,
      confidence: r.confidence,
      source: r.source.split(',').sort().join(','),
    }));
  }

  /** 정의된 심볼 전부(파일, 매개변수 제외). 경로와 위치순. */
  definitions(): DefinitionRow[] {
    const rows = this.db
      .prepare(
        `SELECT s.key, s.name, s.qualified_name AS qualifiedName, s.kind, s.parent_key AS parentKey, f.path, s.line, s.col,
                s.confidence, s.source
         FROM symbols s JOIN files f ON f.id = s.file_id
         WHERE s.kind NOT IN ('file', 'parameter')
         ORDER BY f.path, s.line, s.col`,
      )
      .all() as { key: string; name: string; qualifiedName: string; kind: SymbolKind; parentKey: string | null; path: string; line: number; col: number; confidence: Confidence; source: string }[];
    return rows.map((r) => ({
      key: r.key,
      name: r.name,
      qualifiedName: r.qualifiedName,
      kind: r.kind,
      parentKey: r.parentKey,
      definition: toLocation(r.path, r.line, r.col),
      confidence: r.confidence,
      source: r.source,
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

export interface FileImportRow {
  from: string;
  to: string;
  /** 처음 적힌 줄(1부터). */
  line: number;
  confidence: Confidence;
  source: string;
}

export interface DefinitionRow {
  key: string;
  name: string;
  qualifiedName: string;
  kind: SymbolKind;
  /** 바로 바깥 심볼. 최상위 선언이면 null. */
  parentKey: string | null;
  definition: Location;
  confidence: Confidence;
  source: string;
}
