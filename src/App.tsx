import { useEffect, useMemo, useRef, useState } from "react";
import { defaultRules, type RedactionRule, type Validator } from "./rules";
import {
  analyzePdfFiles,
  redactPdfFile,
  type FieldAnalysis,
  type DocumentAnalysis,
  type ProcessProgress,
  type ProcessResult
} from "./pdfRedactor";

type CustomFieldDraft = {
  title: string;
  labels: string;
  validator: Validator;
  enabledByDefault: boolean;
};

const validators: Array<{ value: Validator; label: string }> = [
  { value: "free_text", label: "Any text" },
  { value: "name", label: "Name" },
  { value: "email", label: "Email" },
  { value: "phone", label: "Phone" },
  { value: "age", label: "Age" }
];

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

export default function App() {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
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
  const [logs, setLogs] = useState<string[]>([]);
  const [analysis, setAnalysis] = useState<DocumentAnalysis | null>(null);
  const [analysisStatus, setAnalysisStatus] = useState("Attach PDFs to inspect available fields.");
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedCount = selected.size;
  const canRun = files.length > 0 && selectedCount > 0 && !isRunning;
  const availabilityByKey = useMemo(
    () => new Map((analysis?.fields ?? []).map((field) => [field.key, field])),
    [analysis]
  );

  const totalHits = useMemo(
    () => results.reduce((total, result) => total + result.hits.length, 0),
    [results]
  );

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
        const availableDefaults = nextAnalysis.fields
          .filter((field) => field.count > 0)
          .map((field) => field.key);
        setSelected((current) => {
          const retained = [...current].filter((key) => availableDefaults.includes(key));
          return new Set(retained.length > 0 ? retained : availableDefaults);
        });
        setAnalysisStatus(
          `Found ${nextAnalysis.fields.filter((field) => field.count > 0).length} supported field type(s), ${nextAnalysis.spanCount} text item(s).`
        );
        const found = nextAnalysis.fields
          .filter((field) => field.count > 0)
          .map((field) => `${field.title}: ${field.labels.join(", ")}`);
        const missingDefaults = rules
          .filter((rule) => rule.enabledByDefault)
          .filter((rule) => (nextAnalysis.fields.find((field) => field.key === rule.key)?.count ?? 0) === 0)
          .map((rule) => rule.title);
        const nextLogs = [
          `Inspection complete: ${nextAnalysis.pageCount} page(s), ${nextAnalysis.spanCount} text item(s).`,
          found.length > 0 ? `Available fields: ${found.join(" | ")}` : "No built-in fields were found.",
          ...missingDefaults.map((title) => `${title} not found in this PDF.`)
        ];
        if (nextAnalysis.suggestedLabels.length > 0) {
          nextLogs.push(`Other possible labels: ${nextAnalysis.suggestedLabels.join(", ")}. Add one in Add Field if it should be hidden.`);
        }
        setLogs(nextLogs);
      })
      .catch((caught) => {
        if (cancelled) return;
        const message = caught instanceof Error ? caught.message : "Could not inspect this PDF.";
        setAnalysis(null);
        setAnalysisStatus("Could not inspect fields.");
        setError(message);
        log("Field inspection failed.", { message });
      });

    return () => {
      cancelled = true;
    };
  }, [files, rules]);

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
    const keys = rules
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
      if (analysis) {
        const missing: FieldAnalysis[] = [];
        for (const key of selected) {
          const field = availabilityByKey.get(key);
          if (field && field.count === 0) {
            missing.push(field);
          }
        }
        for (const field of missing) {
          log(`${field.title} not found in the uploaded PDF.`);
        }
        const suggestions = analysis.suggestedLabels.filter(Boolean);
        if (suggestions.length > 0) {
          log(`Other possible PDF labels detected: ${suggestions.join(", ")}. Add one in Add Field if it should be hidden.`);
        }
      }

      const processed: ProcessResult[] = [];
      for (let index = 0; index < files.length; index += 1) {
        const file = files[index];
        setLogs((current) => [...current, `[${index + 1}/${files.length}] ${file.name}`]);

        const result = await redactPdfFile(
          file,
          rules,
          {
            selectedKeys: [...selected],
            customValues: splitCsv(customValues),
            allEmails,
            allRegex,
            padding,
            debug: (message, details) => log(message, details)
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
            onChange={(event) => setFiles(Array.from(event.currentTarget.files ?? []))}
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
            {rules.map((rule) => (
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
          {analysis && analysis.suggestedLabels.length > 0 && (
            <p className="suggestion-text">
              Other labels found: {analysis.suggestedLabels.join(", ")}. Add one as a custom field if it should be hidden.
            </p>
          )}
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
              placeholder="Jane Doe, jane@example.com"
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
