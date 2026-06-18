/* ============================================================
   udf-core.js  —  UDF okuma/yazma + biçim dönüşümleri (tarayıcıda)
   Bağımlılıklar (global olarak yüklenir):
     JSZip            — ZIP okuma/yazma (UDF'nin temeli)
     mammoth          — DOCX -> metin/html (okuma)
     docx (UMD)       — DOCX yazma  (window.docx)
     jspdf            — PDF yazma   (window.jspdf)
     pdfjsLib         — PDF okuma   (window.pdfjsLib)
     UDF_PDF_FONTS    — PDF yazımı için Türkçe destekli gömülü font (window.UDF_PDF_FONTS)
   ============================================================ */

const UDF = (() => {
  const LEFT = 0, CENTER = 1, RIGHT = 2, JUSTIFY = 3;

  // ---------- UDF YAZMA ----------
  // paragraphs: [{text, align(0-3), bold}]
  async function writeUDF(paragraphs, font = "Times New Roman", size = 12) {
    let full = "";
    const specs = [];
    for (const p of paragraphs) {
      const text = p.text || "";
      const start = full.length;
      full += text + "\n";
      specs.push({ start, len: text.length + 1, align: p.align || 0, bold: !!p.bold });
    }

    const out = [];
    out.push('<?xml version="1.0" encoding="UTF-8" ?>');
    out.push('<template format_id="1.7">');
    out.push('<content><![CDATA[' + full + ']]></content>');
    out.push('<properties><pageFormat mediaSizeName="1" ' +
      'leftMargin="56.7" rightMargin="56.7" topMargin="56.7" bottomMargin="56.7" ' +
      'paperOrientation="1" headerFOffset="20.0" footerFOffset="20.0" /></properties>');
    out.push('<elements resolver="hvl-default">');
    for (const s of specs) {
      const cattr = (s.bold ? 'bold="true" ' : '') + `size="${size}" family="${font}" `;
      out.push(`<paragraph Alignment="${s.align}" resolver="hvl-default">`);
      out.push(`<content ${cattr}startOffset="${s.start}" length="${s.len}" />`);
      out.push('</paragraph>');
    }
    out.push('</elements>');
    out.push('<styles>');
    out.push('<style name="default" description="Geçerli" italic="false" bold="false" ' +
      'FONT_ATTRIBUTE_KEY="javax.swing.plaf.FontUIResource[family=Tahoma,name=Tahoma,style=plain,size=11]" ' +
      'size="11" family="Tahoma" />');
    out.push(`<style name="hvl-default" description="Gövde" size="${size}" family="${font}" />`);
    out.push('</styles>');
    out.push('</template>');
    const xml = out.join("\n");

    const zip = new JSZip();
    zip.file("content.xml", xml);
    return await zip.generateAsync({ type: "blob", compression: "DEFLATE" });
  }

  // ---------- UDF OKUMA ----------
  async function readUDF(arrayBuffer) {
    const zip = await JSZip.loadAsync(arrayBuffer);
    let cname = zip.file("content.xml") ? "content.xml" : Object.keys(zip.files)[0];
    const raw = await zip.file(cname).async("string");

    const m = raw.match(/<content>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/content>/);
    const fullText = m ? m[1] : "";

    const paras = [];
    const pRe = /<paragraph\b([^>]*)>([\s\S]*?)<\/paragraph>/g;
    let pm;
    while ((pm = pRe.exec(raw)) !== null) {
      const pattr = pm[1], inner = pm[2];
      const am = pattr.match(/Alignment="(\d+)"/);
      const align = am ? parseInt(am[1], 10) : 0;

      let seg = "", boldFlags = [];
      const cRe = /<content\b([^>]*?)\/?>/g;
      let cm;
      while ((cm = cRe.exec(inner)) !== null) {
        const cattr = cm[1];
        const sm = cattr.match(/startOffset="(\d+)"/);
        const lm = cattr.match(/length="(\d+)"/);
        if (sm && lm) {
          const s = parseInt(sm[1], 10), l = parseInt(lm[1], 10);
          seg += fullText.substring(s, s + l);
          boldFlags.push(/bold="true"/.test(cattr));
        }
      }
      const bold = boldFlags.length > 0 && (boldFlags.filter(Boolean).length * 2 >= boldFlags.length);
      paras.push({ text: seg.replace(/\n+$/, ""), align, bold });
    }

    if (paras.length === 0 && fullText) {
      fullText.split("\n").forEach(ln => paras.push({ text: ln, align: 0, bold: false }));
    }
    return paras;
  }

  // ---------- UDF OKUMA (zengin) ----------
  // UDF'i zengin modele çözer: görsel, liste, hizalama, girinti, per-run biçim.
  async function readRichUDF(arrayBuffer) {
    const zip = await JSZip.loadAsync(arrayBuffer);
    const cname = zip.file("content.xml") ? "content.xml" : Object.keys(zip.files)[0];
    const raw = await zip.file(cname).async("string");

    const cm = raw.match(/<content>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/content>/);
    const text = cm ? cm[1] : "";

    const out = [];
    const pRe = /<paragraph\b([^>]*)>([\s\S]*?)<\/paragraph>|<paragraph\b([^>]*)\/>/g;
    let pm;
    while ((pm = pRe.exec(raw)) !== null) {
      const pattr = pm[1] || pm[3] || "";
      const inner = pm[2] || "";

      // görsel?
      const im = inner.match(/<image\b([^>]*?)\/?>/);
      if (im) {
        const ia = im[1];
        const data = (ia.match(/imageData="([^"]*)"/) || [])[1] || "";
        const w = parseFloat((ia.match(/width="([\d.]+)"/) || [])[1] || "0");
        const h = parseFloat((ia.match(/height="([\d.]+)"/) || [])[1] || "0");
        if (data) { out.push({ type: "image", image: { base64: data, mime: "image/png", width: Math.round(w), height: Math.round(h) } }); continue; }
      }

      // hizalama / liste / girinti öznitelikleri
      const align = parseInt((pattr.match(/Alignment="(\d+)"/) || [])[1] || "0", 10);
      const leftIndent = parseFloat((pattr.match(/LeftIndent="([\d.]+)"/) || [])[1] || "0");
      let list = null;
      if (/Bulleted="true"/.test(pattr)) list = { kind: "bullet" };
      else if (/Numbered="true"/.test(pattr)) list = { kind: "number" };

      // içerik run'ları
      const runs = [];
      const cRe = /<content\b([^>]*?)\/?>/g;
      let c;
      while ((c = cRe.exec(inner)) !== null) {
        const ca = c[1];
        const so = parseInt((ca.match(/startOffset="(\d+)"/) || [])[1], 10);
        const ln = parseInt((ca.match(/length="(\d+)"/) || [])[1], 10);
        if (Number.isNaN(so) || Number.isNaN(ln)) continue;
        let seg = text.substring(so, so + ln);
        const bold = /bold="true"/.test(ca);
        const italic = /italic="true"/.test(ca);
        const size = parseInt((ca.match(/size="(\d+)"/) || [])[1] || "0", 10) || 0;
        runs.push({ text: seg, bold, italic, size });
      }

      // sondaki \n'i kaldır; sadece \n olan run = boş paragraf
      let merged = runs.map(r => r.text).join("");
      const isEmpty = merged.replace(/\n/g, "").length === 0;
      if (isEmpty) { out.push({ type: "empty" }); continue; }

      // run metinlerinden newline'ları temizle, boş run'ları at
      const cleanRuns = runs
        .map(r => ({ ...r, text: r.text.replace(/\n/g, "") }))
        .filter(r => r.text.length > 0);
      if (cleanRuns.length === 0) { out.push({ type: "empty" }); continue; }

      // ilk-satır girintisi: metin tab ile başlıyorsa
      let firstLineIndent = false;
      if (cleanRuns[0].text.startsWith("\t")) {
        firstLineIndent = true;
        cleanRuns[0] = { ...cleanRuns[0], text: cleanRuns[0].text.replace(/^\t+/, "") };
      }

      out.push({
        type: "text",
        runs: cleanRuns,
        align,
        list,
        leftIndent: list ? 0 : Math.round(leftIndent),
        firstLineIndent,
      });
    }
    return out;
  }

  // ---------- DOCX -> paragraphs ----------
  async function docxToParagraphs(arrayBuffer) {
    // mammoth ile HTML'e çevirip paragraf + hizalama + kalınlık çıkar
    const res = await mammoth.convertToHtml(
      { arrayBuffer },
      { includeDefaultStyleMap: true }
    );
    const div = document.createElement("div");
    div.innerHTML = res.value;

    const paras = [];
    const blocks = div.querySelectorAll("p, h1, h2, h3, h4, h5, h6, li");
    if (blocks.length === 0) {
      // düz metin yedeği
      (div.textContent || "").split("\n").forEach(t =>
        paras.push({ text: t.trim(), align: 0, bold: false }));
      return paras;
    }
    blocks.forEach(b => {
      const text = (b.textContent || "").trim();
      const style = (b.getAttribute("style") || "").toLowerCase();
      let align = 0;
      if (style.includes("text-align:center")) align = 1;
      else if (style.includes("text-align:right")) align = 2;
      else if (style.includes("text-align:justify")) align = 3;
      // başlık ya da tamamı kalın blok
      const tag = b.tagName.toLowerCase();
      const allBold = b.querySelector("strong,b") &&
        (b.textContent.trim() === (b.querySelector("strong,b")?.textContent || "").trim());
      const bold = tag.startsWith("h") || !!allBold;
      paras.push({ text, align, bold });
    });
    return paras;
  }

  // ---------- DOCX -> paragraphs (zengin, ham OOXML) ----------
  // mammoth hizalama/boyut/girinti/gerçek-liste bilgisini kaybettiği için
  // .docx (bir ZIP) içindeki word/document.xml'i doğrudan ayrıştırıyoruz.
  async function docxToRichParagraphs(arrayBuffer) {
    const zip = await JSZip.loadAsync(arrayBuffer);
    const docFile = zip.file("word/document.xml");
    if (!docFile) {
      // beklenmeyen yapı: mammoth yedeğine düş
      return (await docxToParagraphs(arrayBuffer)).map((p) => ({
        type: "text", runs: [{ text: p.text, bold: p.bold, italic: false, size: 0 }],
        align: p.align, list: null, leftIndent: 0, firstLineIndent: false,
      }));
    }
    const docXml = await docFile.async("string");

    // ilişkiler: rId -> hedef (medya yolu)
    const rels = {};
    const relsFile = zip.file("word/_rels/document.xml.rels");
    if (relsFile) {
      const r = await relsFile.async("string");
      for (const m of r.matchAll(/<Relationship\b[^>]*>/g)) {
        const id = (m[0].match(/Id="([^"]+)"/) || [])[1];
        const tgt = (m[0].match(/Target="([^"]+)"/) || [])[1];
        if (id && tgt) rels[id] = tgt;
      }
    }

    // numbering.xml: numId -> 'bullet' | 'number'
    const numKind = {};
    const numFile = zip.file("word/numbering.xml");
    if (numFile) {
      const nx = await numFile.async("string");
      const abstractFmt = {};
      for (const m of nx.matchAll(/<w:abstractNum\b[^>]*w:abstractNumId="(\d+)"[^>]*>([\s\S]*?)<\/w:abstractNum>/g)) {
        const lvl0 = m[2].match(/<w:lvl\b[^>]*w:ilvl="0"[^>]*>([\s\S]*?)<\/w:lvl>/);
        const fmt = lvl0 && lvl0[1].match(/<w:numFmt w:val="(\w+)"/);
        abstractFmt[m[1]] = fmt ? fmt[1] : "decimal";
      }
      for (const m of nx.matchAll(/<w:num\b[^>]*w:numId="(\d+)"[^>]*>\s*<w:abstractNumId w:val="(\d+)"/g)) {
        numKind[m[1]] = (abstractFmt[m[2]] === "bullet") ? "bullet" : "number";
      }
    }

    async function imageFor(rId) {
      const tgt = rels[rId];
      if (!tgt) return null;
      const clean = tgt.replace(/^\//, "");
      const path = clean.startsWith("word/") ? clean : "word/" + clean;
      const f = zip.file(path) || zip.file(clean);
      if (!f) return null;
      const base64 = await f.async("base64");
      const mime = /\.png$/i.test(tgt) ? "image/png" : /\.jpe?g$/i.test(tgt) ? "image/jpeg"
        : /\.gif$/i.test(tgt) ? "image/gif" : "image/png";
      return { base64, mime };
    }

    const doc = new DOMParser().parseFromString(docXml, "application/xml");
    const body = doc.getElementsByTagName("w:body")[0];
    if (!body) return [];

    const out = [];
    for (const p of [...body.children]) {
      if (p.nodeName !== "w:p") continue;

      // görsel?
      const blip = p.getElementsByTagName("a:blip")[0];
      if (blip) {
        const rId = blip.getAttribute("r:embed") || blip.getAttribute("r:link");
        const ext = p.getElementsByTagName("wp:extent")[0];
        let w = 0, h = 0;
        if (ext) { w = Math.round(parseInt(ext.getAttribute("cx"), 10) / 9525); h = Math.round(parseInt(ext.getAttribute("cy"), 10) / 9525); }
        const img = await imageFor(rId);
        if (img) { out.push({ type: "image", image: { base64: img.base64, mime: img.mime, width: w, height: h } }); continue; }
      }

      // paragraf özellikleri
      const pPr = p.getElementsByTagName("w:pPr")[0];
      let align = 0, list = null, leftIndent = 0, firstLineIndent = false;
      if (pPr) {
        const jc = [...pPr.children].find((c) => c.nodeName === "w:jc");
        if (jc) { const v = jc.getAttribute("w:val"); align = v === "center" ? 1 : (v === "right" || v === "end") ? 2 : (v === "both" || v === "distribute") ? 3 : 0; }
        const numPr = [...pPr.children].find((c) => c.nodeName === "w:numPr");
        if (numPr) {
          const numIdEl = numPr.getElementsByTagName("w:numId")[0];
          const id = numIdEl && numIdEl.getAttribute("w:val");
          list = { kind: numKind[id] || "number" };
        }
        const ind = [...pPr.children].find((c) => c.nodeName === "w:ind");
        if (ind) {
          const left = parseInt(ind.getAttribute("w:left") || ind.getAttribute("w:start") || "0", 10);
          const fl = parseInt(ind.getAttribute("w:firstLine") || "0", 10);
          if (left) leftIndent = Math.round(left / 20);
          if (fl > 0) firstLineIndent = true;
        }
      }

      // metin run'ları
      const runs = [];
      for (const r of p.getElementsByTagName("w:r")) {
        let t = "";
        for (const ch of r.childNodes) {
          if (ch.nodeName === "w:t") t += ch.textContent;
          else if (ch.nodeName === "w:tab") t += "\t";
          else if (ch.nodeName === "w:br" || ch.nodeName === "w:cr") t += " ";
        }
        if (!t) continue;
        const rPr = r.getElementsByTagName("w:rPr")[0];
        let bold = false, italic = false, size = 0;
        if (rPr) {
          const b = [...rPr.children].find((c) => c.nodeName === "w:b");
          if (b) { const v = b.getAttribute("w:val"); bold = v !== "false" && v !== "0"; }
          italic = [...rPr.children].some((c) => c.nodeName === "w:i" && c.getAttribute("w:val") !== "false" && c.getAttribute("w:val") !== "0");
          const sz = [...rPr.children].find((c) => c.nodeName === "w:sz");
          if (sz) size = Math.round(parseInt(sz.getAttribute("w:val"), 10) / 2);
        }
        runs.push({ text: t, bold, italic, size });
      }

      const allText = runs.map((r) => r.text).join("");
      if (!allText.trim() && !list) { out.push({ type: "empty" }); continue; }

      let merged = mergeRuns(runs);
      if (merged.length && /^\t/.test(merged[0].text)) {
        firstLineIndent = true;
        merged[0] = { ...merged[0], text: merged[0].text.replace(/^\t+/, "") };
      }

      out.push({
        type: "text",
        runs: merged.length ? merged : [{ text: "", bold: false, italic: false, size: 0 }],
        align, list,
        leftIndent: list ? 0 : leftIndent,
        firstLineIndent,
      });
    }
    return out;
  }

  // ---------- paragraphs -> DOCX ----------
  async function paragraphsToDocx(paragraphs) {
    const D = window.docx;
    const alignMap = {
      0: D.AlignmentType.LEFT, 1: D.AlignmentType.CENTER,
      2: D.AlignmentType.RIGHT, 3: D.AlignmentType.JUSTIFIED
    };
    const children = paragraphs.map(p => new D.Paragraph({
      alignment: alignMap[p.align] || D.AlignmentType.LEFT,
      children: [new D.TextRun({
        text: p.text || "",
        bold: !!p.bold,
        font: "Times New Roman",
        size: 24 // half-points = 12pt
      })]
    }));
    const doc = new D.Document({ sections: [{ children }] });
    return await D.Packer.toBlob(doc);
  }

  // aynı biçimli komşu run'ları birleştir (Word her kelimeyi ayrı run yapabilir)
  function mergeRuns(runs) {
    const out = [];
    for (const r of runs) {
      const last = out[out.length - 1];
      if (last && !!last.bold === !!r.bold && !!last.italic === !!r.italic && (last.size || 0) === (r.size || 0)) {
        last.text += r.text;
      } else out.push({ text: r.text, bold: !!r.bold, italic: !!r.italic, size: r.size || 0 });
    }
    return out;
  }

  // görseli PNG base64'e normalize et (UYAP UDF görselleri PNG bekler).
  // Tam çözünürlüğü değil, görüntüleme boyutunu (en çok ~1000px) kullanır;
  // aksi halde yüksek çözünürlüklü fotoğraflar UDF'i gereksiz şişirir.
  function toPngBase64(image) {
    if (image.mime === "image/png" || !image.mime) return Promise.resolve(image.base64);
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const cap = 1000;
        let w = image.width || img.naturalWidth, h = image.height || img.naturalHeight;
        if (w > cap) { h = Math.round(h * cap / w); w = cap; }
        const c = document.createElement("canvas");
        c.width = w; c.height = h;
        c.getContext("2d").drawImage(img, 0, 0, w, h);
        resolve(c.toDataURL("image/png").split(",")[1]);
      };
      img.onerror = () => resolve(image.base64); // çevrilemezse orijinali bırak
      img.src = "data:" + image.mime + ";base64," + image.base64;
    });
  }

  // base64 -> Uint8Array (görsel baytları için)
  function base64ToBytes(b64) {
    const bin = atob(b64);
    const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u;
  }

  // ---------- zengin paragraphs -> DOCX ----------
  async function richParagraphsToDocx(rich) {
    const D = window.docx;
    const PT = 20;                 // 1pt = 20 twip
    const MAXW = 510;              // içerik genişliği (A4 - 2*42.5pt) ~ pt
    const alignMap = {
      0: D.AlignmentType.LEFT, 1: D.AlignmentType.CENTER,
      2: D.AlignmentType.RIGHT, 3: D.AlignmentType.JUSTIFIED,
    };

    // her bitişik numaralı liste grubuna ayrı referans ver (her grup 1'den başlar)
    const numConfigs = [];
    let numRef = null, prevWasNumber = false, groupIdx = 0;
    const refOf = [];
    rich.forEach((p) => {
      if (p.type === "text" && p.list && p.list.kind === "number") {
        if (!prevWasNumber) { groupIdx++; numRef = "udf-num-" + groupIdx; numConfigs.push(numRef); }
        refOf.push(numRef); prevWasNumber = true;
      } else { refOf.push(null); prevWasNumber = false; }
    });

    const children = [];
    rich.forEach((p, i) => {
      if (p.type === "image") {
        let w = p.image.width || 100, h = p.image.height || 100;
        if (w > MAXW) { h = Math.round(h * MAXW / w); w = MAXW; }
        children.push(new D.Paragraph({
          children: [new D.ImageRun({ type: "png", data: base64ToBytes(p.image.base64), transformation: { width: w, height: h } })],
        }));
        return;
      }
      if (p.type === "empty") { children.push(new D.Paragraph({})); return; }

      const runs = p.runs.map((r) => new D.TextRun({
        text: r.text, bold: !!r.bold, italics: !!r.italic,
        font: "Times New Roman", size: (r.size && r.size > 0 ? r.size : 12) * 2, // yarım-punto
      }));
      const opt = { children: runs, alignment: alignMap[p.align] || D.AlignmentType.LEFT };
      if (p.list && p.list.kind === "bullet") opt.bullet = { level: 0 };
      else if (p.list && p.list.kind === "number") opt.numbering = { reference: refOf[i], level: 0 };
      else {
        const ind = {};
        if (p.leftIndent) ind.left = Math.round(p.leftIndent * PT);
        if (p.firstLineIndent) ind.firstLine = D.convertInchesToTwip(0.5);
        if (Object.keys(ind).length) opt.indent = ind;
      }
      children.push(new D.Paragraph(opt));
    });

    const numbering = {
      config: numConfigs.map((ref) => ({
        reference: ref,
        levels: [{
          level: 0, format: D.LevelFormat.DECIMAL, text: "%1.", alignment: D.AlignmentType.START,
          style: { paragraph: { indent: { left: D.convertInchesToTwip(0.5), hanging: D.convertInchesToTwip(0.25) } } },
        }],
      })),
    };

    const doc = new D.Document({ numbering, sections: [{ children }] });
    return await D.Packer.toBlob(doc);
  }

  // ---------- paragraphs -> PDF ----------
  function paragraphsToPdf(paragraphs) {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: "pt", format: "a4" });
    const margin = 56, maxW = doc.internal.pageSize.getWidth() - margin * 2;
    let y = margin;
    const lineH = 17;

    // jsPDF'in yerleşik "times" fontu yalnızca WinAnsiEncoding destekler ve
    // Türkçe'ye özgü ı/İ/ş/Ş/ğ/Ğ harflerini bozar; bunun yerine Times New
    // Roman ile metrik uyumlu, Türkçe karakterleri tam destekleyen Liberation
    // Serif fontunu gömüyoruz (SIL Open Font License — libs/fonts/).
    doc.addFileToVFS("LiberationSerif-Regular.ttf", window.UDF_PDF_FONTS.regular);
    doc.addFont("LiberationSerif-Regular.ttf", "LiberationSerif", "normal");
    doc.addFileToVFS("LiberationSerif-Bold.ttf", window.UDF_PDF_FONTS.bold);
    doc.addFont("LiberationSerif-Bold.ttf", "LiberationSerif", "bold");
    doc.setFont("LiberationSerif", "normal");
    doc.setFontSize(12);

    for (const p of paragraphs) {
      doc.setFont("LiberationSerif", p.bold ? "bold" : "normal");
      const text = p.text || " ";
      const lines = doc.splitTextToSize(text, maxW);
      for (const ln of lines) {
        if (y > doc.internal.pageSize.getHeight() - margin) { doc.addPage(); y = margin; }
        let x = margin;
        const align = p.align;
        if (align === 1) x = doc.internal.pageSize.getWidth() / 2;       // center
        else if (align === 2) x = doc.internal.pageSize.getWidth() - margin; // right
        doc.text(ln, x, y, { align: align === 1 ? "center" : align === 2 ? "right" : "left" });
        y += lineH;
      }
      y += 4; // paragraf boşluğu
    }
    return doc.output("blob");
  }

  // ---------- zengin paragraphs -> PDF ----------
  function richParagraphsToPdf(rich) {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: "pt", format: "a4" });
    const pageW = doc.internal.pageSize.getWidth();
    const pageH = doc.internal.pageSize.getHeight();
    const margin = 42.5, bodySize = 12;
    const contentW = pageW - margin * 2;

    doc.addFileToVFS("LiberationSerif-Regular.ttf", window.UDF_PDF_FONTS.regular);
    doc.addFont("LiberationSerif-Regular.ttf", "LiberationSerif", "normal");
    doc.addFileToVFS("LiberationSerif-Bold.ttf", window.UDF_PDF_FONTS.bold);
    doc.addFont("LiberationSerif-Bold.ttf", "LiberationSerif", "bold");
    const FONT = "LiberationSerif";

    let y = margin, numCounter = 0, prevWasNumber = false;
    const ensure = (h) => { if (y + h > pageH - margin) { doc.addPage(); y = margin; } };

    for (const p of rich) {
      if (p.type === "image") {
        let w = p.image.width || 100, h = p.image.height || 100;
        if (w > contentW) { h = h * contentW / w; w = contentW; }
        ensure(h);
        const mime = p.image.mime || "image/png";
        const fmt = mime === "image/jpeg" ? "JPEG" : "PNG";
        try { doc.addImage("data:" + mime + ";base64," + p.image.base64, fmt, margin, y, w, h); } catch (e) {}
        y += h + 6;
        prevWasNumber = false;
        continue;
      }
      if (p.type === "empty") { y += bodySize * 1.0; prevWasNumber = false; continue; }

      const r0 = (p.runs && p.runs[0]) || { text: "", bold: false, size: 0 };
      const size = (r0.size && r0.size > 0) ? r0.size : bodySize;
      const lineH = size * 1.45;
      doc.setFontSize(size);
      doc.setFont(FONT, r0.bold ? "bold" : "normal");

      // liste işareti + girinti
      let marker = null, baseX = margin + (p.leftIndent || 0);
      if (p.list && p.list.kind === "bullet") { marker = "•"; baseX = margin + 22; }
      else if (p.list && p.list.kind === "number") {
        if (!prevWasNumber) numCounter = 0;
        marker = (++numCounter) + ".";
        baseX = margin + 22;
      }
      prevWasNumber = !!(p.list && p.list.kind === "number");

      const text = p.runs.map((r) => r.text).join("") || " ";
      const firstIndent = (p.firstLineIndent && !p.list) ? 24 : 0;
      const avail = pageW - margin - baseX;
      const lines = doc.splitTextToSize(text, avail - firstIndent);

      for (let i = 0; i < lines.length; i++) {
        ensure(lineH);
        if (i === 0 && marker) doc.text(marker, margin + 6, y);
        const ln = lines[i];
        if (p.align === 1) doc.text(ln, pageW / 2, y, { align: "center" });
        else if (p.align === 2) doc.text(ln, pageW - margin, y, { align: "right" });
        else if (p.align === 3 && i < lines.length - 1) doc.text(ln, baseX, y, { align: "justify", maxWidth: avail });
        else doc.text(ln, baseX + (i === 0 ? firstIndent : 0), y);
        y += lineH;
      }
      y += 4; // paragraf boşluğu
    }
    return doc.output("blob");
  }

  // ---------- PDF -> paragraphs ----------
  if (window.pdfjsLib) {
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = "libs/pdf.worker.min.js";
  }

  async function pdfToParagraphs(arrayBuffer) {
    let pdf;
    try {
      // pdf.js verilen buffer'ı worker'a taşırken "detach" eder; orijinali
      // (app.js'te dosya önbelleğinde tutulan ve tekrar kullanılabilen) korumak
      // için bir kopya veriyoruz.
      pdf = await window.pdfjsLib.getDocument({ data: arrayBuffer.slice(0) }).promise;
    } catch (err) {
      if (err && err.name === "PasswordException") {
        throw new Error("Bu PDF parola korumalı; parola korumalı PDF'ler desteklenmiyor.");
      }
      throw new Error("PDF okunamadı: " + err.message);
    }

    const paras = [];
    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      const page = await pdf.getPage(pageNum);
      const content = await page.getTextContent();
      const styles = content.styles || {};

      // metin parçalarını satırlara grupla (yakın Y koordinatı = aynı satır)
      const lines = [];
      let cur = null;
      for (const item of content.items) {
        // pdf.js her satırın başına boş ("") yer tutucu öğeler ekleyebilir;
        // bunların height=0 olması satır yüksekliği hesabını bozar, atla.
        if (!item.str) continue;
        const y = item.transform[5];
        const fam = (styles[item.fontName] && styles[item.fontName].fontFamily) || "";
        const bold = /bold/i.test(fam);
        if (cur && Math.abs(cur.y - y) < 2) {
          cur.text += item.str;
          cur.bold = cur.bold && bold;
        } else {
          if (cur) lines.push(cur);
          cur = { y, text: item.str, height: item.height || 10, bold };
        }
      }
      if (cur) lines.push(cur);

      // satırları paragraflara birleştir (büyük dikey boşluk = yeni paragraf)
      // PDF, hizalama bilgisini saklamadığı için metin sola hizalı kabul edilir.
      let buffer = "", bufBold = true, prevY = null, prevH = null;
      for (const line of lines) {
        const text = line.text.trim();
        const gap = prevY !== null ? prevY - line.y : 0;
        const threshold = (prevH || line.height || 10) * 1.5;
        if (prevY !== null && gap > threshold && buffer.trim()) {
          paras.push({ text: buffer.trim(), align: 0, bold: bufBold });
          buffer = ""; bufBold = true;
        }
        if (text) {
          buffer += (buffer ? " " : "") + text;
          bufBold = bufBold && line.bold;
        }
        prevY = line.y;
        prevH = line.height;
      }
      if (buffer.trim()) paras.push({ text: buffer.trim(), align: 0, bold: bufBold });

      if (pageNum < pdf.numPages) paras.push({ text: "", align: 0, bold: false });
    }

    if (!paras.some(p => p.text.trim())) {
      throw new Error("PDF içinden metin çıkarılamadı.");
    }
    return paras;
  }

  // ============================================================
  //  PROTOTİP: zengin PDF -> UDF (görsel + biçim + liste + girinti)
  //  Amaç: PDF'in mantıksal yapısını mümkün olduğunca geri kazanıp UDF'ye
  //  görsel olarak benzer şekilde yazmak. PDF mantıksal yapı saklamadığı için
  //  bu çıkarım sezgiseldir; kararlar koordinat/font/çizim analizine dayanır.
  // ============================================================

  // bir fontName'in kalın/italik olup olmadığını PostScript adından çıkar
  function fontStyleOf(page, fontName) {
    let name = "";
    try { const f = page.commonObjs.get(fontName); name = (f && f.name) || ""; } catch (e) {}
    return {
      bold: /bold|black|heavy|semibold|demi/i.test(name),
      italic: /italic|oblique/i.test(name),
    };
  }

  // bir PDF sayfasından gömülü görselleri (konum + base64 PNG) çıkar ve
  // çizilen küçük dolgu şekillerini (madde imi adayları) topla
  async function pdfPageGraphics(page, opList) {
    const OPS = window.pdfjsLib.OPS;
    const images = [];
    const bulletMarks = [];

    let ctm = [1, 0, 0, 1, 0, 0];
    const stack = [];
    const mul = (m, n) => [
      m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
      m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
      m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
    ];
    let lastBBox = null;

    for (let k = 0; k < opList.fnArray.length; k++) {
      const fn = opList.fnArray[k];
      const args = opList.argsArray[k];
      if (fn === OPS.save) stack.push(ctm.slice());
      else if (fn === OPS.restore) ctm = stack.pop() || ctm;
      else if (fn === OPS.transform) ctm = mul(ctm, args);
      else if (fn === OPS.paintFormXObjectBegin) { stack.push(ctm.slice()); if (args[0]) ctm = mul(ctm, args[0]); }
      else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() || ctm;
      else if (fn === OPS.constructPath) {
        const coords = args[1] || [];
        let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
        for (let i = 0; i + 1 < coords.length; i += 2) {
          const x = coords[i], y = coords[i + 1];
          if (x < minx) minx = x; if (x > maxx) maxx = x;
          if (y < miny) miny = y; if (y > maxy) maxy = y;
        }
        if (isFinite(minx)) {
          const p = (px, py) => [ctm[0] * px + ctm[2] * py + ctm[4], ctm[1] * px + ctm[3] * py + ctm[5]];
          const a = p(minx, miny), b = p(maxx, maxy);
          lastBBox = { x0: Math.min(a[0], b[0]), y0: Math.min(a[1], b[1]), x1: Math.max(a[0], b[0]), y1: Math.max(a[1], b[1]) };
        }
      } else if (fn === OPS.fill || fn === OPS.eoFill) {
        if (lastBBox) {
          const w = lastBBox.x1 - lastBBox.x0, h = lastBBox.y1 - lastBBox.y0;
          // küçük (≈ punto boyutu) dolgu = madde imi adayı
          if (w > 0 && h > 0 && w < 12 && h < 12) {
            bulletMarks.push({ x: lastBBox.x0, y: (lastBBox.y0 + lastBBox.y1) / 2 });
          }
        }
      } else if (fn === OPS.paintImageXObject) {
        const imgName = args[0];
        const obj = await new Promise((res) => { try { page.objs.get(imgName, res); } catch (e) { res(null); } });
        if (obj && (obj.bitmap || obj.data)) {
          const canvas = document.createElement("canvas");
          canvas.width = obj.width; canvas.height = obj.height;
          const ctx = canvas.getContext("2d");
          if (obj.bitmap) {
            ctx.drawImage(obj.bitmap, 0, 0);
          } else {
            const im = ctx.createImageData(obj.width, obj.height), s = obj.data;
            if (s.length === obj.width * obj.height * 4) im.data.set(s);
            else for (let i = 0, j = 0; i < s.length; i += 3, j += 4) { im.data[j] = s[i]; im.data[j + 1] = s[i + 1]; im.data[j + 2] = s[i + 2]; im.data[j + 3] = 255; }
            ctx.putImageData(im, 0, 0);
          }
          const b64 = canvas.toDataURL("image/png").split(",")[1];
          // görüntü yüksekliği için CTM'den üst y; boyut için yerel piksel
          const topY = ctm[5] + Math.abs(ctm[3]);
          images.push({ base64: b64, mime: "image/png", width: obj.width, height: obj.height, topY: isFinite(topY) ? topY : 99999 });
        }
      }
    }
    return { images, bulletMarks };
  }

  async function pdfToRichParagraphs(arrayBuffer) {
    let pdf;
    try {
      pdf = await window.pdfjsLib.getDocument({ data: arrayBuffer.slice(0) }).promise;
    } catch (err) {
      if (err && err.name === "PasswordException") throw new Error("Bu PDF parola korumalı; desteklenmiyor.");
      throw new Error("PDF okunamadı: " + err.message);
    }

    const result = [];
    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      const page = await pdf.getPage(pageNum);
      const opList = await page.getOperatorList(); // fontları + nesneleri yükler
      const { images, bulletMarks } = await pdfPageGraphics(page, opList);
      const content = await page.getTextContent();
      const vp = page.getViewport({ scale: 1 });
      const pageWidth = vp.width;

      // 1) tüm metin öğelerini topla; PDF akış sırası üstten-alta olmayabilir
      //    (örn. liste işareti "1." metinden sonra gelebilir), bu yüzden önce
      //    y'ye göre global sıralayıp satırlara grupluyoruz.
      const pieces = [];
      for (const it of content.items) {
        if (!it.str) continue;
        const st = fontStyleOf(page, it.fontName);
        pieces.push({
          x: it.transform[4], xEnd: it.transform[4] + (it.width || 0), y: it.transform[5],
          str: it.str, size: Math.abs(it.transform[0]) || it.height || 12, bold: st.bold, italic: st.italic,
        });
      }
      pieces.sort((a, b) => (b.y - a.y) || (a.x - b.x));
      const rawLines = [];
      let cur = null;
      for (const p of pieces) {
        if (cur && Math.abs(cur.y - p.y) < 3) cur.pieces.push(p);
        else { if (cur) rawLines.push(cur); cur = { y: p.y, pieces: [p] }; }
      }
      if (cur) rawLines.push(cur);

      // her satırı soldan sağa sırala, metni birleştir, ölçüleri çıkar
      const lines = rawLines.map((ln) => {
        const ps = ln.pieces.slice().sort((a, b) => a.x - b.x);
        let text = "";
        for (let i = 0; i < ps.length; i++) {
          if (i > 0) {
            const gap = ps[i].x - ps[i - 1].xEnd;
            if (gap > ps[i].size * 0.25) text += " ";
          }
          text += ps[i].str;
        }
        const left = ps[0].x;
        const right = ps[ps.length - 1].xEnd;
        const size = Math.round(Math.max(...ps.map((p) => p.size)));
        const bold = ps.every((p) => p.bold);
        const italic = ps.every((p) => p.italic);
        // bu satırın solunda madde imi var mı?
        const hasBullet = bulletMarks.some((m) => Math.abs(m.y - ln.y) < size && m.x < left && m.x > left - 30);
        return { y: ln.y, text: text.replace(/\s+$/, ""), left, right, size, bold, italic, hasBullet };
      }).filter((l) => l.text.length > 0 || l.hasBullet);

      if (lines.length === 0) { continue; }

      // 2) sayfa sol kenarı (en sık görülen en-sol x ≈ kenar boşluğu)
      const leftMargin = Math.min(...lines.map((l) => l.left));
      // gövde punto boyutu (en sık)
      const sizeCounts = {};
      lines.forEach((l) => { sizeCounts[l.size] = (sizeCounts[l.size] || 0) + 1; });
      const bodySize = Number(Object.entries(sizeCounts).sort((a, b) => b[1] - a[1])[0][0]) || 12;
      const lineH = bodySize * 1.4;

      // 3) satırları paragraflara böl. Yeni paragraf işareti: büyük dikey boşluk,
      //    satır başında numara işareti veya solunda madde imi. (İlk-satır
      //    girintisi tek başına bölme nedeni DEĞİLDİR — aynı paragrafın parçası.)
      const paras = [];
      let para = null, prevY = null, prevLeft = null;
      const numRe = /^(\d+)[.)]\s*/;
      for (const ln of lines) {
        const isNum = numRe.test(ln.text);
        const isBullet = ln.hasBullet;
        const gap = prevY !== null ? prevY - ln.y : 0;
        const bigGap = prevY !== null && gap > lineH * 1.6;
        // ilk-satır girintisi sıçraması: satır, önceki satırdan belirgin SAĞA
        // kayıyorsa yeni (tab'lı) paragraf başlangıcıdır
        const indentJump = prevLeft !== null && ln.left > prevLeft + 20 && ln.left > leftMargin + 30;
        // listeden çıkış: liste paragrafındayken kenar boşluğuna geri dönen
        // (işaretsiz) satır yeni bir normal paragraftır. (Numara işareti satırın
        // en-solu olduğundan, devam satırlarını yanlışlıkla bölmemek için
        // "kenara dönüş"e bakarız, küçük x kaymasına değil.)
        const dedentFromList = para && para.list && !isBullet && !isNum &&
          ln.left <= leftMargin + 12;
        const startNew = !para || isNum || isBullet || bigGap || indentJump || dedentFromList;

        if (startNew && para) paras.push(para);
        if (startNew && bigGap && para) paras.push({ empty: true }); // boşluğu koru
        if (startNew) {
          let text = ln.text, list = null;
          if (isNum) { text = text.replace(numRe, ""); list = { kind: "number" }; }
          else if (isBullet) { list = { kind: "bullet" }; }
          para = {
            firstLeft: ln.left, lefts: [ln.left], rights: [ln.right],
            size: ln.size, bold: ln.bold, italic: ln.italic, list, text,
          };
        } else {
          para.text += " " + ln.text;
          para.lefts.push(ln.left);
          para.rights.push(ln.right);
          para.bold = para.bold && ln.bold;
        }
        prevY = ln.y;
        prevLeft = ln.left;
      }
      if (para) paras.push(para);

      // 4) her paragraf için hizalama + girinti belirle, zengin nesneye çevir.
      //    Hizalama, ilk satıra değil TÜM satırların en-sol/en-sağ değerlerine
      //    bakılarak belirlenir; böylece ilk-satır girintisi yanıltmaz.
      const rightEdge = pageWidth - leftMargin;
      const pageParas = paras.map((p) => {
        if (p.empty) return { type: "empty" };
        const minLeft = Math.min(...p.lefts);
        const maxRight = Math.max(...p.rights);
        const flushLeft = minLeft <= leftMargin + 12;
        const reachesRight = maxRight >= rightEdge - 12;
        const firstCenter = (p.firstLeft + p.rights[0]) / 2;

        let align = 0;
        if (!p.list) {
          if (!flushLeft && !reachesRight && Math.abs(firstCenter - pageWidth / 2) < 20) align = 1; // ortalı
          else if (!flushLeft && reachesRight) align = 2;                                            // sağa
          // iki yana yasla: son hariç tüm satırlar sağ kenara TAM yaslı (≈4pt).
          // Gevşek tolerans sola hizalı düz metni yanlış yakalar; bu yüzden dar.
          else if (p.rights.length > 1 && flushLeft &&
                   p.rights.slice(0, -1).every((r) => Math.abs(r - rightEdge) < 4)) align = 3;
        }

        const blockIndent = Math.round(minLeft - leftMargin);
        const firstLineIndent = !p.list && align === 0 && (p.firstLeft - minLeft) > 14;
        return {
          type: "text",
          runs: [{ text: p.text, bold: p.bold || p.size > bodySize * 1.15, italic: p.italic, size: p.size }],
          align,
          list: p.list,
          // tüm satırlar girintiliyse (ilk-satır girintisi değil) blok girinti
          leftIndent: p.list ? 25 : (!firstLineIndent && align === 0 && blockIndent > 14 ? blockIndent : 0),
          firstLineIndent,
        };
      });

      // 5) görselleri y konumuna göre metin paragraflarıyla sırala (üstten alta)
      const withImages = [];
      const imgs = images.slice().sort((a, b) => b.topY - a.topY);
      // basit yaklaşım: bu sayfanın görsellerini en üste koy (örnek dosyada görsel en üstte)
      imgs.forEach((im) => withImages.push({ type: "image", image: im }));
      pageParas.forEach((pp) => withImages.push(pp));

      result.push(...withImages);
      if (pageNum < pdf.numPages) result.push({ type: "empty" });
    }

    if (!result.some((p) => p.type === "image" || (p.type === "text" && p.runs.some((r) => r.text.trim())))) {
      throw new Error("PDF içinden içerik çıkarılamadı.");
    }
    return result;
  }

  // ---------- zengin paragraphs -> UDF ----------
  async function writeRichUDF(richParas, opts = {}) {
    const font = opts.font || "Times New Roman";
    const bodySize = opts.size || 12;
    const IMG_PLACEHOLDER = "¸"; // UYAP'ın görsel yer-tutucu karakteri

    let full = "";
    const elements = [];
    let listCounter = 0, prevListKind = null;

    for (const p of richParas) {
      if (p.type === "image") {
        const start = full.length;
        full += IMG_PLACEHOLDER + "\n";
        const pngB64 = await toPngBase64(p.image); // UDF görselleri PNG bekler
        elements.push(
          `<paragraph><image imageData="${pngB64}" width="${p.image.width}.0" height="${p.image.height}.0" ` +
          `startOffset="${start}" length="1" /><content startOffset="${start + 1}" length="1" /></paragraph>`
        );
        prevListKind = null;
        continue;
      }
      if (p.type === "empty") {
        const start = full.length;
        full += "\n";
        elements.push(`<paragraph><content startOffset="${start}" length="1" /></paragraph>`);
        prevListKind = null;
        continue;
      }

      // metin paragrafı: her run kendi biçimiyle ayrı <content> olur
      const runs = (p.runs && p.runs.length) ? p.runs : [{ text: "", bold: false, italic: false, size: 0 }];
      const lead = p.firstLineIndent ? "\t" : "";
      let text = lead + runs.map((r) => r.text).join("");
      const start = full.length;
      full += text + "\n";

      // paragraf öznitelikleri
      const attrs = [];
      if (p.align) attrs.push(`Alignment="${p.align}"`);
      if (p.list) {
        listCounter += (prevListKind === p.list.kind ? 0 : 1);
        const id = listCounter;
        if (p.list.kind === "bullet")
          attrs.push(`Bulleted="true"`, `BulletType="BULLET_TYPE_ELLIPSE"`, `ListLevel="1"`, `ListId="${id}"`, `LeftIndent="25.0"`);
        else
          attrs.push(`Numbered="true"`, `NumberType="NUMBER_TYPE_NUMBER_DOT"`, `ListLevel="1"`, `ListId="${id}"`, `LeftIndent="25.0"`);
        prevListKind = p.list.kind;
      } else {
        if (p.leftIndent) attrs.push(`LeftIndent="${p.leftIndent}.0"`);
        prevListKind = null;
      }
      const attrStr = attrs.length ? " " + attrs.join(" ") : "";

      // içerik run'ları: her run için bir <content>, sondaki \n için düz <content>
      let off = start + lead.length; // tab (varsa) ilk run'a dahil değil; düz say
      let contentXml = "";
      if (lead) { contentXml += `<content startOffset="${start}" length="${lead.length}" />`; }
      for (const r of runs) {
        const len = r.text.length;
        if (len === 0) continue;
        const styled = (r.bold ? 'bold="true" ' : "") + (r.italic ? 'italic="true" ' : "") +
                       (r.size && r.size > 0 && r.size !== bodySize ? `size="${r.size}" ` : "");
        contentXml += `<content ${styled}startOffset="${off}" length="${len}" />`;
        off += len;
      }
      contentXml += `<content startOffset="${off}" length="1" />`; // sondaki \n
      elements.push(`<paragraph${attrStr}>${contentXml}</paragraph>`);
    }

    const out = [];
    out.push('<?xml version="1.0" encoding="UTF-8" ?>');
    out.push('<template format_id="1.8">');
    out.push('<content><![CDATA[' + full + ']]></content>');
    out.push('<properties><pageFormat mediaSizeName="1" ' +
      'leftMargin="42.525" rightMargin="42.525" topMargin="42.525" bottomMargin="42.525" ' +
      'paperOrientation="1" headerFOffset="20.0" footerFOffset="20.0" /></properties>');
    out.push('<elements resolver="hvl-default">');
    out.push(...elements);
    out.push('</elements>');
    out.push('<styles>');
    out.push('<style name="default" description="Geçerli" family="Dialog" size="12" bold="false" italic="false" ' +
      'FONT_ATTRIBUTE_KEY="javax.swing.plaf.FontUIResource[family=Dialog,name=Dialog,style=plain,size=12]" foreground="-13421773" />');
    out.push(`<style name="hvl-default" family="${font}" size="${bodySize}" description="Gövde" />`);
    out.push('</styles>');
    out.push('</template>');

    const zip = new JSZip();
    zip.file("content.xml", out.join("\n"));
    return zip.generateAsync({ type: "blob", compression: "DEFLATE" });
  }

  // ---------- ÜST SEVİYE DÖNÜŞTÜRME ----------
  // inExt/outExt: ".udf" ".docx" ".pdf"
  // Tüm dönüşümler tek bir ZENGİN modelden geçer: görsel, liste, hizalama,
  // girinti, paragraf boşluğu ve per-run biçim tüm formatlar arasında korunur.
  async function convert(arrayBuffer, inExt, outExt) {
    let rich;
    if (inExt === ".udf") rich = await readRichUDF(arrayBuffer);
    else if (inExt === ".docx") rich = await docxToRichParagraphs(arrayBuffer);
    else if (inExt === ".pdf") rich = await pdfToRichParagraphs(arrayBuffer);
    else throw new Error("Desteklenmeyen girdi: " + inExt);

    if (outExt === ".udf") return await writeRichUDF(rich);
    if (outExt === ".docx") return await richParagraphsToDocx(rich);
    if (outExt === ".pdf") return richParagraphsToPdf(rich);
    throw new Error("Desteklenmeyen çıktı: " + outExt);
  }

  return {
    writeUDF, readUDF, readRichUDF, convert,
    pdfToRichParagraphs, writeRichUDF, docxToRichParagraphs, richParagraphsToDocx, richParagraphsToPdf,
    LEFT, CENTER, RIGHT, JUSTIFY,
  };
})();
