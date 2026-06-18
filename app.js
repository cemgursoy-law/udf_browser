/* ============================================================
   app.js  —  arayüz: dosya seçimi, sürükle-bırak, tema, dönüştürme
   ============================================================ */

const TARGETS = {
  ".udf":  [["Word (.docx)", ".docx"], ["PDF (.pdf)", ".pdf"]],
  ".docx": [["UDF (.udf)", ".udf"],    ["PDF (.pdf)", ".pdf"]],
  ".pdf":  [["UDF (.udf)", ".udf"],    ["Word (.docx)", ".docx"]],
};
const TYPE_LABEL = { ".udf": "UDF", ".docx": "Word", ".pdf": "PDF" };

let inFiles = [];      // [{name, ext, buffer}]
let inExt = null;
let targetExt = null;

// ---- kısayollar ----
const $ = (s) => document.querySelector(s);
const dropzone = $("#dropzone");
const fileInput = $("#fileInput");
const dzBody = $("#dzBody");
const stepTarget = $("#stepTarget");
const segment = $("#segment");
const convertBtn = $("#convertBtn");
const progress = $("#progress");
const statusEl = $("#status");
const results = $("#results");

// ============================================================
//  TEMA
// ============================================================
const themeBtn = $("#themeBtn");
function setTheme(dark) {
  document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
  themeBtn.querySelector(".label").textContent = dark ? "Açık tema" : "Koyu tema";
  try { localStorage.setItem("udf-theme", dark ? "dark" : "light"); } catch (e) {}
}
themeBtn.addEventListener("click", () => {
  const isDark = document.documentElement.getAttribute("data-theme") === "dark";
  setTheme(!isDark);
});
// kayıtlı tema / sistem tercihi
(() => {
  let saved = null;
  try { saved = localStorage.getItem("udf-theme"); } catch (e) {}
  if (saved) setTheme(saved === "dark");
  else setTheme(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
})();

// ============================================================
//  DOSYA SEÇİMİ
// ============================================================
dropzone.addEventListener("click", () => fileInput.click());
dropzone.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.click(); }
});
fileInput.addEventListener("change", () => {
  if (fileInput.files.length) handleFiles([...fileInput.files]);
});

// sürükle-bırak
["dragenter", "dragover"].forEach(ev =>
  dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add("drag"); }));
["dragleave", "drop"].forEach(ev =>
  dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.remove("drag"); }));
dropzone.addEventListener("drop", (e) => {
  const files = [...(e.dataTransfer?.files || [])];
  if (files.length) handleFiles(files);
});

function extOf(name) {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i).toLowerCase() : "";
}

async function handleFiles(files) {
  resetResults();
  const exts = new Set(files.map(f => extOf(f.name)));
  if (exts.size > 1) {
    setStatus("Toplu dönüştürmede tüm dosyalar aynı türde olmalı (hepsi .docx gibi).", "warn");
    return;
  }
  const ext = [...exts][0];
  if (!TARGETS[ext]) {
    setStatus("Desteklenmeyen tür: " + ext + ". Yalnızca .udf, .docx, .pdf.", "warn");
    return;
  }

  // dosyaları belleğe oku
  inFiles = [];
  for (const f of files) {
    const buffer = await f.arrayBuffer();
    inFiles.push({ name: f.name, ext, buffer });
  }
  inExt = ext;

  // dropzone gövdesini güncelle
  const label = TYPE_LABEL[ext];
  const badgeCls = ext.slice(1);
  dropzone.classList.add("has-file");
  if (files.length === 1) {
    dzBody.innerHTML =
      `<span class="file-chip"><span class="badge ${badgeCls}">${label}</span>` +
      `<span class="fname">${escapeHtml(files[0].name)}</span></span>`;
  } else {
    dzBody.innerHTML =
      `<span class="file-chip"><span class="badge ${badgeCls}">${label}</span>` +
      `<span class="fname">${files.length} dosya seçildi</span></span>`;
  }

  // hedef segmenti doldur
  buildSegment(TARGETS[ext]);
  stepTarget.classList.remove("disabled");
  convertBtn.disabled = false;
  setStatus("Hazır. Hedef formatı seçip Dönüştür'e basın.", "info");
}

function buildSegment(opts) {
  segment.innerHTML = "";
  targetExt = opts[0][1];
  opts.forEach(([label, ext], i) => {
    const b = document.createElement("button");
    b.textContent = label;
    if (i === 0) b.classList.add("active");
    b.addEventListener("click", () => {
      segment.querySelectorAll("button").forEach(x => x.classList.remove("active"));
      b.classList.add("active");
      targetExt = ext;
    });
    segment.appendChild(b);
  });
}

// ============================================================
//  DÖNÜŞTÜRME
// ============================================================
convertBtn.addEventListener("click", async () => {
  if (!inFiles.length || !targetExt) return;
  convertBtn.disabled = true;
  progress.classList.add("show");
  setStatus("Dönüştürülüyor…", "info");
  resetResults();

  const out = [];
  let okCount = 0;
  const errors = [];

  for (const f of inFiles) {
    try {
      const blob = await UDF.convert(f.buffer, f.ext, targetExt);
      const base = f.name.replace(/\.[^.]+$/, "");
      out.push({ name: base + targetExt, blob });
      okCount++;
    } catch (err) {
      errors.push(`${f.name}: ${err.message}`);
    }
  }

  progress.classList.remove("show");
  convertBtn.disabled = false;

  if (out.length) renderResults(out);

  if (errors.length === 0) {
    setStatus(`Tamamlandı — ${okCount} dosya hazır.`, "ok");
  } else if (okCount > 0) {
    setStatus(`${okCount} dosya hazır, ${errors.length} dosyada hata: ${errors[0]}`, "warn");
  } else {
    setStatus("Dönüştürme başarısız: " + errors[0], "warn");
  }
});

function renderResults(out) {
  results.innerHTML = "";
  out.forEach(({ name, blob }) => {
    const url = URL.createObjectURL(blob);
    const row = document.createElement("div");
    row.className = "result-row";
    row.innerHTML = `<span class="fname">${escapeHtml(name)}</span>`;
    const a = document.createElement("a");
    a.className = "dl";
    a.href = url;
    a.download = name;
    a.textContent = "İndir";
    row.appendChild(a);
    results.appendChild(row);
  });
  // tek dosyaysa otomatik indir
  if (out.length === 1) {
    const a = results.querySelector(".dl");
    a.click();
  }
}

// ============================================================
//  yardımcılar
// ============================================================
function setStatus(msg, kind) {
  statusEl.textContent = msg;
  statusEl.className = "status " + (kind || "");
}
function resetResults() { results.innerHTML = ""; }
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
