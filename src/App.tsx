import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent
} from "react";
import { defaultRules, type RedactionRule, type Validator } from "./rules";
import {
  analyzePdfFiles,
  createPdfPreview,
  redactPdfFile,
  type ManualRedaction,
  type FieldAnalysis,
  type DocumentAnalysis,
  type PreviewResult,
  type Rect,
  type RedactionHit,
  type ProcessProgress,
  type ProcessResult
} from "./pdfRedactor";

type CustomFieldDraft = {
  title: string;
  labels: string;
  validator: Validator;
  enabledByDefault: boolean;
};

type PreviewMode = "split" | "original" | "redacted";

type DragDraft = {
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
};

type ResizeHandle = "nw" | "ne" | "sw" | "se";

type ResizeDraft = {
  hit: RedactionHit;
  handle: ResizeHandle;
  currentX: number;
  currentY: number;
};

const validators: Array<{ value: Validator; label: string }> = [
  { value: "free_text", label: "Any text" },
  { value: "name", label: "Name" },
  { value: "email", label: "Email" },
  { value: "phone", label: "Phone" },
  { value: "age", label: "Age" }
];

function fallbackAnalysis(rules: RedactionRule[], fileCount: number): DocumentAnalysis {
  return {
    fields: rules.map((rule) => ({
      key: rule.key,
      title: rule.title,
      labels: rule.enabledByDefault ? ["Default scan"] : [],
      samples: [],
      count: rule.enabledByDefault ? fileCount : 0
    })),
    suggestedLabels: [],
    pageCount: 0,
    spanCount: 0
  };
}

function makeRuleKey(title: string, existing: RedactionRule[]): string {
  const base =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || "custom_field";
  let key = base;
  let index = 2;
  while (existing.some((rule) => rule.key === key)) {
    key = `${base}_${index}`;
    index += 1;
  }
  return key;
}

function splitCsv(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function debugLine(message: string, details?: unknown): string {
  if (details === undefined) return message;
  try {
    return `${message} ${JSON.stringify(details)}`;
  } catch {
    return message;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function rectFromPoints(startX: number, startY: number, endX: number, endY: number): Rect {
  const left = Math.min(startX, endX);
  const top = Math.min(startY, endY);
  return {
    x: left,
    y: top,
    width: Math.abs(endX - startX),
    height: Math.abs(endY - startY)
  };
}

function resizeRect(rect: Rect, handle: ResizeHandle, pointX: number, pointY: number, pageWidth: number, pageHeight: number): Rect {
  const minSize = 8;
  let left = rect.x;
  let top = rect.y;
  let right = rect.x + rect.width;
  let bottom = rect.y + rect.height;

  if (handle.includes("w")) left = clamp(pointX, 0, right - minSize);
  if (handle.includes("e")) right = clamp(pointX, left + minSize, pageWidth);
  if (handle.includes("n")) top = clamp(pointY, 0, bottom - minSize);
  if (handle.includes("s")) bottom = clamp(pointY, top + minSize, pageHeight);

  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top
  };
}

function rectStyle(rect: Rect, pageWidth: number, pageHeight: number): CSSProperties {
  return {
    left: `${(rect.x / pageWidth) * 100}%`,
    top: `${(rect.y / pageHeight) * 100}%`,
    width: `${(rect.width / pageWidth) * 100}%`,
    height: `${(rect.height / pageHeight) * 100}%`
  };
}

function fileId(file: File): string {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

function pageLabel(preview: PreviewResult): string {
  if (preview.pageIndex >= preview.totalPages - 1) return "Last page";
  if (preview.pageIndex === preview.totalPages - 2) return "Last";
  return "Next";
}

export default function App() {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const redactedPreviewRef = useRef<HTMLDivElement | null>(null);
  const [rules, setRules] = useState<RedactionRule[]>(defaultRules);
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(defaultRules.filter((rule) => rule.enabledByDefault).map((rule) => rule.key))
  );
  const [files, setFiles] = useState<File[]>([]);
  const [customValues, setCustomValues] = useState("");
  const [allEmails, setAllEmails] = useState(false);
  const [allRegex, setAllRegex] = useState(false);
  const [padding, setPadding] = useState(2);
  const [draft, setDraft] = useState<CustomFieldDraft>({
    title: "",
    labels: "",
    validator: "free_text",
    enabledByDefault: false
  });
  const [progress, setProgress] = useState<ProcessProgress | null>(null);
  const [results, setResults] = useState<ProcessResult[]>([]);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [previewFileIndex, setPreviewFileIndex] = useState(0);
  const [previewPage, setPreviewPage] = useState(0);
  const [previewStatus, setPreviewStatus] = useState("Attach a PDF to preview redactions.");
  const [isPreviewLoading, setIsPreviewLoading] = useState(false);
  const [previewMode, setPreviewMode] = useState<PreviewMode>("split");
  const [zoom, setZoom] = useState(1);
  const [isDrawingManualBox, setIsDrawingManualBox] = useState(false);
  const [dragDraft, setDragDraft] = useState<DragDraft | null>(null);
  const [resizeDraft, setResizeDraft] = useState<ResizeDraft | null>(null);
  const [selectedHitKey, setSelectedHitKey] = useState<string | null>(null);
  const [ignoredHitKeys, setIgnoredHitKeys] = useState<Set<string>>(() => new Set());
  const [manualRedactions, setManualRedactions] = useState<ManualRedaction[]>([]);
  const [logs, setLogs] = useState<string[]>([]);
  const [analysis, setAnalysis] = useState<DocumentAnalysis | null>(null);
  const [analysisStatus, setAnalysisStatus] = useState("Attach PDFs to inspect available fields.");
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedCount = selected.size;
  const selectedPreviewFile = files[previewFileIndex] ?? null;
  const canRun =
    files.length > 0 &&
    (selectedCount > 0 || customValues.trim().length > 0 || manualRedactions.length > 0) &&
    !isRunning;
  const suggestedRules = useMemo<RedactionRule[]>(
    () => (analysis?.suggestedLabels ?? []).map((label, index) => ({
      key: `detected_${index}_${makeRuleKey(label, rules)}`,
      title: label,
      description: "Detected PDF field",
      enabledByDefault: false,
      validator: "free_text",
      labels: [label]
    })),
    [analysis, rules]
  );
  const activeRules = useMemo(
    () => [...rules, ...suggestedRules],
    [rules, suggestedRules]
  );
  const availabilityByKey = useMemo(
    () => {
      const items = analysis?.fields ?? [];
      const entries: Array<[string, FieldAnalysis]> = [
        ...items.map((field): [string, FieldAnalysis] => [field.key, field]),
        ...suggestedRules.map((rule): [string, FieldAnalysis] => [rule.key, {
          key: rule.key,
          title: rule.title,
          labels: rule.labels,
          samples: [],
          count: 1
        }])
      ];
      return new Map(entries);
    },
    [analysis, suggestedRules]
  );
  const displayRules = useMemo(
    () => [...activeRules].sort((a, b) => {
      const aCount = files.length === 0 ? 1 : (availabilityByKey.get(a.key)?.count ?? 0);
      const bCount = files.length === 0 ? 1 : (availabilityByKey.get(b.key)?.count ?? 0);
      if ((aCount > 0) !== (bCount > 0)) return aCount > 0 ? -1 : 1;
      if (a.enabledByDefault !== b.enabledByDefault) return a.enabledByDefault ? -1 : 1;
      return 0;
    }),
    [activeRules, availabilityByKey, files.length]
  );

  const totalHits = useMemo(
    () => results.reduce((total, result) => total + result.hits.length, 0),
    [results]
  );
  const selectedSignature = useMemo(
    () => [...selected].sort().join("|"),
    [selected]
  );
  const ignoredSignature = useMemo(
    () => [...ignoredHitKeys].sort().join("|"),
    [ignoredHitKeys]
  );
  const redactionToolsEnabled = previewMode !== "original";

  function log(message: string, details?: unknown): void {
    const line = debugLine(message, details);
    console.debug(`[PrivyPDF] ${message}`, details ?? "");
    setLogs((current) => [...current, line]);
  }

  useEffect(() => {
    if (files.length === 0) {
      setAnalysis(null);
      setAnalysisStatus("Attach PDFs to inspect available fields.");
      return;
    }

    let cancelled = false;
    setAnalysisStatus("Reading document fields...");
    setError(null);

    analyzePdfFiles(files, rules, (message, details) => {
      console.debug(`[PrivyPDF] ${message}`, details ?? "");
    })
      .then((nextAnalysis) => {
        if (cancelled) return;
        setAnalysis(nextAnalysis);
        setAnalysisStatus(
          `Found ${nextAnalysis.fields.filter((field) => field.count > 0).length} supported field type(s), ${nextAnalysis.spanCount} text item(s).`
        );
        setLogs([`Inspection complete: ${nextAnalysis.pageCount} page(s), ${nextAnalysis.spanCount} text item(s).`]);
      })
      .catch((caught) => {
        if (cancelled) return;
        const message = caught instanceof Error ? caught.message : "Could not inspect this PDF.";
        setAnalysis(fallbackAnalysis(rules, files.length));
        setAnalysisStatus("Field inspection failed. Default name and email scan stayed available.");
        setError(null);
        setLogs(["Field inspection failed. Default name and email scan stayed available."]);
        console.error("[PrivyPDF] Field inspection failed", caught);
      });

    return () => {
      cancelled = true;
    };
  }, [files, rules]);

  useEffect(() => {
    setPreviewFileIndex(0);
    setPreviewPage(0);
    setSelectedHitKey(null);
  }, [files]);

  useEffect(() => {
    setPreviewPage(0);
    setSelectedHitKey(null);
  }, [previewFileIndex]);

  useEffect(() => {
    if (previewMode === "original") {
      setIsDrawingManualBox(false);
      setDragDraft(null);
      setResizeDraft(null);
      setSelectedHitKey(null);
    }
  }, [previewMode]);

  useEffect(() => {
    if (selectedHitKey && preview && !preview.hitsOnPage.some((hit) => hit.key === selectedHitKey)) {
      setSelectedHitKey(null);
    }
  }, [preview, selectedHitKey]);

  useEffect(() => {
    if (!selectedPreviewFile) {
      setPreview(null);
      setPreviewStatus("Attach a PDF to preview redactions.");
      setIsPreviewLoading(false);
      return;
    }

    let cancelled = false;
    setIsPreviewLoading(true);
    setPreviewStatus("Rendering preview...");

    createPdfPreview(
      selectedPreviewFile,
      activeRules,
      {
        selectedKeys: [...selected],
        customValues: splitCsv(customValues),
        allEmails,
        allRegex,
        padding,
        fileId: fileId(selectedPreviewFile),
        ignoredHitKeys: [...ignoredHitKeys],
        manualRedactions
      },
      previewPage
    )
      .then((nextPreview) => {
        if (cancelled) return;
        setPreview(nextPreview);
        setPreviewPage(nextPreview.pageIndex);
        setPreviewStatus(
          `${nextPreview.fileName}: page ${nextPreview.pageIndex + 1} of ${nextPreview.totalPages}, ${nextPreview.hitsOnPage.length} box(es) on this page.`
        );
      })
      .catch((caught) => {
        if (cancelled) return;
        const message = caught instanceof Error ? caught.message : "Could not render preview.";
        setPreview(null);
        setPreviewStatus(message);
      })
      .finally(() => {
        if (!cancelled) setIsPreviewLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [
    activeRules,
    allEmails,
    allRegex,
    customValues,
    ignoredHitKeys,
    ignoredSignature,
    manualRedactions,
    padding,
    previewPage,
    selected,
    selectedPreviewFile,
    selectedSignature
  ]);

  function toggleRule(key: string): void {
    const field = availabilityByKey.get(key);
    if (files.length > 0 && field && field.count === 0) return;
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }

  function selectDefaults(): void {
    const keys = rules
      .filter((rule) => rule.enabledByDefault)
      .filter((rule) => files.length === 0 || (availabilityByKey.get(rule.key)?.count ?? 0) > 0)
      .map((rule) => rule.key);
    setSelected(new Set(keys));
  }

  function selectAll(): void {
    const keys = activeRules
      .filter((rule) => files.length === 0 || (availabilityByKey.get(rule.key)?.count ?? 0) > 0)
      .map((rule) => rule.key);
    setSelected(new Set(keys));
  }

  function clearSelection(): void {
    setSelected(new Set());
  }

  function addCustomField(): void {
    const labels = splitCsv(draft.labels);
    if (!draft.title.trim()) {
      setError("Custom field name is required.");
      return;
    }
    if (labels.length === 0) {
      setError("Add at least one PDF label for the custom field.");
      return;
    }

    const key = makeRuleKey(draft.title, rules);
    const rule: RedactionRule = {
      key,
      title: draft.title.trim(),
      description: `Custom field: ${labels.join(", ")}`,
      enabledByDefault: draft.enabledByDefault,
      validator: draft.validator,
      labels
    };

    setRules((current) => [...current, rule]);
    setSelected((current) => new Set([...current, key]));
    setDraft({ title: "", labels: "", validator: "free_text", enabledByDefault: false });
    setError(null);
  }

  function pointerToPdfPoint(event: ReactPointerEvent<HTMLDivElement>): { x: number; y: number } | null {
    if (!preview || !redactedPreviewRef.current) return null;
    const bounds = redactedPreviewRef.current.getBoundingClientRect();
    if (bounds.width === 0 || bounds.height === 0) return null;
    return {
      x: clamp(((event.clientX - bounds.left) / bounds.width) * preview.pageWidth, 0, preview.pageWidth),
      y: clamp(((event.clientY - bounds.top) / bounds.height) * preview.pageHeight, 0, preview.pageHeight)
    };
  }

  function beginManualRedaction(event: ReactPointerEvent<HTMLDivElement>): void {
    if (!redactionToolsEnabled || !isDrawingManualBox || !preview || !selectedPreviewFile) return;
    const point = pointerToPdfPoint(event);
    if (!point) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setSelectedHitKey(null);
    setDragDraft({
      startX: point.x,
      startY: point.y,
      currentX: point.x,
      currentY: point.y
    });
  }

  function updateManualRedaction(event: ReactPointerEvent<HTMLDivElement>): void {
    if (!dragDraft && !resizeDraft) return;
    const point = pointerToPdfPoint(event);
    if (!point) return;
    setDragDraft((current) => current ? { ...current, currentX: point.x, currentY: point.y } : current);
    setResizeDraft((current) => current ? { ...current, currentX: point.x, currentY: point.y } : current);
  }

  function finishManualRedaction(): void {
    if (!dragDraft || !preview || !selectedPreviewFile) {
      setDragDraft(null);
      return;
    }

    let rect = rectFromPoints(dragDraft.startX, dragDraft.startY, dragDraft.currentX, dragDraft.currentY);
    if (rect.width < 6 || rect.height < 6) {
      const width = Math.min(92, preview.pageWidth);
      const height = Math.min(26, preview.pageHeight);
      rect = {
        x: clamp(dragDraft.startX - width / 2, 0, preview.pageWidth - width),
        y: clamp(dragDraft.startY - height / 2, 0, preview.pageHeight - height),
        width,
        height
      };
    }

    const redaction: ManualRedaction = {
      id: `manual:${fileId(selectedPreviewFile)}:${preview.pageIndex}:${Date.now()}:${Math.random().toString(16).slice(2)}`,
      fileId: fileId(selectedPreviewFile),
      fileName: selectedPreviewFile.name,
      pageIndex: preview.pageIndex,
      rect
    };

    setManualRedactions((current) => [...current, redaction]);
    setSelectedHitKey(redaction.id);
    setDragDraft(null);
  }

  function beginResize(hit: RedactionHit, handle: ResizeHandle, event: ReactPointerEvent<HTMLElement>): void {
    if (!redactionToolsEnabled || !preview) return;
    const point = pointerToPdfPoint(event as unknown as ReactPointerEvent<HTMLDivElement>);
    if (!point) return;
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    setIsDrawingManualBox(false);
    setDragDraft(null);
    setSelectedHitKey(hit.key);
    setResizeDraft({
      hit,
      handle,
      currentX: point.x,
      currentY: point.y
    });
  }

  function finishResize(): void {
    if (!resizeDraft || !preview || !selectedPreviewFile) {
      setResizeDraft(null);
      return;
    }

    const rect = resizeRect(
      resizeDraft.hit.rect,
      resizeDraft.handle,
      resizeDraft.currentX,
      resizeDraft.currentY,
      preview.pageWidth,
      preview.pageHeight
    );

    if (resizeDraft.hit.source === "manual") {
      setManualRedactions((current) =>
        current.map((redaction) => redaction.id === resizeDraft.hit.key ? { ...redaction, rect } : redaction)
      );
      setSelectedHitKey(resizeDraft.hit.key);
    } else {
      const replacementId = `manual:${fileId(selectedPreviewFile)}:${preview.pageIndex}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
      const redaction: ManualRedaction = {
        id: replacementId,
        fileId: fileId(selectedPreviewFile),
        fileName: selectedPreviewFile.name,
        pageIndex: preview.pageIndex,
        rect,
        replacesKey: resizeDraft.hit.key
      };
      setIgnoredHitKeys((current) => new Set([...current, resizeDraft.hit.key]));
      setManualRedactions((current) => [...current, redaction]);
      setSelectedHitKey(replacementId);
    }
    setResizeDraft(null);
  }

  function removeSelectedHit(): void {
    if (!selectedHitKey) return;
    const selectedHit = preview?.hitsOnPage.find((hit) => hit.key === selectedHitKey);
    if (!selectedHit) {
      setSelectedHitKey(null);
      return;
    }
    if (selectedHit?.source === "manual") {
      setManualRedactions((current) => current.filter((redaction) => redaction.id !== selectedHitKey));
      const manual = manualRedactions.find((redaction) => redaction.id === selectedHitKey);
      const replacedKey = manual?.replacesKey;
      if (replacedKey) {
        setIgnoredHitKeys((current) => {
          const next = new Set(current);
          next.delete(replacedKey);
          return next;
        });
      }
    } else {
      setIgnoredHitKeys((current) => new Set([...current, selectedHitKey]));
    }
    setSelectedHitKey(null);
  }

  function renderPreviewSurface(title: string, redacted: boolean) {
    if (!preview) return null;
    const draftRect = dragDraft
      ? rectFromPoints(dragDraft.startX, dragDraft.startY, dragDraft.currentX, dragDraft.currentY)
      : null;
    const hits = redacted ? preview.hitsOnPage : [];

    return (
      <figure className="pdf-preview">
        <figcaption>{title}</figcaption>
        <div
          ref={redacted ? redactedPreviewRef : undefined}
          className={`preview-canvas ${redacted && isDrawingManualBox ? "is-drawing" : ""}`}
          style={{
            width: `${preview.pageWidth * zoom}px`,
            aspectRatio: `${preview.pageWidth} / ${preview.pageHeight}`
          }}
          onPointerDown={redacted ? beginManualRedaction : undefined}
          onPointerMove={redacted ? updateManualRedaction : undefined}
          onPointerUp={redacted ? () => {
            if (resizeDraft) {
              finishResize();
            } else {
              finishManualRedaction();
            }
          } : undefined}
          onPointerCancel={redacted ? () => {
            setDragDraft(null);
            setResizeDraft(null);
          } : undefined}
        >
          <img src={preview.originalUrl} alt={`${preview.fileName} ${title.toLowerCase()} page ${preview.pageIndex + 1}`} />
          {hits.map((hit: RedactionHit) => {
            const isSelected = selectedHitKey === hit.key;
            const activeRect = resizeDraft?.hit.key === hit.key
              ? resizeRect(hit.rect, resizeDraft.handle, resizeDraft.currentX, resizeDraft.currentY, preview.pageWidth, preview.pageHeight)
              : hit.rect;
            return (
              <button
                type="button"
                key={hit.key}
                className={`redaction-box ${hit.source === "auto" ? "is-auto" : "is-manual"} ${isSelected ? "is-selected" : ""}`}
                style={rectStyle(activeRect, preview.pageWidth, preview.pageHeight)}
                title={`${hit.reason}: ${hit.text}`}
                onPointerDown={(event) => {
                  event.stopPropagation();
                  setSelectedHitKey(hit.key);
                }}
                onClick={() => setSelectedHitKey(hit.key)}
              >
                {isSelected && redactionToolsEnabled && (["nw", "ne", "sw", "se"] as ResizeHandle[]).map((handle) => (
                  <span
                    key={handle}
                    role="button"
                    tabIndex={-1}
                    className={`resize-handle resize-${handle}`}
                    onPointerDown={(event) => beginResize(hit, handle, event)}
                  />
                ))}
              </button>
            );
          })}
          {draftRect && redacted && (
            <span
              className="redaction-box is-draft"
              style={rectStyle(draftRect, preview.pageWidth, preview.pageHeight)}
            />
          )}
        </div>
      </figure>
    );
  }

  async function processFiles(): Promise<void> {
    if (!canRun) return;
    setIsRunning(true);
    setError(null);
    setResults([]);
    setLogs([]);
    console.groupCollapsed("[PrivyPDF] Redaction run");
    console.debug("[PrivyPDF] Files", files.map((file) => ({ name: file.name, size: file.size })));
    console.debug("[PrivyPDF] Selected fields", [...selected]);

    try {
      const processed: ProcessResult[] = [];
      for (let index = 0; index < files.length; index += 1) {
        const file = files[index];
        setLogs((current) => [...current, `[${index + 1}/${files.length}] ${file.name}`]);

        const result = await redactPdfFile(
          file,
          activeRules,
          {
            selectedKeys: [...selected],
            customValues: splitCsv(customValues),
            allEmails,
            allRegex,
            padding,
            fileId: fileId(file),
            ignoredHitKeys: [...ignoredHitKeys],
            manualRedactions,
            debug: (message, details) => {
              console.debug(`[PrivyPDF] ${message}`, details ?? "");
            }
          },
          (nextProgress) => {
            setProgress(nextProgress);
            console.debug("[PrivyPDF] Progress", nextProgress);
          }
        );

        processed.push(result);
        setResults([...processed]);
        setLogs((current) => [...current, `Done: ${result.outputName} (${result.hits.length} redaction boxes)`]);
      }
      setProgress(null);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Something went wrong while processing the PDF.";
      console.error("[PrivyPDF] Redaction failed", caught);
      setError(message);
      log(`Error: ${message}`);
    } finally {
      console.groupEnd();
      setIsRunning(false);
    }
  }

  return (
    <main className="app">
      <header className="app-header">
        <div>
          <p className="eyebrow">Browser-only PDF redaction</p>
          <h1>PrivyPDF Redactor</h1>
          <p className="lead">
            Attach PDF form responses, choose what to hide, and download redacted copies.
            Files stay in your browser; nothing is uploaded to a server.
          </p>
        </div>
        <div className="privacy-badge">
          <strong>Local</strong>
          <span>No backend upload</span>
        </div>
      </header>

      <section className="panel file-panel">
        <div>
          <h2>PDF Files</h2>
          <p>Select one or more PDFs. Results keep the original name with a redacted suffix.</p>
        </div>
        <div className="upload-zone">
          <input
            ref={fileInputRef}
            type="file"
            accept="application/pdf,.pdf"
            multiple
            onChange={(event) => {
              setFiles(Array.from(event.currentTarget.files ?? []));
              setIgnoredHitKeys(new Set());
              setManualRedactions([]);
              setSelectedHitKey(null);
            }}
          />
          <button
            type="button"
            className="upload-button"
            onClick={() => fileInputRef.current?.click()}
          >
            Choose PDF files
          </button>
          <small>{files.length > 0 ? `${files.length} file(s) ready` : "Drop-in browser workflow for GitHub Pages"}</small>
        </div>
      </section>

      <section className="workspace">
        <div className="panel">
          <div className="panel-head">
            <div>
              <h2>What to Hide</h2>
              <p>{analysisStatus}</p>
            </div>
            <div className="button-row">
              <button type="button" onClick={selectDefaults}>Default</button>
              <button type="button" onClick={selectAll}>All</button>
              <button type="button" onClick={clearSelection}>Clear</button>
            </div>
          </div>

          <div className="rule-grid">
            {displayRules.map((rule) => (
              <label
                key={rule.key}
                className={`rule-card ${files.length > 0 && (availabilityByKey.get(rule.key)?.count ?? 0) === 0 ? "is-disabled" : ""}`}
              >
                <input
                  type="checkbox"
                  checked={selected.has(rule.key)}
                  disabled={files.length > 0 && (availabilityByKey.get(rule.key)?.count ?? 0) === 0}
                  onChange={() => toggleRule(rule.key)}
                />
                <span>
                  <strong>{rule.title}</strong>
                  <small>{rule.description}</small>
                  {files.length > 0 && (
                    <small className="detected-text">
                      {(availabilityByKey.get(rule.key)?.count ?? 0) > 0
                        ? `Detected: ${(availabilityByKey.get(rule.key)?.labels ?? []).join(", ")}`
                        : "Not found in this PDF"}
                    </small>
                  )}
                  {(availabilityByKey.get(rule.key)?.samples?.length ?? 0) > 0 && (
                    <small className="sample-text">
                      Sample: {availabilityByKey.get(rule.key)?.samples.join(", ")}
                    </small>
                  )}
                </span>
              </label>
            ))}
          </div>
        </div>

        <aside className="panel settings-panel">
          <h2>Add Field</h2>
          <label>
            Field name
            <input
              value={draft.title}
              placeholder="Student IDs"
              onChange={(event) => setDraft({ ...draft, title: event.target.value })}
            />
          </label>
          <label>
            Labels in PDF
            <input
              value={draft.labels}
              placeholder="Student ID, Participant ID"
              onChange={(event) => setDraft({ ...draft, labels: event.target.value })}
            />
          </label>
          <label>
            Value type
            <select
              value={draft.validator}
              onChange={(event) => setDraft({ ...draft, validator: event.target.value as Validator })}
            >
              {validators.map((validator) => (
                <option key={validator.value} value={validator.value}>
                  {validator.label}
                </option>
              ))}
            </select>
          </label>
          <label className="inline-check">
            <input
              type="checkbox"
              checked={draft.enabledByDefault}
              onChange={(event) => setDraft({ ...draft, enabledByDefault: event.target.checked })}
            />
            Enable by default
          </label>
          <button type="button" className="secondary-action" onClick={addCustomField}>
            Add custom field
          </button>

          <hr />

          <h2>Options</h2>
          <label>
            Exact values
            <input
              value={customValues}
              placeholder="Nikita Alimbayev, alimbayev@example.com"
              onChange={(event) => setCustomValues(event.target.value)}
            />
          </label>
          <label>
            Box padding
            <input
              type="number"
              min={0}
              max={12}
              value={padding}
              onChange={(event) => setPadding(Number(event.target.value))}
            />
          </label>
          <label className="inline-check">
            <input
              type="checkbox"
              checked={allEmails}
              onChange={(event) => setAllEmails(event.target.checked)}
            />
            Hide every email in the document
          </label>
          <label className="inline-check">
            <input
              type="checkbox"
              checked={allRegex}
              onChange={(event) => setAllRegex(event.target.checked)}
            />
            Apply regex fields globally
          </label>
        </aside>
      </section>

      <section className="panel preview-panel">
        <div className="panel-head">
          <div>
            <h2>Live Preview</h2>
            <p>{previewStatus}</p>
          </div>
        </div>

        {preview ? (
          <>
            <div className="preview-meta">
              <span>
                {isPreviewLoading
                  ? "Updating preview..."
                  : `${preview.totalHits} active / ${preview.totalDetectedHits} detected redaction box(es)`}
              </span>
              <span>{files.length > 1 ? `Document ${previewFileIndex + 1} of ${files.length}` : "Single document"}</span>
            </div>
            {files.length > 1 && (
              <label className="document-picker">
                Document
                <select
                  className="document-select"
                  value={previewFileIndex}
                  disabled={isPreviewLoading}
                  onChange={(event) => setPreviewFileIndex(Number(event.target.value))}
                >
                  {files.map((file, index) => (
                    <option key={`${file.name}-${index}`} value={index}>
                      {file.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <div className="preview-tools">
              <div className="segmented-control">
                <button
                  type="button"
                  className={previewMode === "split" ? "is-active" : ""}
                  onClick={() => setPreviewMode("split")}
                >
                  Split
                </button>
                <button
                  type="button"
                  className={previewMode === "original" ? "is-active" : ""}
                  onClick={() => setPreviewMode("original")}
                >
                  Original
                </button>
                <button
                  type="button"
                  className={previewMode === "redacted" ? "is-active" : ""}
                  onClick={() => setPreviewMode("redacted")}
                >
                  Redacted
                </button>
              </div>
              <div className="zoom-control">
                <button type="button" onClick={() => setZoom((value) => clamp(value - 0.15, 0.6, 2.4))}>-</button>
                <input
                  type="range"
                  min={0.6}
                  max={2.4}
                  step={0.05}
                  value={zoom}
                  onChange={(event) => setZoom(Number(event.target.value))}
                />
                <button type="button" onClick={() => setZoom((value) => clamp(value + 0.15, 0.6, 2.4))}>+</button>
                <span>{Math.round(zoom * 100)}%</span>
              </div>
              <button
                type="button"
                className={isDrawingManualBox ? "is-active" : ""}
                disabled={!redactionToolsEnabled}
                onClick={() => {
                  setIsDrawingManualBox((value) => !value);
                  setDragDraft(null);
                }}
              >
                Add box
              </button>
              <button type="button" disabled={!redactionToolsEnabled || !selectedHitKey} onClick={removeSelectedHit}>
                Restore selected
              </button>
            </div>
            {preview.hitsOnPage.length > 0 && redactionToolsEnabled && (
              <div className="redaction-object-panel">
                <div>
                  <h3>Redaction objects</h3>
                  <p>Select an object to restore or resize it.</p>
                </div>
                <div className="redaction-list">
                  {preview.hitsOnPage.map((hit, index) => (
                    <button
                      type="button"
                      key={hit.key}
                      className={selectedHitKey === hit.key ? "is-selected" : ""}
                      onClick={() => setSelectedHitKey(hit.key)}
                    >
                      <strong>{index + 1}. {hit.reason}</strong>
                      <span>{hit.source === "auto" ? "Auto" : "Manual"} · {hit.text}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div className={`preview-grid preview-grid-${previewMode}`}>
              {(previewMode === "split" || previewMode === "original") && renderPreviewSurface("Original", false)}
              {(previewMode === "split" || previewMode === "redacted") && renderPreviewSurface("Redacted", true)}
            </div>
            <div className="preview-page-nav">
              <button
                type="button"
                disabled={!preview || preview.pageIndex === 0 || isPreviewLoading}
                onClick={() => setPreviewPage((page) => Math.max(0, page - 1))}
              >
                Previous
              </button>
              <label className="page-picker">
                Page
                <input
                  type="number"
                  min={1}
                  max={preview.totalPages}
                  value={preview.pageIndex + 1}
                  disabled={isPreviewLoading}
                  onChange={(event) => {
                    const page = Number(event.target.value);
                    if (!Number.isNaN(page)) {
                      setPreviewPage(clamp(page, 1, preview.totalPages) - 1);
                    }
                  }}
                />
                <span>of {preview.totalPages}</span>
              </label>
              {preview.pageIndex < preview.totalPages - 1 && (
                <button
                  type="button"
                  disabled={isPreviewLoading}
                  onClick={() => setPreviewPage((page) => page + 1)}
                >
                  {pageLabel(preview)}
                </button>
              )}
            </div>
          </>
        ) : (
          <div className="preview-empty">
            <span>{isPreviewLoading ? "Rendering preview..." : "No preview yet"}</span>
          </div>
        )}
      </section>

      <section className="panel run-panel">
        <div>
          <h2>Run</h2>
          <p>
            Selected fields: {selectedCount}. Files: {files.length}. Redaction boxes found: {totalHits}.
          </p>
        </div>
        <button type="button" className="primary-action" disabled={!canRun} onClick={processFiles}>
          {isRunning ? "Processing..." : "Redact PDFs"}
        </button>
      </section>

      {(progress || logs.length > 0 || error || results.length > 0) && (
        <section className="panel results-panel">
          {progress && (
            <div className="progress-block">
              <progress value={progress.page} max={progress.totalPages} />
              <span>{progress.message}</span>
            </div>
          )}

          {error && <p className="error">{error}</p>}

          {results.length > 0 && (
            <div className="downloads">
              {results.map((result) => (
                <button
                  type="button"
                  key={result.outputName}
                  onClick={() => downloadBlob(result.blob, result.outputName)}
                >
                  Download {result.outputName}
                </button>
              ))}
            </div>
          )}

          <pre>{logs.join("\n")}</pre>
        </section>
      )}
      <footer className="app-footer">© Created by Alimbayev Nikita</footer>
    </main>
  );
}
