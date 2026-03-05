interface DiffViewerProps {
  diff: string;
}

type ParsedLineKind = 'add' | 'remove' | 'context' | 'meta';

interface ParsedLine {
  kind: ParsedLineKind;
  text: string;
  oldLine: number | null;
  newLine: number | null;
}

interface DiffFile {
  key: string;
  oldPath: string;
  newPath: string;
  lines: ParsedLine[];
  additions: number;
  deletions: number;
}

interface SplitRow {
  type: 'line';
  left: ParsedLine | null;
  right: ParsedLine | null;
}

interface HunkRow {
  type: 'hunk';
  text: string;
}

interface MetaRow {
  type: 'meta';
  text: string;
}

type DisplayRow = SplitRow | HunkRow | MetaRow;

// GitHub dark diff exact colors
const GH = {
  bg:           '#0d1117',
  surface:      '#161b22',
  border:       '#30363d',
  borderSub:    '#21262d',
  text:         '#c9d1d9',
  textMuted:    '#7d8590',
  // Added
  addContent:   '#0d2818',
  addGutter:    '#033a16',
  addMarker:    '#3fb950',
  // Removed
  remContent:   '#2d1b1e',
  remGutter:    '#48090d',
  remMarker:    '#f85149',
  // Hunk header
  hunkBg:       '#152032',
  hunkText:     '#79c0ff',
  // Empty side
  empty:        '#161b22',
} as const;

export function DiffViewer({ diff }: DiffViewerProps) {
  if (!diff.trim()) {
    return (
      <div className="px-4 py-8 text-[#7d8590] text-sm text-center font-mono">
        No changes in this worktree.
      </div>
    );
  }

  const files = parseDiff(diff);

  if (files.length === 0) {
    return (
      <div className="px-4 py-8 text-[#7d8590] text-sm text-center font-mono">
        No renderable diff hunks.
      </div>
    );
  }

  return (
    <div style={{ background: GH.bg }} className="p-3 space-y-3">
      {files.map((file) => {
        const rows = buildDisplayRows(file.lines);
        return (
          <FileSection key={file.key} file={file} rows={rows} />
        );
      })}
    </div>
  );
}

function FileSection({ file, rows }: { file: DiffFile; rows: DisplayRow[] }) {
  const label = formatFileLabel(file.oldPath, file.newPath);
  const status = getFileStatus(file);

  return (
    <section
      style={{
        border: `1px solid ${GH.border}`,
        borderRadius: 6,
        overflow: 'hidden',
        background: GH.bg,
      }}
    >
      {/* GitHub-style file header */}
      <header
        style={{
          background: GH.surface,
          borderBottom: `1px solid ${GH.border}`,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '6px 12px',
          minHeight: 40,
        }}
      >
        {/* Collapse arrow */}
        <span style={{ color: GH.textMuted, fontSize: 12, userSelect: 'none' }}>▾</span>

        {/* File icon */}
        <svg width="16" height="16" viewBox="0 0 16 16" fill={GH.textMuted}>
          <path d="M2 1.75C2 .784 2.784 0 3.75 0h6.586c.464 0 .909.184 1.237.513l2.914 2.914c.329.328.513.773.513 1.237v9.586A1.75 1.75 0 0 1 13.25 16h-9.5A1.75 1.75 0 0 1 2 14.25Zm1.75-.25a.25.25 0 0 0-.25.25v12.5c0 .138.112.25.25.25h9.5a.25.25 0 0 0 .25-.25V6h-2.75A1.75 1.75 0 0 1 8.75 4.25V1.5Zm6.75.5v2.25c0 .138.112.25.25.25h2.25Z" />
        </svg>

        {/* Status badge */}
        {status !== 'modified' && (
          <span
            style={{
              fontSize: 10,
              fontWeight: 600,
              padding: '1px 6px',
              borderRadius: 10,
              border: `1px solid ${GH.border}`,
              color: status === 'new' ? GH.addMarker : GH.remMarker,
              background: status === 'new' ? GH.addContent : GH.remContent,
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
            }}
          >
            {status}
          </span>
        )}

        {/* File path */}
        <span
          style={{
            fontSize: 12,
            fontFamily: 'ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, monospace',
            color: GH.text,
            fontWeight: 600,
            flex: 1,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {label}
        </span>

        {/* Stat pills — colored blocks like GitHub */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
          <span style={{ fontSize: 12, color: GH.addMarker, fontFamily: 'monospace' }}>
            +{file.additions}
          </span>
          <span style={{ fontSize: 12, color: GH.remMarker, fontFamily: 'monospace' }}>
            -{file.deletions}
          </span>
          <StatBlocks additions={file.additions} deletions={file.deletions} />
        </div>
      </header>

      {/* Diff table */}
      <div style={{ overflowX: 'auto' }}>
        <div style={{ minWidth: 800, fontFamily: 'ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, monospace', fontSize: 12 }}>
          {rows.map((row, i) => {
            if (row.type === 'hunk') {
              return (
                <HunkHeader key={`${file.key}:hunk:${i}`} text={row.text} />
              );
            }
            if (row.type === 'meta') {
              return (
                <MetaLine key={`${file.key}:meta:${i}`} text={row.text} />
              );
            }
            return (
              <SplitRow key={`${file.key}:row:${i}`} left={row.left} right={row.right} />
            );
          })}
        </div>
      </div>
    </section>
  );
}

/** The 5-block colored stat bar exactly like GitHub */
function StatBlocks({ additions, deletions }: { additions: number; deletions: number }) {
  const total = additions + deletions;
  if (total === 0) return null;

  const maxBlocks = 5;
  const addBlocks = total === 0 ? 0 : Math.round((additions / total) * maxBlocks);
  const delBlocks = maxBlocks - addBlocks;

  return (
    <div style={{ display: 'flex', gap: 2 }}>
      {Array.from({ length: addBlocks }).map((_, i) => (
        <div key={`a${i}`} style={{ width: 8, height: 8, background: GH.addMarker, borderRadius: 1 }} />
      ))}
      {Array.from({ length: delBlocks }).map((_, i) => (
        <div key={`d${i}`} style={{ width: 8, height: 8, background: GH.remMarker, borderRadius: 1 }} />
      ))}
    </div>
  );
}

/** Full-width @@ hunk header — styled exactly like GitHub's blue tint */
function HunkHeader({ text }: { text: string }) {
  // Extract the function/context hint after the @@ ... @@ part
  const contextMatch = /^@@ [^@]+ @@(.*)$/.exec(text);
  const hunkRange = contextMatch ? text.slice(0, text.indexOf(contextMatch[1])).trim() : text;
  const contextHint = contextMatch?.[1]?.trim() ?? '';

  return (
    <div
      style={{
        background: GH.hunkBg,
        borderTop: `1px solid #1c3659`,
        borderBottom: `1px solid #1c3659`,
        display: 'flex',
        alignItems: 'center',
        padding: '2px 0',
        lineHeight: '20px',
      }}
    >
      {/* Expand icon placeholder */}
      <div style={{ width: 80, flexShrink: 0, display: 'flex', justifyContent: 'center' }}>
        <svg width="16" height="16" viewBox="0 0 16 16" fill={GH.hunkText} style={{ opacity: 0.5 }}>
          <path d="M8.75 1.75a.75.75 0 0 0-1.5 0v5.5h-5.5a.75.75 0 0 0 0 1.5h5.5v5.5a.75.75 0 0 0 1.5 0v-5.5h5.5a.75.75 0 0 0 0-1.5h-5.5Z" />
        </svg>
      </div>
      <span style={{ color: GH.hunkText, fontSize: 12 }}>{hunkRange}</span>
      {contextHint && (
        <span style={{ color: GH.textMuted, fontSize: 12, marginLeft: 8 }}>{contextHint}</span>
      )}
    </div>
  );
}

/** Non-@@ meta lines (index, new file mode, etc.) — subtle full-width bar */
function MetaLine({ text }: { text: string }) {
  return (
    <div
      style={{
        background: GH.surface,
        borderTop: `1px solid ${GH.borderSub}`,
        color: GH.textMuted,
        fontSize: 11,
        padding: '1px 12px',
        lineHeight: '18px',
      }}
    >
      {text}
    </div>
  );
}

/** A split diff row — left (old) | divider | right (new) */
function SplitRow({ left, right }: { left: ParsedLine | null; right: ParsedLine | null }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '1fr 1px 1fr',
        borderBottom: `1px solid ${GH.borderSub}`,
      }}
    >
      <DiffCell line={left} side="left" />
      {/* Center divider */}
      <div style={{ background: GH.border }} />
      <DiffCell line={right} side="right" />
    </div>
  );
}

/** One side of a split diff row */
function DiffCell({ line, side }: { line: ParsedLine | null; side: 'left' | 'right' }) {
  const isAdd = line?.kind === 'add' && side === 'right';
  const isRem = line?.kind === 'remove' && side === 'left';
  const isEmpty = !line;

  let gutterBg: string;
  let contentBg: string;
  let markerColor: string;
  let marker: string;

  if (isAdd) {
    gutterBg = GH.addGutter;
    contentBg = GH.addContent;
    markerColor = GH.addMarker;
    marker = '+';
  } else if (isRem) {
    gutterBg = GH.remGutter;
    contentBg = GH.remContent;
    markerColor = GH.remMarker;
    marker = '-';
  } else if (isEmpty) {
    gutterBg = GH.empty;
    contentBg = GH.empty;
    markerColor = 'transparent';
    marker = '';
  } else {
    gutterBg = GH.bg;
    contentBg = GH.bg;
    markerColor = 'transparent';
    marker = '';
  }

  const lineNum = side === 'left' ? line?.oldLine : line?.newLine;

  return (
    <div style={{ display: 'flex', background: contentBg, minWidth: 0 }}>
      {/* Gutter: line number */}
      <div
        style={{
          background: gutterBg,
          width: 50,
          minWidth: 50,
          textAlign: 'right',
          padding: '1px 8px 1px 4px',
          color: GH.textMuted,
          userSelect: 'none',
          lineHeight: '20px',
          flexShrink: 0,
        }}
      >
        {lineNum ?? ''}
      </div>
      {/* Marker (+/-) */}
      <div
        style={{
          background: gutterBg,
          width: 20,
          minWidth: 20,
          textAlign: 'center',
          padding: '1px 0',
          color: markerColor,
          userSelect: 'none',
          lineHeight: '20px',
          flexShrink: 0,
          fontWeight: 600,
        }}
      >
        {marker}
      </div>
      {/* Content */}
      <div
        style={{
          flex: 1,
          padding: '1px 8px',
          whiteSpace: 'pre',
          color: GH.text,
          lineHeight: '20px',
          overflow: 'hidden',
        }}
      >
        {line?.text ?? '\u00a0'}
      </div>
    </div>
  );
}

// ─── Parser (unchanged logic) ──────────────────────────────────────────────

function buildDisplayRows(lines: ParsedLine[]): DisplayRow[] {
  const rows: DisplayRow[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (line.kind === 'meta') {
      // @@ hunk headers get a special row type
      if (line.text.startsWith('@@')) {
        rows.push({ type: 'hunk', text: line.text });
      } else {
        rows.push({ type: 'meta', text: line.text });
      }
      index += 1;
      continue;
    }

    if (line.kind === 'context') {
      rows.push({ type: 'line', left: line, right: line });
      index += 1;
      continue;
    }

    const removed: ParsedLine[] = [];
    const added: ParsedLine[] = [];

    while (index < lines.length && (lines[index].kind === 'remove' || lines[index].kind === 'add')) {
      if (lines[index].kind === 'remove') removed.push(lines[index]);
      else added.push(lines[index]);
      index += 1;
    }

    const maxLen = Math.max(removed.length, added.length);
    for (let offset = 0; offset < maxLen; offset++) {
      rows.push({ type: 'line', left: removed[offset] ?? null, right: added[offset] ?? null });
    }
  }

  return rows;
}

function parseDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  let current: DiffFile | null = null;
  let oldLine = 0;
  let newLine = 0;

  const ensureFile = (hint: string) => {
    if (current) return current;
    current = { key: hint, oldPath: hint, newPath: hint, lines: [], additions: 0, deletions: 0 };
    files.push(current);
    return current;
  };

  for (const rawLine of diff.split('\n')) {
    if (rawLine.startsWith('diff --git ')) {
      const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(rawLine);
      const oldPath = match?.[1] ?? 'unknown';
      const newPath = match?.[2] ?? oldPath;
      current = { key: `${oldPath}->${newPath}`, oldPath, newPath, lines: [], additions: 0, deletions: 0 };
      files.push(current);
      continue;
    }

    if (rawLine.startsWith('--- ')) {
      ensureFile(rawLine).oldPath = normalizePathToken(rawLine.slice(4));
      continue;
    }

    if (rawLine.startsWith('+++ ')) {
      ensureFile(rawLine).newPath = normalizePathToken(rawLine.slice(4));
      continue;
    }

    if (rawLine.startsWith('index ') || rawLine.startsWith('new file') || rawLine.startsWith('deleted file')) {
      ensureFile(rawLine).lines.push({ kind: 'meta', text: rawLine, oldLine: null, newLine: null });
      continue;
    }

    if (rawLine.startsWith('@@')) {
      const file = ensureFile(rawLine);
      const hunk = parseHunkHeader(rawLine);
      oldLine = hunk.oldStart;
      newLine = hunk.newStart;
      file.lines.push({ kind: 'meta', text: rawLine, oldLine: null, newLine: null });
      continue;
    }

    const file = ensureFile('working-tree');

    if (rawLine.startsWith('+') && !rawLine.startsWith('+++')) {
      file.additions += 1;
      file.lines.push({ kind: 'add', text: rawLine.slice(1), oldLine: null, newLine });
      newLine += 1;
      continue;
    }

    if (rawLine.startsWith('-') && !rawLine.startsWith('---')) {
      file.deletions += 1;
      file.lines.push({ kind: 'remove', text: rawLine.slice(1), oldLine, newLine: null });
      oldLine += 1;
      continue;
    }

    if (rawLine.startsWith('\\ No newline at end of file')) {
      file.lines.push({ kind: 'meta', text: rawLine, oldLine: null, newLine: null });
      continue;
    }

    file.lines.push({
      kind: 'context',
      text: rawLine.startsWith(' ') ? rawLine.slice(1) : rawLine,
      oldLine,
      newLine,
    });
    oldLine += 1;
    newLine += 1;
  }

  return files;
}

function parseHunkHeader(header: string) {
  const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(header);
  return { oldStart: match ? Number(match[1]) : 0, newStart: match ? Number(match[2]) : 0 };
}

function normalizePathToken(token: string) {
  const trimmed = token.trim();
  return trimmed === '/dev/null' ? trimmed : trimmed.replace(/^[ab]\//, '');
}

function formatFileLabel(oldPath: string, newPath: string) {
  if (oldPath === '/dev/null') return newPath;
  if (newPath === '/dev/null') return oldPath;
  if (oldPath === newPath) return newPath;
  return `${oldPath} → ${newPath}`;
}

function getFileStatus(file: DiffFile) {
  if (file.oldPath === '/dev/null') return 'new';
  if (file.newPath === '/dev/null') return 'deleted';
  return 'modified';
}
