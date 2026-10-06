import Head from "next/head";
import { useState, useEffect, useRef, useMemo } from "react";
import Papa from "papaparse";
import Chart from "chart.js/auto";
import styles from "./index.module.css";

const AUTHOR = "Ibrahim Khan Shovo";
const PALETTE = ["#2f6fde", "#e8833a", "#2a9d8f", "#c0448f", "#8a6fd1", "#d4a017", "#4c9f38", "#d1495b", "#5b7083", "#17a2b8", "#a05a2c", "#6c757d"];

const SAMPLE_CSV = `month,region,product,units,revenue
Jan,East,Phones,120,48000
Jan,West,Phones,95,38000
Jan,East,Laptops,40,36000
Jan,West,Laptops,55,49500
Feb,East,Phones,135,54000
Feb,West,Phones,110,44000
Feb,East,Laptops,48,43200
Feb,West,Laptops,50,45000
Mar,East,Phones,150,60000
Mar,West,Phones,128,51200
Mar,East,Laptops,62,55800
Mar,West,Laptops,58,52200
Apr,East,Phones,142,56800
Apr,West,Phones,160,64000
Apr,East,Laptops,70,63000
Apr,West,Laptops,66,59400
May,East,Phones,170,68000
May,West,Phones,155,62000
May,East,Laptops,75,67500
May,West,Laptops,81,72900`;

const isNum = (v) => typeof v === "number" && Number.isFinite(v);

// Turn uploaded text into an array of row objects.
function parseData(text, filename) {
  if (/\.json$/i.test(filename)) {
    const json = JSON.parse(text);
    const rows = Array.isArray(json) ? json : Object.values(json).find(Array.isArray);
    if (!rows || !rows.length || typeof rows[0] !== "object") throw new Error("JSON must contain an array of objects.");
    return rows;
  }
  const out = Papa.parse(text.trim(), { header: true, dynamicTyping: true, skipEmptyLines: true });
  if (!out.data.length) throw new Error("No rows found in the file.");
  return out.data;
}

// Per-column summary: used for the UI controls and sent to the AI (instead of the whole file).
function profileData(rows) {
  const names = Object.keys(rows[0] || {});
  const columns = names.map((name) => {
    const vals = rows.map((r) => r[name]).filter((v) => v !== null && v !== undefined && v !== "");
    const nums = vals.filter(isNum);
    const numeric = vals.length > 0 && nums.length / vals.length > 0.9;
    const col = { name, type: numeric ? "number" : "text", unique: new Set(vals).size, missing: rows.length - vals.length };
    if (numeric) {
      col.min = Math.min(...nums);
      col.max = Math.max(...nums);
      col.mean = +(nums.reduce((a, b) => a + b, 0) / nums.length).toFixed(3);
    } else {
      col.examples = [...new Set(vals)].slice(0, 8);
    }
    return col;
  });
  return { rowCount: rows.length, columns, sampleRows: rows.slice(0, 15) };
}

function buildChartConfig(rows, { type, x, y, agg, title }) {
  const raw = agg === "none" || type === "scatter";
  let labels, values, datasets;

  if (type === "scatter") {
    const pts = rows.filter((r) => isNum(r[x]) && isNum(r[y])).slice(0, 2000).map((r) => ({ x: r[x], y: r[y] }));
    datasets = [{ label: `${y} vs ${x}`, data: pts, backgroundColor: PALETTE[0] + "b3" }];
  } else {
    if (raw) {
      const kept = rows.filter((r) => isNum(r[y])).slice(0, 500);
      labels = kept.map((r) => String(r[x]));
      values = kept.map((r) => r[y]);
    } else {
      const groups = new Map(); // keeps first-seen order (e.g. Jan, Feb, Mar)
      for (const r of rows) {
        const k = String(r[x] ?? "(blank)");
        const g = groups.get(k) || { sum: 0, n: 0, count: 0 };
        g.count += 1;
        if (isNum(r[y])) { g.sum += r[y]; g.n += 1; }
        groups.set(k, g);
      }
      let entries = [...groups].map(([k, g]) => [k, agg === "count" ? g.count : agg === "avg" ? (g.n ? g.sum / g.n : 0) : g.sum]);
      const cap = type === "pie" ? 11 : 40;
      if (entries.length > cap) {
        entries.sort((a, b) => b[1] - a[1]);
        const rest = entries.slice(cap);
        entries = entries.slice(0, cap);
        if (agg !== "avg") entries.push(["Other", rest.reduce((s, e) => s + e[1], 0)]);
      }
      labels = entries.map((e) => e[0]);
      values = entries.map((e) => +e[1].toFixed(2));
    }
    const yLabel = raw ? y : agg === "count" ? "count of rows" : `${agg} of ${y}`;
    datasets = [{
      label: yLabel,
      data: values,
      backgroundColor: type === "pie" ? labels.map((_, i) => PALETTE[i % PALETTE.length]) : PALETTE[0],
      borderColor: type === "pie" ? "#fff" : PALETTE[0],
      borderWidth: type === "bar" ? 0 : 2,
      borderRadius: type === "bar" ? 4 : 0,
      tension: 0.25,
      pointRadius: 3,
    }];
  }

  const yTitle = datasets[0].label;
  return {
    type,
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: type === "pie", position: "right" },
        title: { display: true, text: title || (type === "scatter" ? `${y} vs ${x}` : `${yTitle} by ${x}`), font: { size: 16 } },
      },
      scales: type === "pie" ? {} : {
        x: { title: { display: true, text: x }, grid: { display: type === "scatter" } },
        y: { title: { display: true, text: type === "scatter" ? y : yTitle }, beginAtZero: type === "bar" },
      },
    },
  };
}

export default function Home() {
  const [rows, setRows] = useState([]);
  const [fileName, setFileName] = useState("");
  const [error, setError] = useState("");
  const [spec, setSpec] = useState({ type: "bar", x: "", y: "", agg: "sum", title: "" });
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [aiNote, setAiNote] = useState("");
  const [loading, setLoading] = useState("");
  const [dragging, setDragging] = useState(false);
  const canvasRef = useRef(null);
  const chartRef = useRef(null);

  const profile = useMemo(() => (rows.length ? profileData(rows) : null), [rows]);
  const columns = profile ? profile.columns : [];
  const numericCols = columns.filter((c) => c.type === "number");

  function loadText(text, name) {
    try {
      const data = parseData(text, name);
      const p = profileData(data);
      const nums = p.columns.filter((c) => c.type === "number");
      const firstText = p.columns.find((c) => c.type === "text");
      setRows(data);
      setFileName(name);
      setError("");
      setAnswer("");
      setAiNote("");
      setSpec({
        type: "bar",
        x: (firstText || p.columns[0]).name,
        y: nums.length ? nums[nums.length - 1].name : p.columns[0].name,
        agg: nums.length ? "sum" : "count",
        title: "",
      });
    } catch (e) {
      setError(`Could not read "${name}": ${e.message}`);
    }
  }

  function onFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => loadText(String(reader.result), file.name);
    reader.onerror = () => setError("Could not read the file.");
    reader.readAsText(file);
  }

  // Redraw the chart whenever the data or the chart settings change.
  useEffect(() => {
    if (chartRef.current) { chartRef.current.destroy(); chartRef.current = null; }
    if (!rows.length || !canvasRef.current || !spec.x || !spec.y) return;
    chartRef.current = new Chart(canvasRef.current, buildChartConfig(rows, spec));
    return () => { if (chartRef.current) { chartRef.current.destroy(); chartRef.current = null; } };
  }, [rows, spec]);

  async function callAI(mode) {
    setLoading(mode);
    setError("");
    try {
      const response = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode, profile, question }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `Request failed with status ${response.status}`);
      if (mode === "suggest") {
        const s = data.suggestion || {};
        const names = columns.map((c) => c.name);
        if (!names.includes(s.x) || !names.includes(s.y)) throw new Error("AI suggested columns that are not in the data. Try again.");
        setSpec({
          type: ["bar", "line", "scatter", "pie"].includes(s.type) ? s.type : "bar",
          x: s.x,
          y: s.y,
          agg: ["sum", "avg", "count", "none"].includes(s.agg) ? s.agg : "sum",
          title: s.title || "",
        });
        setAiNote(s.reason || "");
      } else {
        setAnswer(data.result);
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading("");
    }
  }

  const set = (key) => (e) => setSpec((s) => ({ ...s, [key]: e.target.value, title: "" }));

  return (
    <div className={styles.page}>
      <Head>
        <title>DataViz AI — {AUTHOR}</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </Head>

      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>📊 DataViz AI</h1>
          <p className={styles.subtitle}>Upload your data, chart it, and ask AI about it</p>
        </div>
        <div className={styles.author}>
          Built by <strong>{AUTHOR}</strong>
          <span>CPS 5745 · Interactive Information Visualization</span>
        </div>
      </header>

      <main className={styles.main}>
        <section className={styles.card}>
          <h2>1. Upload data</h2>
          <label
            className={`${styles.dropzone} ${dragging ? styles.dragging : ""}`}
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => { e.preventDefault(); setDragging(false); onFile(e.dataTransfer.files[0]); }}
          >
            <input type="file" accept=".csv,.tsv,.txt,.json" hidden onChange={(e) => { onFile(e.target.files[0]); e.target.value = ""; }} />
            <strong>Click to choose a file</strong> or drag it here
            <span>CSV, TSV or JSON (array of objects) · the file stays in your browser</span>
          </label>
          <div className={styles.row}>
            <button className={styles.secondary} type="button" onClick={() => loadText(SAMPLE_CSV, "sample_sales.csv")}>
              Load sample data
            </button>
            {fileName && <span className={styles.meta}>{fileName} · {rows.length.toLocaleString()} rows · {columns.length} columns</span>}
          </div>
          {error && <p className={styles.error}>{error}</p>}
        </section>

        {rows.length > 0 && (
          <>
            <section className={styles.card}>
              <h2>2. Chart</h2>
              <div className={styles.controls}>
                <label>Chart type
                  <select value={spec.type} onChange={set("type")}>
                    <option value="bar">Bar</option>
                    <option value="line">Line</option>
                    <option value="scatter">Scatter</option>
                    <option value="pie">Pie</option>
                  </select>
                </label>
                <label>X axis / category
                  <select value={spec.x} onChange={set("x")}>
                    {(spec.type === "scatter" ? numericCols : columns).map((c) => <option key={c.name}>{c.name}</option>)}
                  </select>
                </label>
                <label>Y axis / value
                  <select value={spec.y} onChange={set("y")}>
                    {(numericCols.length ? numericCols : columns).map((c) => <option key={c.name}>{c.name}</option>)}
                  </select>
                </label>
                <label>Aggregate
                  <select value={spec.agg} onChange={set("agg")} disabled={spec.type === "scatter"}>
                    <option value="sum">Sum</option>
                    <option value="avg">Average</option>
                    <option value="count">Count rows</option>
                    <option value="none">None (raw rows)</option>
                  </select>
                </label>
                <button className={styles.primary} type="button" disabled={!!loading} onClick={() => callAI("suggest")}>
                  {loading === "suggest" ? "Thinking…" : "✨ AI: suggest a chart"}
                </button>
              </div>
              {aiNote && <p className={styles.aiNote}><strong>AI:</strong> {aiNote}</p>}
              <div className={styles.chartWrap}><canvas ref={canvasRef} /></div>
            </section>

            <section className={styles.card}>
              <h2>3. Ask AI about your data</h2>
              <form className={styles.askForm} onSubmit={(e) => { e.preventDefault(); callAI("ask"); }}>
                <input
                  type="text"
                  placeholder="e.g. Which region is growing fastest? (leave empty for a summary)"
                  value={question}
                  onChange={(e) => setQuestion(e.target.value)}
                />
                <button className={styles.primary} type="submit" disabled={!!loading}>
                  {loading === "ask" ? "Thinking…" : "Ask"}
                </button>
              </form>
              {answer && <div className={styles.answer}>{answer}</div>}
            </section>

            <section className={styles.card}>
              <h2>4. Data preview <span className={styles.meta}>first {Math.min(rows.length, 50)} of {rows.length.toLocaleString()} rows</span></h2>
              <div className={styles.tableWrap}>
                <table className={styles.table}>
                  <thead>
                    <tr>{columns.map((c) => <th key={c.name}>{c.name}<small>{c.type}</small></th>)}</tr>
                  </thead>
                  <tbody>
                    {rows.slice(0, 50).map((r, i) => (
                      <tr key={i}>{columns.map((c) => <td key={c.name} className={c.type === "number" ? styles.num : ""}>{String(r[c.name] ?? "")}</td>)}</tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        )}
      </main>

      <footer className={styles.footer}>© 2026 {AUTHOR} · Next.js + Chart.js + OpenAI API</footer>
    </div>
  );
}
