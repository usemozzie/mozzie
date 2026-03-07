import { useEffect, useMemo, useRef } from 'react';

interface DiffViewerProps {
  diff: string;
  selectedFileKey?: string | null;
  files?: DiffFile[];
}

export type ParsedLineKind = 'add' | 'remove' | 'context' | 'meta';

export interface ParsedLine {
  kind: ParsedLineKind;
  text: string;
  oldLine: number | null;
  newLine: number | null;
}

export interface DiffFile {
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

interface VisibleRange {
  firstVisibleRow: number;
  lastVisibleRow: number;
}

interface PaneLayout {
  leftPaneWidth: number;
  rightPaneX: number;
  rightPaneWidth: number;
}

interface PaintResult extends VisibleRange, PaneLayout {}

interface UseCanvasDiffOptions {
  rows: DisplayRow[];
  minContentWidth: number;
  charWidth: number;
}

const displayRowsCache = new WeakMap<DiffFile, DisplayRow[]>();
const fontMeasurementCache = new Map<string, number>();

const GH = {
  bg: '#0d1117',
  surface: '#161b22',
  border: '#30363d',
  borderSub: '#21262d',
  text: '#c9d1d9',
  textMuted: '#7d8590',
  addContent: '#0d2818',
  addGutter: '#033a16',
  addMarker: '#3fb950',
  remContent: '#2d1b1e',
  remGutter: '#48090d',
  remMarker: '#f85149',
  hunkBg: '#152032',
  hunkText: '#79c0ff',
  empty: '#161b22',
} as const;

const ROW_HEIGHT = 22;
const GUTTER_WIDTH = 50;
const MARKER_WIDTH = 20;
const DIVIDER_WIDTH = 1;
const CODE_PADDING_X = 8;
const META_PADDING_X = 12;
const HUNK_ICON_WIDTH = 80;
const MIN_CONTENT_WIDTH = 800;
const TAB_SIZE = 8;
const FONT_SIZE = 12;
const LINE_HEIGHT = 20;
const FONT_FAMILY = 'SFMono-Regular, SF Mono, Menlo, Consolas, Liberation Mono, monospace';
const FONT = `${FONT_SIZE}px ${FONT_FAMILY}`;

export function DiffViewer({ diff, selectedFileKey, files: providedFiles }: DiffViewerProps) {
  if (!diff.trim()) {
    return (
      <div className="px-4 py-8 text-[#7d8590] text-sm text-center font-mono">
        No changes in this worktree.
      </div>
    );
  }

  const parsedFiles = providedFiles ?? parseDiff(diff);
  const files = selectedFileKey
    ? parsedFiles.filter((file) => file.key === selectedFileKey)
    : parsedFiles;

  if (files.length === 0) {
    return (
      <div className="px-4 py-8 text-[#7d8590] text-sm text-center font-mono">
        No renderable diff hunks.
      </div>
    );
  }

  const singleFile = files.length === 1;

  return (
    <div
      className="p-3"
      style={{
        background: GH.bg,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        height: singleFile ? '100%' : undefined,
        minHeight: singleFile ? 0 : undefined,
        overflowY: singleFile ? 'hidden' : 'auto',
      }}
    >
      {files.map((file) => {
        const rows = getCachedDisplayRows(file);
        return <CanvasDiffFile key={file.key} file={file} rows={rows} fillHeight={singleFile} />;
      })}
    </div>
  );
}

function getCachedDisplayRows(file: DiffFile) {
  const cached = displayRowsCache.get(file);
  if (cached) {
    return cached;
  }

  const rows = buildDisplayRows(file.lines);
  displayRowsCache.set(file, rows);
  return rows;
}

function CanvasDiffFile({
  file,
  rows,
  fillHeight,
}: {
  file: DiffFile;
  rows: DisplayRow[];
  fillHeight: boolean;
}) {
  const label = formatFileLabel(file.oldPath, file.newPath);
  const status = getFileStatus(file);
  const charWidth = useMemo(() => getMonospaceCharWidth(FONT), []);
  const minContentWidth = useMemo(() => getMinContentWidth(file, charWidth), [charWidth, file]);
  const { scrollRef, stickyRef, viewportRef, canvasRef, overlayRef, spacerRef } = useCanvasDiff({
    rows,
    minContentWidth,
    charWidth,
  });

  const totalChanges = file.additions + file.deletions;
  const addBlocks = totalChanges === 0 ? 0 : Math.round((file.additions / totalChanges) * 5);
  const deleteBlocks = totalChanges === 0 ? 0 : 5 - addBlocks;

  return (
    <section
      style={{
        border: `1px solid ${GH.border}`,
        borderRadius: 6,
        overflow: 'hidden',
        background: GH.bg,
        display: 'flex',
        flexDirection: 'column',
        height: fillHeight ? '100%' : 420,
        minHeight: fillHeight ? 0 : 420,
        flex: fillHeight ? 1 : undefined,
      }}
    >
      <header
        style={{
          background: GH.surface,
          borderBottom: `1px solid ${GH.border}`,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '6px 12px',
          minHeight: 40,
          flexShrink: 0,
        }}
      >
        <span style={{ color: GH.textMuted, fontSize: 12, userSelect: 'none' }}>▾</span>
        <svg width="16" height="16" viewBox="0 0 16 16" fill={GH.textMuted}>
          <path d="M2 1.75C2 .784 2.784 0 3.75 0h6.586c.464 0 .909.184 1.237.513l2.914 2.914c.329.328.513.773.513 1.237v9.586A1.75 1.75 0 0 1 13.25 16h-9.5A1.75 1.75 0 0 1 2 14.25Zm1.75-.25a.25.25 0 0 0-.25.25v12.5c0 .138.112.25.25.25h9.5a.25.25 0 0 0 .25-.25V6h-2.75A1.75 1.75 0 0 1 8.75 4.25V1.5Zm6.75.5v2.25c0 .138.112.25.25.25h2.25Z" />
        </svg>
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
        <span
          style={{
            fontSize: 12,
            fontFamily: `ui-monospace, ${FONT_FAMILY}`,
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
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
          <span style={{ fontSize: 12, color: GH.addMarker, fontFamily: FONT_FAMILY }}>+{file.additions}</span>
          <span style={{ fontSize: 12, color: GH.remMarker, fontFamily: FONT_FAMILY }}>-{file.deletions}</span>
          {totalChanges > 0 && (
            <div style={{ display: 'flex', gap: 2 }}>
              {Array.from({ length: addBlocks }).map((_, index) => (
                <div key={`a${index}`} style={{ width: 8, height: 8, background: GH.addMarker, borderRadius: 1 }} />
              ))}
              {Array.from({ length: deleteBlocks }).map((_, index) => (
                <div key={`d${index}`} style={{ width: 8, height: 8, background: GH.remMarker, borderRadius: 1 }} />
              ))}
            </div>
          )}
        </div>
      </header>

      <div
        ref={scrollRef}
        style={{
          position: 'relative',
          flex: 1,
          minHeight: 0,
          overflow: 'auto',
          background: GH.bg,
        }}
      >
        <div
          ref={stickyRef}
          style={{
            position: 'sticky',
            top: 0,
            left: 0,
            height: 0,
            zIndex: 1,
            pointerEvents: 'none',
          }}
        >
          <div
            ref={viewportRef}
            style={{
              position: 'relative',
              overflow: 'hidden',
            }}
          >
            <canvas
              ref={canvasRef}
              style={{
                display: 'block',
                pointerEvents: 'none',
              }}
            />
            <div
              ref={overlayRef}
              aria-hidden="true"
              style={{
                position: 'absolute',
                inset: 0,
              }}
            />
          </div>
        </div>

        <div
          ref={spacerRef}
          style={{
            width: minContentWidth,
            height: Math.max(rows.length * ROW_HEIGHT, 1),
          }}
        />
      </div>
    </section>
  );
}

function useCanvasDiff({ rows, minContentWidth, charWidth }: UseCanvasDiffOptions) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickyRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const spacerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const scrollEl = scrollRef.current;
    const stickyEl = stickyRef.current;
    const viewportEl = viewportRef.current;
    const canvasEl = canvasRef.current;
    const overlayEl = overlayRef.current;
    const spacerEl = spacerRef.current;

    if (!scrollEl || !stickyEl || !viewportEl || !canvasEl || !overlayEl || !spacerEl) {
      return;
    }

    const ctx = canvasEl.getContext('2d');
    if (!ctx) {
      return;
    }

    let frame = 0;
    let isDisposed = false;

    const totalHeight = Math.max(rows.length * ROW_HEIGHT, 1);

    const paint = () => {
      const viewportWidth = scrollEl.clientWidth;
      const viewportHeight = scrollEl.clientHeight;
      const scrollTop = scrollEl.scrollTop;
      const scrollLeft = scrollEl.scrollLeft;
      const dpr = window.devicePixelRatio || 1;

      const result = paintDiff({
        ctx,
        rows,
        scrollTop,
        scrollLeft,
        viewportWidth,
        viewportHeight,
        dpr,
        charWidth,
      });

      syncTextOverlay({
        overlayEl,
        rows,
        scrollTop,
        scrollLeft,
        viewportWidth,
        ...result,
      });
    };

    const schedulePaint = () => {
      if (frame) {
        return;
      }

      frame = window.requestAnimationFrame(() => {
        frame = 0;
        if (!isDisposed) {
          paint();
        }
      });
    };

    const syncViewport = () => {
      const viewportWidth = scrollEl.clientWidth;
      const viewportHeight = scrollEl.clientHeight;
      const dpr = window.devicePixelRatio || 1;

      stickyEl.style.width = `${viewportWidth}px`;
      viewportEl.style.width = `${viewportWidth}px`;
      viewportEl.style.height = `${viewportHeight}px`;

      canvasEl.style.width = `${viewportWidth}px`;
      canvasEl.style.height = `${viewportHeight}px`;

      overlayEl.style.width = `${viewportWidth}px`;
      overlayEl.style.height = `${viewportHeight}px`;

      const pixelWidth = Math.max(1, Math.round(viewportWidth * dpr));
      const pixelHeight = Math.max(1, Math.round(viewportHeight * dpr));
      if (canvasEl.width !== pixelWidth || canvasEl.height !== pixelHeight) {
        canvasEl.width = pixelWidth;
        canvasEl.height = pixelHeight;
      }

      spacerEl.style.width = `${Math.max(minContentWidth, viewportWidth)}px`;
      spacerEl.style.height = `${totalHeight}px`;

      schedulePaint();
    };

    const resizeObserver = new ResizeObserver(() => {
      syncViewport();
    });

    const handleScroll = () => {
      schedulePaint();
    };

    resizeObserver.observe(scrollEl);
    scrollEl.addEventListener('scroll', handleScroll, { passive: true });
    window.addEventListener('resize', syncViewport);

    syncViewport();

    return () => {
      isDisposed = true;
      if (frame) {
        window.cancelAnimationFrame(frame);
      }
      resizeObserver.disconnect();
      scrollEl.removeEventListener('scroll', handleScroll);
      window.removeEventListener('resize', syncViewport);
      overlayEl.replaceChildren();
    };
  }, [charWidth, minContentWidth, rows]);

  return {
    scrollRef,
    stickyRef,
    viewportRef,
    canvasRef,
    overlayRef,
    spacerRef,
  };
}

function paintDiff({
  ctx,
  rows,
  scrollTop,
  scrollLeft,
  viewportWidth,
  viewportHeight,
  dpr,
  charWidth,
}: {
  ctx: CanvasRenderingContext2D;
  rows: DisplayRow[];
  scrollTop: number;
  scrollLeft: number;
  viewportWidth: number;
  viewportHeight: number;
  dpr: number;
  charWidth: number;
}): PaintResult {
  const { leftPaneWidth, rightPaneX, rightPaneWidth } = getPaneLayout(viewportWidth);
  const { firstVisibleRow, lastVisibleRow } = getVisibleRange(scrollTop, viewportHeight, rows.length);

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, viewportWidth, viewportHeight);
  ctx.fillStyle = GH.bg;
  ctx.fillRect(0, 0, viewportWidth, viewportHeight);
  ctx.font = FONT;
  ctx.textBaseline = 'middle';

  for (let index = firstVisibleRow; index <= lastVisibleRow; index += 1) {
    const row = rows[index];
    const y = index * ROW_HEIGHT - scrollTop;

    if (row.type === 'hunk') {
      paintHunkRow(ctx, row.text, y, viewportWidth, scrollLeft, charWidth);
      continue;
    }

    if (row.type === 'meta') {
      paintMetaRow(ctx, row.text, y, viewportWidth, scrollLeft);
      continue;
    }

    paintLinePane(ctx, row.left, 'left', 0, leftPaneWidth, y, scrollLeft);
    ctx.fillStyle = GH.border;
    ctx.fillRect(leftPaneWidth, y, DIVIDER_WIDTH, ROW_HEIGHT);
    paintLinePane(ctx, row.right, 'right', rightPaneX, rightPaneWidth, y, scrollLeft);
    ctx.fillStyle = GH.borderSub;
    ctx.fillRect(0, y + ROW_HEIGHT - 1, viewportWidth, 1);
  }

  return {
    firstVisibleRow,
    lastVisibleRow,
    leftPaneWidth,
    rightPaneX,
    rightPaneWidth,
  };
}

function paintHunkRow(
  ctx: CanvasRenderingContext2D,
  text: string,
  y: number,
  viewportWidth: number,
  scrollLeft: number,
  charWidth: number,
) {
  const { hunkRange, contextHint } = splitHunkText(text);
  const textY = y + ROW_HEIGHT / 2;

  ctx.fillStyle = GH.hunkBg;
  ctx.fillRect(0, y, viewportWidth, ROW_HEIGHT);
  ctx.fillStyle = '#1c3659';
  ctx.fillRect(0, y, viewportWidth, 1);
  ctx.fillRect(0, y + ROW_HEIGHT - 1, viewportWidth, 1);

  ctx.fillStyle = GH.hunkText;
  ctx.textAlign = 'center';
  ctx.fillText('+', HUNK_ICON_WIDTH / 2, textY);

  ctx.save();
  ctx.beginPath();
  ctx.rect(HUNK_ICON_WIDTH, y, Math.max(viewportWidth - HUNK_ICON_WIDTH, 0), ROW_HEIGHT);
  ctx.clip();
  ctx.textAlign = 'left';
  ctx.fillStyle = GH.hunkText;
  ctx.fillText(hunkRange, HUNK_ICON_WIDTH - scrollLeft, textY);
  if (contextHint) {
    const rangeWidth = getExpandedCharCount(hunkRange) * charWidth;
    ctx.fillStyle = GH.textMuted;
    ctx.fillText(contextHint, HUNK_ICON_WIDTH - scrollLeft + rangeWidth + 8, textY);
  }
  ctx.restore();
}

function paintMetaRow(
  ctx: CanvasRenderingContext2D,
  text: string,
  y: number,
  viewportWidth: number,
  scrollLeft: number,
) {
  const textY = y + ROW_HEIGHT / 2;

  ctx.fillStyle = GH.surface;
  ctx.fillRect(0, y, viewportWidth, ROW_HEIGHT);
  ctx.fillStyle = GH.borderSub;
  ctx.fillRect(0, y, viewportWidth, 1);
  ctx.fillRect(0, y + ROW_HEIGHT - 1, viewportWidth, 1);

  ctx.save();
  ctx.beginPath();
  ctx.rect(META_PADDING_X, y, Math.max(viewportWidth - META_PADDING_X * 2, 0), ROW_HEIGHT);
  ctx.clip();
  ctx.fillStyle = GH.textMuted;
  ctx.textAlign = 'left';
  ctx.fillText(text, META_PADDING_X - scrollLeft, textY);
  ctx.restore();
}

function paintLinePane(
  ctx: CanvasRenderingContext2D,
  line: ParsedLine | null,
  side: 'left' | 'right',
  paneX: number,
  paneWidth: number,
  y: number,
  scrollLeft: number,
) {
  const { gutterBg, contentBg, markerColor, marker } = getPaneStyle(line, side);
  const textY = y + ROW_HEIGHT / 2;
  const lineNumber = side === 'left' ? line?.oldLine : line?.newLine;
  const codeX = paneX + GUTTER_WIDTH + MARKER_WIDTH;
  const codeWidth = Math.max(paneWidth - GUTTER_WIDTH - MARKER_WIDTH, 0);

  ctx.fillStyle = gutterBg;
  ctx.fillRect(paneX, y, GUTTER_WIDTH + MARKER_WIDTH, ROW_HEIGHT);
  ctx.fillStyle = contentBg;
  ctx.fillRect(codeX, y, codeWidth, ROW_HEIGHT);

  ctx.fillStyle = GH.textMuted;
  ctx.textAlign = 'right';
  if (lineNumber !== null && lineNumber !== undefined) {
    ctx.fillText(String(lineNumber), paneX + GUTTER_WIDTH - 8, textY);
  }

  if (marker) {
    ctx.fillStyle = markerColor;
    ctx.textAlign = 'center';
    ctx.fillText(marker, paneX + GUTTER_WIDTH + MARKER_WIDTH / 2, textY);
  }

  if (!line || codeWidth <= 0) {
    return;
  }

  ctx.save();
  ctx.beginPath();
  ctx.rect(codeX, y, codeWidth, ROW_HEIGHT);
  ctx.clip();
  ctx.fillStyle = GH.text;
  ctx.textAlign = 'left';
  ctx.fillText(expandTabs(line.text), codeX + CODE_PADDING_X - scrollLeft, textY);
  ctx.restore();
}

function syncTextOverlay({
  overlayEl,
  rows,
  scrollTop,
  scrollLeft,
  viewportWidth,
  firstVisibleRow,
  lastVisibleRow,
  leftPaneWidth,
  rightPaneX,
  rightPaneWidth,
}: {
  overlayEl: HTMLDivElement;
  rows: DisplayRow[];
  scrollTop: number;
  scrollLeft: number;
  viewportWidth: number;
  firstVisibleRow: number;
  lastVisibleRow: number;
  leftPaneWidth: number;
  rightPaneX: number;
  rightPaneWidth: number;
}) {
  const fragment = document.createDocumentFragment();

  for (let index = firstVisibleRow; index <= lastVisibleRow; index += 1) {
    const row = rows[index];
    const y = index * ROW_HEIGHT - scrollTop;
    const rowEl = document.createElement('div');

    rowEl.style.position = 'absolute';
    rowEl.style.left = '0';
    rowEl.style.top = `${y}px`;
    rowEl.style.width = `${viewportWidth}px`;
    rowEl.style.height = `${ROW_HEIGHT}px`;
    rowEl.style.pointerEvents = 'none';

    if (row.type === 'line') {
      appendLineOverlay(rowEl, row.left, 0, leftPaneWidth, scrollLeft);
      appendLineOverlay(rowEl, row.right, rightPaneX, rightPaneWidth, scrollLeft);
    } else if (row.type === 'hunk') {
      appendFullRowOverlay(rowEl, row.text, HUNK_ICON_WIDTH, scrollLeft, viewportWidth);
    } else {
      appendFullRowOverlay(rowEl, row.text, META_PADDING_X, scrollLeft, viewportWidth);
    }

    fragment.appendChild(rowEl);
  }

  overlayEl.replaceChildren(fragment);
}

function appendLineOverlay(
  rowEl: HTMLDivElement,
  line: ParsedLine | null,
  paneX: number,
  paneWidth: number,
  scrollLeft: number,
) {
  if (!line) {
    return;
  }

  const codeX = paneX + GUTTER_WIDTH + MARKER_WIDTH;
  const codeWidth = Math.max(paneWidth - GUTTER_WIDTH - MARKER_WIDTH, 0);
  if (codeWidth <= 0) {
    return;
  }

  const clipEl = document.createElement('div');
  clipEl.style.position = 'absolute';
  clipEl.style.left = `${codeX}px`;
  clipEl.style.top = '0';
  clipEl.style.width = `${codeWidth}px`;
  clipEl.style.height = `${ROW_HEIGHT}px`;
  clipEl.style.overflow = 'hidden';
  clipEl.style.pointerEvents = 'auto';
  clipEl.style.userSelect = 'text';
  clipEl.style.whiteSpace = 'pre';
  clipEl.style.fontSize = `${FONT_SIZE}px`;
  clipEl.style.fontFamily = FONT_FAMILY;
  clipEl.style.lineHeight = `${LINE_HEIGHT}px`;
  clipEl.style.color = 'transparent';
  clipEl.style.caretColor = 'transparent';
  clipEl.style.tabSize = String(TAB_SIZE);

  const textEl = document.createElement('span');
  textEl.style.position = 'absolute';
  textEl.style.left = `${CODE_PADDING_X - scrollLeft}px`;
  textEl.style.top = '1px';
  textEl.style.whiteSpace = 'pre';
  textEl.textContent = line.text;

  clipEl.appendChild(textEl);
  rowEl.appendChild(clipEl);
}

function appendFullRowOverlay(
  rowEl: HTMLDivElement,
  text: string,
  startX: number,
  scrollLeft: number,
  viewportWidth: number,
) {
  const clipEl = document.createElement('div');
  clipEl.style.position = 'absolute';
  clipEl.style.left = `${startX}px`;
  clipEl.style.top = '0';
  clipEl.style.width = `${Math.max(viewportWidth - startX, 0)}px`;
  clipEl.style.height = `${ROW_HEIGHT}px`;
  clipEl.style.overflow = 'hidden';
  clipEl.style.pointerEvents = 'auto';
  clipEl.style.userSelect = 'text';
  clipEl.style.whiteSpace = 'pre';
  clipEl.style.fontSize = `${FONT_SIZE}px`;
  clipEl.style.fontFamily = FONT_FAMILY;
  clipEl.style.lineHeight = `${LINE_HEIGHT}px`;
  clipEl.style.color = 'transparent';
  clipEl.style.caretColor = 'transparent';
  clipEl.style.tabSize = String(TAB_SIZE);

  const textEl = document.createElement('span');
  textEl.style.position = 'absolute';
  textEl.style.left = `${-scrollLeft}px`;
  textEl.style.top = '1px';
  textEl.style.whiteSpace = 'pre';
  textEl.textContent = text;

  clipEl.appendChild(textEl);
  rowEl.appendChild(clipEl);
}

function getVisibleRange(scrollTop: number, viewportHeight: number, totalRows: number): VisibleRange {
  if (totalRows === 0) {
    return { firstVisibleRow: 0, lastVisibleRow: -1 };
  }

  const firstVisibleRow = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT));
  const lastVisibleRow = Math.min(
    totalRows - 1,
    firstVisibleRow + Math.ceil(viewportHeight / ROW_HEIGHT) + 1,
  );

  return { firstVisibleRow, lastVisibleRow };
}

function getPaneLayout(viewportWidth: number): PaneLayout {
  const leftPaneWidth = Math.max(Math.floor((viewportWidth - DIVIDER_WIDTH) / 2), 0);
  const rightPaneX = leftPaneWidth + DIVIDER_WIDTH;
  const rightPaneWidth = Math.max(viewportWidth - rightPaneX, 0);

  return {
    leftPaneWidth,
    rightPaneX,
    rightPaneWidth,
  };
}

function getPaneStyle(line: ParsedLine | null, side: 'left' | 'right') {
  const isAdd = line?.kind === 'add' && side === 'right';
  const isRemove = line?.kind === 'remove' && side === 'left';
  const isEmpty = !line;

  if (isAdd) {
    return {
      gutterBg: GH.addGutter,
      contentBg: GH.addContent,
      markerColor: GH.addMarker,
      marker: '+',
    };
  }

  if (isRemove) {
    return {
      gutterBg: GH.remGutter,
      contentBg: GH.remContent,
      markerColor: GH.remMarker,
      marker: '-',
    };
  }

  if (isEmpty) {
    return {
      gutterBg: GH.empty,
      contentBg: GH.empty,
      markerColor: 'transparent',
      marker: '',
    };
  }

  return {
    gutterBg: GH.bg,
    contentBg: GH.bg,
    markerColor: 'transparent',
    marker: '',
  };
}

function getMonospaceCharWidth(font: string) {
  const cached = fontMeasurementCache.get(font);
  if (cached) {
    return cached;
  }

  if (typeof document === 'undefined') {
    return 7.2;
  }

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return 7.2;
  }

  ctx.font = font;
  const width = ctx.measureText('M').width;
  fontMeasurementCache.set(font, width);
  return width;
}

function getMinContentWidth(file: DiffFile, charWidth: number) {
  let longestLine = 0;

  for (const line of file.lines) {
    longestLine = Math.max(longestLine, getExpandedCharCount(line.text));
  }

  const splitWidth =
    (GUTTER_WIDTH + MARKER_WIDTH + CODE_PADDING_X * 2 + longestLine * charWidth) * 2 + DIVIDER_WIDTH;
  const fullRowWidth = META_PADDING_X * 2 + longestLine * charWidth;

  return Math.max(MIN_CONTENT_WIDTH, Math.ceil(splitWidth), Math.ceil(fullRowWidth));
}

function getExpandedCharCount(text: string) {
  let count = 0;

  for (const char of text) {
    if (char === '\t') {
      count += TAB_SIZE - (count % TAB_SIZE);
    } else {
      count += 1;
    }
  }

  return count;
}

function expandTabs(text: string) {
  if (!text.includes('\t')) {
    return text;
  }

  let result = '';
  let column = 0;

  for (const char of text) {
    if (char === '\t') {
      const spaces = TAB_SIZE - (column % TAB_SIZE);
      result += ' '.repeat(spaces);
      column += spaces;
      continue;
    }

    result += char;
    column += 1;
  }

  return result;
}

function splitHunkText(text: string) {
  const contextMatch = /^@@ [^@]+ @@(.*)$/.exec(text);
  const hunkRange = contextMatch ? text.slice(0, text.indexOf(contextMatch[1])).trim() : text;
  const contextHint = contextMatch?.[1]?.trim() ?? '';

  return { hunkRange, contextHint };
}

function buildDisplayRows(lines: ParsedLine[]): DisplayRow[] {
  const rows: DisplayRow[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (line.kind === 'meta') {
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

export function parseDiff(diff: string): DiffFile[] {
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

  return files.filter((f) => f.key !== 'working-tree');
}

function parseHunkHeader(header: string) {
  const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(header);
  return { oldStart: match ? Number(match[1]) : 0, newStart: match ? Number(match[2]) : 0 };
}

function normalizePathToken(token: string) {
  const trimmed = token.trim();
  return trimmed === '/dev/null' ? trimmed : trimmed.replace(/^[ab]\//, '');
}

export function formatFileLabel(oldPath: string, newPath: string) {
  if (oldPath === '/dev/null') return newPath;
  if (newPath === '/dev/null') return oldPath;
  if (oldPath === newPath) return newPath;
  return `${oldPath} → ${newPath}`;
}

export function getFileStatus(file: DiffFile) {
  if (file.oldPath === '/dev/null') return 'new';
  if (file.newPath === '/dev/null') return 'deleted';
  return 'modified';
}
