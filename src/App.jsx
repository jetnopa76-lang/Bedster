import { useState, useRef, useEffect } from "react";

import JSZip from "jszip";
async function loadJSZip() { /* noop for standalone */ }

/* ── IndexedDB storage for standalone ── */
function idbOpen() {
  return new Promise((res, rej) => {
    const req = indexedDB.open("imposition-studio", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("kv");
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}
const _idb = { 
  async get(key) { 
    const db = await idbOpen(); 
    return new Promise((res, rej) => { 
      const tx = db.transaction("kv", "readonly"); 
      const req = tx.objectStore("kv").get(key); 
      req.onsuccess = () => res(req.result != null ? { value: req.result } : null); 
      req.onerror = () => rej(req.error); 
    }); 
  },
  async set(key, value) { 
    const db = await idbOpen(); 
    return new Promise((res, rej) => { 
      const tx = db.transaction("kv", "readwrite"); 
      tx.objectStore("kv").put(value, key); 
      tx.oncomplete = () => res({ key, value }); 
      tx.onerror = () => rej(tx.error); 
    }); 
  },
  async delete(key) { 
    const db = await idbOpen(); 
    return new Promise((res, rej) => { 
      const tx = db.transaction("kv", "readwrite"); 
      tx.objectStore("kv").delete(key); 
      tx.oncomplete = () => res({ key, deleted: true }); 
      tx.onerror = () => rej(tx.error); 
    }); 
  }
};


/* ── Parse IDML ── */
async function parseIDML(arrayBuffer) {
  await loadJSZip();
  const zip = await JSZip.loadAsync(arrayBuffer);
  const designmap = await zip.file("designmap.xml").async("text");
  const dmDoc = new DOMParser().parseFromString(designmap, "text/xml");
  const layers = {};
  dmDoc.querySelectorAll("Layer").forEach(l => { layers[l.getAttribute("Self")] = l.getAttribute("Name"); });
  let imageLayerId = null;
  for (const [id, name] of Object.entries(layers)) { if (name.toLowerCase() === "image") imageLayerId = id; }

  const spreadFiles = [];
  zip.forEach(path => { if (path.startsWith("Spreads/Spread_")) spreadFiles.push(path); });
  spreadFiles.sort();

  const spreads = [];
  for (const sp of spreadFiles) {
    const xml = await zip.file(sp).async("text");
    const doc = new DOMParser().parseFromString(xml, "text/xml");
    const page = doc.querySelector("Page");
    const pb = page?.getAttribute("GeometricBounds")?.split(" ").map(Number) || [0,0,0,0];
    const pt = page?.getAttribute("ItemTransform")?.split(" ").map(Number) || [1,0,0,1,0,0];
    const pageW = (pb[3] - pb[1]) / 72, pageH = (pb[2] - pb[0]) / 72;
    const pageSpreadLeft = pt[0] * pb[1] + pt[2] * pb[0] + pt[4];
    const pageSpreadTop  = pt[1] * pb[1] + pt[3] * pb[0] + pt[5];

    const imageFrames = [];
    doc.querySelectorAll("Rectangle").forEach(rect => {
      const layer = rect.getAttribute("ItemLayer");
      if (layer !== imageLayerId) return;
      if (rect.getAttribute("ContentType") !== "GraphicType") return;
      if ((rect.getAttribute("FillColor") || "").includes("White_Ink")) return;
      const label = rect.querySelector('KeyValuePair[Key="Label"]')?.getAttribute("Value") || "";
      const t = rect.getAttribute("ItemTransform")?.split(" ").map(Number) || [1,0,0,1,0,0];
      const anchors = [];
      rect.querySelectorAll("PathPointType").forEach(pp => {
        const [x, y] = pp.getAttribute("Anchor").split(" ").map(Number);
        anchors.push({ x, y });
      });
      if (anchors.length < 4) return;
      const xs = anchors.map(a => a.x), ys = anchors.map(a => a.y);
      const minX = Math.min(...xs), maxY = Math.max(...ys), minY = Math.min(...ys);
      const fw = (Math.max(...xs) - minX) / 72, fh = (maxY - minY) / 72;
      // Skip tiny elements (labels, markers, etc.) — real image frames are at least 1" 
      if (fw < 1 || fh < 1) return;
      // Compute frame position in spread coordinates
      // Handle flipped transforms: sx or sy can be -1
      const sx = t[0], sy = t[3], tx = t[4], ty = t[5];
      
      // Apply full affine transform to all 4 corners to get bounding box
      const corners = [
        [minX, minY], [Math.max(...xs), minY],
        [Math.max(...xs), maxY], [minX, maxY]
      ];
      const absXs = corners.map(([cx, cy]) => sx * cx + t[2] * cy + tx);
      const absYs = corners.map(([cx, cy]) => t[1] * cx + sy * cy + ty);
      const spreadLeft = Math.min(...absXs);
      const spreadTop = Math.min(...absYs);
      const spreadRight = Math.max(...absXs);
      const spreadBottom = Math.max(...absYs);
      
      // Actual frame size in spread space (handles rotation/flip)
      const actualW = (spreadRight - spreadLeft) / 72;
      const actualH = (spreadBottom - spreadTop) / 72;
      
      const pageRelX = (spreadLeft - pageSpreadLeft) / 72;
      const pageRelY = (spreadTop - pageSpreadTop) / 72;
      imageFrames.push({ label, x: pageRelX, y: pageRelY, w: actualW, h: actualH, flipX: sx < 0, flipY: sy < 0 });
    });
    // Sort by position: top-to-bottom (Y), then left-to-right (X)
    imageFrames.sort((a, b) => {
      const ay = Math.round(a.y * 10), by = Math.round(b.y * 10);
      return ay !== by ? ay - by : a.x - b.x;
    });
    spreads.push({ pageW, pageH, imageFrames, frameCount: imageFrames.length });
  }
  const totalFrames = spreads.reduce((s, sp) => s + sp.frameCount, 0);
  const fs = spreads[0]?.imageFrames[0];
  const sizeLabel = fs ? `${fs.w.toFixed(1)}×${fs.h.toFixed(1)}"` : "?";
  return { spreads, totalFrames, pageW: spreads[0]?.pageW || 0, pageH: spreads[0]?.pageH || 0, sizeLabel, layers };
}

/* ── Persistent storage helpers ── */
function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToArrayBuffer(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

async function saveTemplate(tmpl) {
  try {
    const data = { name: tmpl.name, fileName: tmpl.fileName, idmlBase64: tmpl.idmlBase64 };
    await _idb.set(`tmpl:${tmpl.id}`, JSON.stringify(data));
    // Update index
    const idx = await loadTemplateIndex();
    if (!idx.includes(tmpl.id)) idx.push(tmpl.id);
    await _idb.set("tmpl-index", JSON.stringify(idx));
  } catch (e) { console.warn("Save template failed:", e); }
}

async function deleteTemplate(id) {
  try {
    await _idb.delete(`tmpl:${id}`);
    const idx = await loadTemplateIndex();
    await _idb.set("tmpl-index", JSON.stringify(idx.filter(x => x !== id)));
  } catch (e) { console.warn("Delete template failed:", e); }
}

async function loadTemplateIndex() {
  try {
    const r = await _idb.get("tmpl-index");
    return r?.value ? JSON.parse(r.value) : [];
  } catch { return []; }
}

async function loadSavedTemplates() {
  await loadJSZip();
  const idx = await loadTemplateIndex();
  const templates = [];
  for (const id of idx) {
    try {
      const r = await _idb.get(`tmpl:${id}`);
      if (!r?.value) continue;
      const data = JSON.parse(r.value);
      const buf = base64ToArrayBuffer(data.idmlBase64);
      const info = await parseIDML(buf);
      templates.push({
        id, name: data.name, fileName: data.fileName,
        idmlBase64: data.idmlBase64,
        info, sizeLabel: info.sizeLabel, totalFrames: info.totalFrames,
        pageW: info.pageW, pageH: info.pageH, spreadCount: info.spreads.length,
      });
    } catch (e) { console.warn(`Failed to load template ${id}:`, e); }
  }
  return templates;
}

async function saveSubstrates(subs) {
  try { await _idb.set("substrates", JSON.stringify(subs)); } catch {}
}
async function loadSubstrates() {
  try { const r = await _idb.get("substrates"); return r?.value ? JSON.parse(r.value) : null; } catch { return null; }
}

/* ── Read image file ── */
function readImageFile(file) {
  return new Promise(resolve => {
    const reader = new FileReader();
    reader.onload = e => {
      const du = e.target.result;
      const img = new Image();
      img.onload = () => {
        const b64 = du.split(",")[1], bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        resolve({ fileName: file.name, dataUrl: du, width: img.width, height: img.height, bytes, mimeType: file.type });
      };
      img.onerror = () => resolve({ fileName: file.name, dataUrl: du, width: 1000, height: 1000, bytes: new Uint8Array(0), mimeType: file.type });
      img.src = du;
    };
    reader.readAsDataURL(file);
  });
}

/* ── Ensure JPEG at full resolution ── */
async function ensureJPEG(imgData) {
  if (imgData.mimeType === "image/jpeg" || imgData.mimeType === "image/jpg") {
    return { bytes: imgData.bytes, width: imgData.width, height: imgData.height };
  }
  const canvas = document.createElement("canvas");
  canvas.width = imgData.width; canvas.height = imgData.height;
  const ctx = canvas.getContext("2d");
  const img = new Image();
  await new Promise((r, j) => { img.onload = r; img.onerror = j; img.src = imgData.dataUrl; });
  ctx.drawImage(img, 0, 0);
  const du = canvas.toDataURL("image/jpeg", 0.95), b64 = du.split(",")[1], bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { bytes, width: imgData.width, height: imgData.height };
}

/* ── Build production multi-layer PDF with proper OCG BDC + Separation spot ── */
async function buildPDF(trayW, trayH, placements, onProgress) {
  const PW = trayW * 72, PH = trayH * 72;
  const filled = placements.filter(p => p.image);
  const jpegs = [];
  for (let i = 0; i < filled.length; i++) {
    if (onProgress) onProgress(`Preparing image ${i + 1}/${filled.length}...`);
    jpegs.push(await ensureJPEG(filled[i].image));
  }
  if (onProgress) onProgress("Building PDF...");

  const parts = []; let pos = 0; const offsets = [];
  function w(d) { const b = typeof d === "string" ? new TextEncoder().encode(d) : d; parts.push(b); pos += b.length; }
  function markObj(n) { offsets[n] = pos; }

  w("%PDF-1.7\n%\xE2\xE3\xCF\xD3\n");
  const IO = 10, TO = IO + filled.length;

  let cs = "";
  cs += "/OC /MC0 BDC\n";
  filled.forEach((p, i) => {
    const fwPt = p.w * 72, fhPt = p.h * 72, xPt = p.x * 72, yPt = PH - p.y * 72 - fhPt;
    const imgW = jpegs[i].width, imgH = jpegs[i].height;
    const frameRatio = fwPt / fhPt, imgRatio = imgW / imgH;
    let drawW, drawH, drawX, drawY;
    if (imgRatio > frameRatio) { drawH = fhPt; drawW = fhPt * imgRatio; drawX = xPt - (drawW - fwPt) / 2; drawY = yPt; }
    else { drawW = fwPt; drawH = fwPt / imgRatio; drawX = xPt; drawY = yPt - (drawH - fhPt) / 2; }
    cs += `q\n${xPt.toFixed(2)} ${yPt.toFixed(2)} ${fwPt.toFixed(2)} ${fhPt.toFixed(2)} re W n\n`;
    cs += `${drawW.toFixed(2)} 0 0 ${drawH.toFixed(2)} ${drawX.toFixed(2)} ${drawY.toFixed(2)} cm\n/I${i} Do\nQ\n`;
  });
  cs += "EMC\n";
  cs += "/OC /MC1 BDC\n/GS0 gs\n/CS0 cs\n1 scn\n";
  filled.forEach(p => {
    const x = p.x * 72, ry = PH - p.y * 72 - p.h * 72, pw = p.w * 72, ph = p.h * 72;
    cs += `${x.toFixed(2)} ${ry.toFixed(2)} ${pw.toFixed(2)} ${ph.toFixed(2)} re f\n`;
  });
  cs += "EMC\n";
  const csB = new TextEncoder().encode(cs);
  let xo = ""; filled.forEach((_, i) => { xo += `/I${i} ${IO + i} 0 R `; });

  markObj(1); w(`1 0 obj\n<< /Type /Catalog /Pages 2 0 R /OCProperties << /OCGs [5 0 R 6 0 R] /D << /ON [5 0 R 6 0 R] /OFF [] /Order [5 0 R 6 0 R] /Name (Layers) /Creator (Imposition Studio) /BaseState /ON /Intent /Design >> >> >>\nendobj\n`);
  markObj(2); w("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n");
  markObj(3); w(`3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PW} ${PH}] /Contents 4 0 R /Resources << /XObject << ${xo}>> /ColorSpace << /CS0 9 0 R >> /Properties << /MC0 5 0 R /MC1 6 0 R >> /ExtGState << /GS0 7 0 R >> >> >>\nendobj\n`);
  markObj(4); w(`4 0 obj\n<< /Length ${csB.length} >>\nstream\n`); w(csB); w("\nendstream\nendobj\n");
  markObj(5); w('5 0 obj\n<< /Type /OCG /Name (image) /Intent /Design >>\nendobj\n');
  markObj(6); w('6 0 obj\n<< /Type /OCG /Name (White_Ink) /Intent /Design >>\nendobj\n');
  markObj(7); w("7 0 obj\n<< /Type /ExtGState /OP true /op true /OPM 1 >>\nendobj\n");
  markObj(8); w("8 0 obj\n<< /FunctionType 2 /Domain [0 1] /C0 [0 0 0 0] /C1 [0.15 1 1 0] /N 1 >>\nendobj\n");
  markObj(9); w("9 0 obj\n[/Separation /White_Ink /DeviceCMYK 8 0 R]\nendobj\n");

  for (let i = 0; i < filled.length; i++) {
    const n = IO + i, j = jpegs[i];
    markObj(n); w(`${n} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${j.width} /Height ${j.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${j.bytes.length} >>\nstream\n`);
    w(j.bytes); w("\nendstream\nendobj\n");
  }
  const xp = pos;
  w(`xref\n0 ${TO + 1}\n0000000000 65535 f \n`);
  for (let i = 1; i <= TO; i++) w(`${String(offsets[i] || 0).padStart(10, "0")} 00000 n \n`);
  w(`trailer\n<< /Size ${TO + 1} /Root 1 0 R >>\nstartxref\n${xp}\n%%EOF`);

  let total = 0; parts.forEach(p => total += p.length);
  const result = new Uint8Array(total); let off = 0;
  parts.forEach(p => { result.set(p, off); off += p.length; });
  return new Blob([result], { type: "application/pdf" });
}

function dlBlob(blob, fn) {
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = fn;
  document.body.appendChild(a); a.click();
  setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(a.href); }, 200);
}

/* ── App ── */
let _u = 0, _b = 0;
const P = {
  bg:"#0A0E13",surface:"#111820",card:"#171F2C",border:"#222E40",borderLight:"#2C3C54",
  accent:"#D946EF",accentDark:"#A21CAF",glow:"rgba(217,70,239,0.07)",glow2:"rgba(217,70,239,0.16)",
  text:"#E8EDF5",textMid:"#94A0B4",textDim:"#586578",
  green:"#34D399",yellow:"#FCD34D",red:"#FB7185",cyan:"#22D3EE",blue:"#60A5FA",
};

export default function App() {
  const [templates, setTemplates] = useState([]);
  const [substrates, setSubstrates] = useState(["Glossy","Matte","Canvas","Metal","Acrylic","Wood"]);
  const [batches, setBatches] = useState([]);
  const [tab, setTab] = useState("templates");
  const [expBatch, setExpBatch] = useState(null);
  const [status, setStatus] = useState("");
  const [newSub, setNewSub] = useState("");
  const [generating, setGenerating] = useState(false);
  const [activeBatch, setActiveBatch] = useState(null);
  const [loading, setLoading] = useState(true);
  const tmplRef = useRef();
  const imgRef = useRef();

  // Load saved templates + substrates on mount
  useEffect(() => {
    (async () => {
      await loadJSZip();
      setStatus("Loading saved templates...");
      try {
        const saved = await loadSavedTemplates();
        if (saved.length) {
          // Set _u counter past saved IDs
          _u = Math.max(...saved.map(t => t.id), 0);
          setTemplates(saved);
          setTab("batches"); // go to batches if templates already loaded
        }
      } catch (e) { console.warn("Failed to load templates:", e); }
      try {
        const subs = await loadSubstrates();
        if (subs) setSubstrates(subs);
      } catch {}
      setStatus("");
      setLoading(false);
    })();
  }, []);

  const saveSubs = s => { setSubstrates(s); saveSubstrates(s); };

  const handleTmplUpload = async (e) => {
    const files = Array.from(e.target.files); if (!files.length) return;
    setStatus("Analyzing...");
    for (const file of files) {
      try {
        const buf = await file.arrayBuffer();
        const info = await parseIDML(buf);
        const id = ++_u;
        const idmlBase64 = arrayBufferToBase64(buf);
        const tmpl = {
          id, name: file.name.replace(/\.idml$/i, ""), fileName: file.name,
          idmlBase64, info, sizeLabel: info.sizeLabel, totalFrames: info.totalFrames,
          pageW: info.pageW, pageH: info.pageH, spreadCount: info.spreads.length,
        };
        setTemplates(prev => [...prev, tmpl]);
        setStatus(`Saving ${file.name}...`);
        await saveTemplate(tmpl);
      } catch (err) { setStatus(`Error: ${err.message}`); }
    }
    setStatus("Templates saved!"); 
    setTimeout(() => setStatus(""), 2000);
    e.target.value = "";
  };

  const removeTemplate = async (id) => {
    setTemplates(prev => prev.filter(t => t.id !== id));
    await deleteTemplate(id);
  };

  const handleImgUpload = async (e) => {
    const files = Array.from(e.target.files); if (!files.length || !activeBatch) return;
    const bid = activeBatch;
    setStatus(`Loading ${files.length} images...`);
    const loaded = [];
    for (const f of files) loaded.push(await readImageFile(f));
    setBatches(prev => prev.map(b => b.id === bid ? { ...b, images: [...b.images, ...loaded] } : b));
    setStatus(""); e.target.value = ""; setActiveBatch(null);
  };

  const triggerImgUpload = (bid) => { setActiveBatch(bid); setTimeout(() => imgRef.current?.click(), 50); };
  const createBatch = () => {
    if (!templates.length) { setStatus("Upload templates first"); setTimeout(() => setStatus(""), 2000); return; }
    const b = { id: ++_b, name: `Batch ${_b}`, templateId: templates[0].id, substrate: substrates[0] || "Glossy", images: [], orderNumber: "", customerInfo: "" };
    setBatches(prev => [...prev, b]); setExpBatch(b.id);
  };
  const updateBatch = (id, k, v) => setBatches(prev => prev.map(b => b.id === id ? { ...b, [k]: v } : b));
  const rmImg = (bid, idx) => setBatches(prev => prev.map(b => b.id === bid ? { ...b, images: b.images.filter((_, i) => i !== idx) } : b));

  // Load QR library once
  useEffect(() => {
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.min.js";
    document.head.appendChild(s);
  }, []);

  // Render QR code to a canvas and return JPEG bytes
  function renderQRtoJPEG(text, pxSize) {
    try {
      const qr = window.qrcode(0, 'L');
      qr.addData(text);
      qr.make();
      const count = qr.getModuleCount();
      const cellSize = Math.floor(pxSize / count);
      const canvas = document.createElement("canvas");
      canvas.width = cellSize * count;
      canvas.height = cellSize * count;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "#000000";
      for (let r = 0; r < count; r++) {
        for (let c = 0; c < count; c++) {
          if (qr.isDark(r, c)) ctx.fillRect(c * cellSize, r * cellSize, cellSize, cellSize);
        }
      }
      const du = canvas.toDataURL("image/jpeg", 0.95);
      const b64 = du.split(",")[1], bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return { bytes, width: canvas.width, height: canvas.height };
    } catch (e) {
      console.warn("QR generation failed:", e);
      return null;
    }
  }

  // Build traveler PDF with QR image embedded
  function buildTravelerWithQR(batch, tmpl, filledCount, stickerUrl) {
    const qrJpeg = renderQRtoJPEG(stickerUrl, 300);

    const pw = 8.5 * 72, ph = 5.5 * 72;
    const parts = []; let pos = 0; const offsets = {};
    function writeStr(s) { const b = new TextEncoder().encode(s); parts.push(b); pos += b.length; }
    function writeBuf(buf) { parts.push(buf); pos += buf.length; }
    function markObj(n) { offsets[n] = pos; }

    const timestamp = new Date().toLocaleString();
    const lm = 36, rm = pw - 36;
    const qrPtSize = 80;
    const qrX = pw - 36 - qrPtSize, qrY = ph - 32 - qrPtSize;

    let cs = "";
    let y = ph - 32;

    // Title bar
    cs += `q 0.82 0.29 0.94 rg ${lm} ${y - 2} ${rm - lm} 16 re f Q\n`;
    cs += `BT /F2 11 Tf 1 1 1 rg ${lm + 6} ${y} Td (PRODUCTION TRAVELER) Tj ET\n`;
    y -= 24;

    // Info columns
    const col1 = lm, col1v = lm + 55, col2 = 230, col2v = 290;
    const sm = 7.5, lh = 11;

    [["Batch:", batch.name], ["Order:", batch.orderNumber || "N/A"],
     ["Customer:", batch.customerInfo || "N/A"], ["Date:", timestamp]
    ].forEach(([label, value], i) => {
      const ly = y - i * lh;
      cs += `BT /F2 ${sm} Tf 0.4 0.4 0.4 rg ${col1} ${ly} Td (${label}) Tj ET\n`;
      cs += `BT /F1 ${sm} Tf 0 0 0 rg ${col1v} ${ly} Td (${value.replace(/[()\\]/g, "\\$&")}) Tj ET\n`;
    });
    [["Template:", tmpl.name], ["Size:", tmpl.sizeLabel],
     ["Tray:", `${tmpl.pageW.toFixed(1)}x${tmpl.pageH.toFixed(1)}"`], ["Substrate:", batch.substrate]
    ].forEach(([label, value], i) => {
      const ly = y - i * lh;
      cs += `BT /F2 ${sm} Tf 0.4 0.4 0.4 rg ${col2} ${ly} Td (${label}) Tj ET\n`;
      cs += `BT /F1 ${sm} Tf 0 0 0 rg ${col2v} ${ly} Td (${value.replace(/[()\\]/g, "\\$&")}) Tj ET\n`;
    });
    y -= 4 * lh + 4;

    // Stats bar
    cs += `q 0.95 0.95 0.95 rg ${lm} ${y - 2} ${rm - lm} 13 re f Q\n`;
    cs += `BT /F2 ${sm} Tf 0.3 0.3 0.3 rg ${lm + 6} ${y} Td (Filled: ${filledCount}/${tmpl.totalFrames}) Tj ET\n`;
    cs += `BT /F1 ${sm} Tf ${200} ${y} Td (Empty: ${tmpl.totalFrames - filledCount}) Tj ET\n`;
    y -= 18;

    // Photo manifest
    cs += `BT /F2 8 Tf 0.82 0.29 0.94 rg ${lm} ${y} Td (PHOTO MANIFEST) Tj ET\n`;
    y -= 10;
    cs += `q 0.92 0.92 0.92 rg ${lm} ${y - 2} ${rm - lm} 10 re f Q\n`;
    cs += `BT /F2 6.5 Tf 0.3 0.3 0.3 rg ${lm + 4} ${y} Td (#) Tj ET\n`;
    cs += `BT /F2 6.5 Tf ${lm + 18} ${y} Td (Filename) Tj ET\n`;
    const mcol2 = pw / 2 + 10;
    cs += `BT /F2 6.5 Tf ${mcol2} ${y} Td (#) Tj ET\n`;
    cs += `BT /F2 6.5 Tf ${mcol2 + 18} ${y} Td (Filename) Tj ET\n`;
    y -= 11;

    const half = Math.ceil(batch.images.length / 2);
    for (let i = 0; i < half; i++) {
      if (y < 30) break;
      cs += `BT /F1 6.5 Tf 0 0 0 rg ${lm + 4} ${y} Td (${i + 1}) Tj ET\n`;
      cs += `BT /F1 6.5 Tf ${lm + 18} ${y} Td (${batch.images[i].fileName.substring(0, 30).replace(/[()\\]/g, "\\$&")}) Tj ET\n`;
      const j = i + half;
      if (j < batch.images.length) {
        cs += `BT /F1 6.5 Tf ${mcol2} ${y} Td (${j + 1}) Tj ET\n`;
        cs += `BT /F1 6.5 Tf ${mcol2 + 18} ${y} Td (${batch.images[j].fileName.substring(0, 30).replace(/[()\\]/g, "\\$&")}) Tj ET\n`;
      }
      y -= 9;
    }

    // QR code image (top right)
    if (qrJpeg) {
      cs += `q ${qrPtSize} 0 0 ${qrPtSize} ${qrX} ${qrY} cm /QR Do Q\n`;
      cs += `BT /F1 5 Tf 0.5 0.5 0.5 rg ${qrX} ${qrY - 9} Td (Scan for piece stickers) Tj ET\n`;
    }

    // Footer
    cs += `q 0.85 0.85 0.85 RG 0.3 w ${lm} 24 m ${rm} 24 l S Q\n`;
    cs += `BT /F1 5.5 Tf 0.6 0.6 0.6 rg ${lm} 16 Td (Imposition Studio | ${timestamp}) Tj ET\n`;

    const csBytes = new TextEncoder().encode(cs);

    // PDF objects — 7 if QR image, 6 if not
    const hasQR = !!qrJpeg;
    const TOTAL = hasQR ? 7 : 6;

    writeStr('%PDF-1.5\n%\xe2\xe3\xcf\xd3\n');
    markObj(1); writeStr('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
    markObj(2); writeStr('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n');

    const xobjStr = hasQR ? ' /XObject << /QR 7 0 R >>' : '';
    markObj(3); writeStr(`3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] /Contents 4 0 R /Resources << /Font << /F1 5 0 R /F2 6 0 R >>${xobjStr} >> >>\nendobj\n`);
    markObj(4); writeStr(`4 0 obj\n<< /Length ${csBytes.length} >>\nstream\n`); writeBuf(csBytes); writeStr('\nendstream\nendobj\n');
    markObj(5); writeStr('5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n');
    markObj(6); writeStr('6 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>\nendobj\n');

    if (hasQR) {
      markObj(7);
      writeStr(`7 0 obj\n<< /Type /XObject /Subtype /Image /Width ${qrJpeg.width} /Height ${qrJpeg.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${qrJpeg.bytes.length} >>\nstream\n`);
      writeBuf(qrJpeg.bytes);
      writeStr('\nendstream\nendobj\n');
    }

    const xp = pos;
    writeStr(`xref\n0 ${TOTAL + 1}\n0000000000 65535 f \n`);
    for (let i = 1; i <= TOTAL; i++) writeStr(`${String(offsets[i] || 0).padStart(10, '0')} 00000 n \n`);
    writeStr(`trailer\n<< /Size ${TOTAL + 1} /Root 1 0 R >>\nstartxref\n${xp}\n%%EOF`);

    let total = 0; parts.forEach(p => total += p.length);
    const result = new Uint8Array(total); let off = 0;
    parts.forEach(p => { result.set(p, off); off += p.length; });
    return new Blob([result], { type: "application/pdf" });
  }

  const genPDF = async (batch) => {
    const tmpl = templates.find(t => t.id === batch.templateId);
    if (!tmpl || !batch.images.length) return;
    setGenerating(true);
    try {
      const allFrames = tmpl.info.spreads.flatMap(s => s.imageFrames);
      const filled = allFrames
        .map((f, i) => ({ x: f.x, y: f.y, w: f.w, h: f.h, label: f.label, flipX: f.flipX, flipY: f.flipY, image: i < batch.images.length ? batch.images[i] : null }))
        .filter(p => p.image);

      setStatus(`Uploading ${filled.length} images for PDF generation...`);

      const baseName = `${batch.name.replace(/\s/g, "_")}_${tmpl.sizeLabel.replace(/[^a-zA-Z0-9]/g, "")}_${batch.substrate}`;

      // Build sticker URL with piece data
      const stickerData = {
        orderNumber: batch.orderNumber || "",
        batchName: batch.name,
        sizeLabel: tmpl.sizeLabel,
        substrate: batch.substrate,
        pieces: batch.images.map(img => ({ fileName: img.fileName })),
      };
      const stickerUrl = `${window.location.origin}/stickers?d=${btoa(JSON.stringify(stickerData))}`;

      const payload = {
        trayW: tmpl.pageW,
        trayH: tmpl.pageH,
        filename: `${baseName}.pdf`,
        placements: filled.map(p => ({
          x: p.x, y: p.y, w: p.w, h: p.h,
          flipX: !!p.flipX, flipY: !!p.flipY,
          imageBase64: p.image.dataUrl,
        })),
      };

      const resp = await fetch("/api/generate-pdf", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: resp.statusText }));
        throw new Error(err.error || "PDF generation failed");
      }

      // Download tray PDF
      const trayBlob = await resp.blob();
      dlBlob(trayBlob, `${baseName}.pdf`);

      // Generate and download traveler PDF with QR code
      setStatus("Generating traveler...");
      const travelerBlob = buildTravelerWithQR(batch, tmpl, filled.length, stickerUrl);
      setTimeout(() => dlBlob(travelerBlob, `${baseName}_traveler.pdf`), 500);

      setStatus(`Done! ${filled.length} photos placed. Tray + traveler downloaded.`);
      setTimeout(() => setStatus(""), 3000);
    } catch (err) { setStatus(`Error: ${err.message}`); console.error(err); }
    finally { setGenerating(false); }
  };

  const font = "'IBM Plex Mono','Fira Code',monospace";
  const P_ = P;
  const ss = {
    app: { fontFamily: font, background: P_.bg, color: P_.text, minHeight: "100vh" },
    hdr: { background: `linear-gradient(180deg,${P_.surface},${P_.bg})`, borderBottom: `1px solid ${P_.border}`, padding: "20px 28px", display: "flex", alignItems: "center", gap: 14 },
    logo: { width: 44, height: 44, borderRadius: 12, background: `linear-gradient(135deg,${P_.accent},${P_.accentDark})`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20, fontWeight: 900, color: "#fff", boxShadow: `0 0 24px ${P_.glow2}` },
    body: { padding: "20px 28px", maxWidth: 1100, margin: "0 auto" },
    tabs: { display: "flex", gap: 0, marginBottom: 20, borderBottom: `1px solid ${P_.border}`, overflowX: "auto" },
    tab: a => ({ padding: "10px 20px", cursor: "pointer", fontSize: 12, fontWeight: 600, letterSpacing: ".05em", textTransform: "uppercase", background: "none", border: "none", fontFamily: font, color: a ? P_.accent : P_.textDim, borderBottom: a ? `2px solid ${P_.accent}` : "2px solid transparent", whiteSpace: "nowrap" }),
    card: { background: P_.card, border: `1px solid ${P_.border}`, borderRadius: 12, padding: 16, marginBottom: 14 },
    row: { display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" },
    btn: v => ({ padding: "8px 16px", borderRadius: 8, fontWeight: 600, fontSize: 13, cursor: generating ? "not-allowed" : "pointer", fontFamily: font, border: v === "primary" ? "none" : `1px solid ${P_.border}`, background: v === "primary" ? `linear-gradient(135deg,${P_.accent},${P_.accentDark})` : P_.surface, color: v === "primary" ? "#fff" : P_.text, opacity: generating ? 0.5 : 1 }),
    sm: v => ({ padding: "5px 12px", borderRadius: 7, fontWeight: 600, fontSize: 12, cursor: generating ? "not-allowed" : "pointer", fontFamily: font, border: v === "primary" ? "none" : `1px solid ${P_.border}`, background: v === "primary" ? `linear-gradient(135deg,${P_.accent},${P_.accentDark})` : P_.surface, color: v === "primary" ? "#fff" : P_.text, opacity: generating ? 0.5 : 1 }),
    sel: { padding: "8px 10px", borderRadius: 7, border: `1px solid ${P_.border}`, background: P_.bg, color: P_.text, fontSize: 13, fontFamily: font, outline: "none" },
    inp: w => ({ padding: "8px 10px", borderRadius: 7, border: `1px solid ${P_.border}`, background: P_.bg, color: P_.text, fontSize: 13, fontFamily: font, outline: "none", width: w }),
    lbl: { fontSize: 10, color: P_.textDim, textTransform: "uppercase", letterSpacing: ".07em", marginBottom: 4 },
    badge: c => ({ display: "inline-block", padding: "3px 10px", borderRadius: 14, fontSize: 11, fontWeight: 600, background: c + "18", color: c }),
    tag: { display: "inline-flex", alignItems: "center", gap: 5, padding: "5px 12px", borderRadius: 7, fontSize: 12, fontWeight: 500, background: P_.surface, border: `1px solid ${P_.border}`, color: P_.text },
    tagX: { background: "none", border: "none", color: P_.red, cursor: "pointer", fontSize: 14, padding: 0, lineHeight: 1, fontFamily: font },
    drop: { border: `2px dashed ${P_.borderLight}`, borderRadius: 10, padding: "24px 16px", textAlign: "center", cursor: "pointer", background: P_.glow, fontSize: 13 },
  };

  if (loading) {
    return (
      <div style={{ ...ss.app, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ textAlign: "center", color: P_.textDim }}>
          <div style={{ fontSize: 28, marginBottom: 12 }}>◫</div>
          <div>Loading saved templates...</div>
        </div>
      </div>
    );
  }

  return (
    <div style={ss.app}>
      <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600;700&display=swap" rel="stylesheet" />
      <input ref={tmplRef} type="file" multiple accept=".idml" style={{ display: "none" }} onChange={handleTmplUpload} />
      <input ref={imgRef} type="file" multiple accept="image/*" style={{ display: "none" }} onChange={handleImgUpload} />

      <div style={ss.hdr}>
        <div style={ss.logo}>◫</div>
        <div>
          <div style={{ fontSize: 20, fontWeight: 700 }}>Imposition Studio</div>
          <div style={{ fontSize: 10, color: P_.textDim, textTransform: "uppercase", letterSpacing: ".1em" }}>IDML Templates • Photo Placement • Multi-Layer PDF • White Ink Spot + Overprint</div>
        </div>
      </div>
      <div style={ss.body}>
        {status && <div style={{ padding: 12, borderRadius: 8, marginBottom: 14, background: P_.accent + "22", border: `1px solid ${P_.accent}44`, fontSize: 13, color: P_.accent, textAlign: "center" }}>{status}</div>}
        <div style={ss.tabs}>
          {[["templates", `Templates (${templates.length})`], ["batches", `Batches (${batches.length})`], ["substrates", "Substrates"]].map(([k, l]) => (
            <button key={k} style={ss.tab(tab === k)} onClick={() => setTab(k)}>{l}</button>
          ))}
        </div>

        {tab === "templates" && <>
          <div style={ss.card}>
            <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 10 }}>IDML Templates</div>
            <div style={{ fontSize: 12, color: P_.textMid, marginBottom: 14, lineHeight: 1.7 }}>
              Upload InDesign IDML templates. They are <strong>saved automatically</strong> and will be here next time you open the app. Each needs an "image" layer with labeled frames and a "White" layer with White_Ink spot color + overprint.
            </div>
            <div style={ss.drop} onClick={() => tmplRef.current?.click()}>📐 Click to upload IDML templates</div>
          </div>
          {templates.map(t => (
            <div key={t.id} style={ss.card}>
              <div style={{ ...ss.row, justifyContent: "space-between" }}>
                <div style={ss.row}>
                  📄 <span style={{ fontWeight: 700, fontSize: 14 }}>{t.name}</span>
                  <span style={ss.badge(P_.accent)}>{t.sizeLabel}</span>
                  <span style={ss.badge(P_.green)}>{t.totalFrames} frames</span>
                  <span style={ss.badge(P_.cyan)}>{t.spreadCount} pg</span>
                  <span style={ss.badge(P_.yellow)}>{t.pageW.toFixed(1)}×{t.pageH.toFixed(1)}"</span>
                </div>
                <button style={ss.tagX} onClick={() => removeTemplate(t.id)} title="Remove template">✕</button>
              </div>
              <div style={{ fontSize: 11, color: P_.textDim, marginTop: 8 }}>
                Order: {t.info.spreads.flatMap(s => s.imageFrames.map(f => f.label)).slice(0, 12).join(" → ")}{t.totalFrames > 12 ? " ..." : ""}
              </div>
            </div>
          ))}
          {templates.length > 0 && <div style={{ padding: 14, borderRadius: 10, background: P_.glow, border: `1px solid ${P_.accent}33`, fontSize: 12, color: P_.textMid, lineHeight: 1.7 }}>
            <strong style={{ color: P_.accent }}>PDF output:</strong> Full-resolution images with cover-fit. Two OCG layers: "image" + "White_Ink" (Separation spot color named "White_Ink", C15 M100 Y100 K0 alternate, overprint). White_Ink only on filled slots.
          </div>}
        </>}

        {tab === "batches" && <>
          <div style={{ ...ss.row, justifyContent: "space-between", marginBottom: 16 }}>
            <div style={{ fontSize: 12, color: P_.textMid }}>Pick template → add photos → generate PDF</div>
            <button style={ss.btn("primary")} onClick={createBatch} disabled={generating}>+ New Batch</button>
          </div>
          {!templates.length && <div style={{ ...ss.card, textAlign: "center", padding: 28 }}><div style={{ color: P_.textDim }}>Upload IDML templates first.</div></div>}
          {batches.map(batch => {
            const isExp = expBatch === batch.id;
            const tmpl = templates.find(t => t.id === batch.templateId);
            const filled = tmpl ? Math.min(batch.images.length, tmpl.totalFrames) : 0;
            const overflow = tmpl ? Math.max(0, batch.images.length - tmpl.totalFrames) : 0;
            return (
              <div key={batch.id} style={{ ...ss.card, borderColor: isExp ? P_.accent + "66" : P_.border }}>
                <div style={{ ...ss.row, justifyContent: "space-between", marginBottom: isExp ? 14 : 0 }}>
                  <div style={{ ...ss.row, cursor: "pointer", flex: 1 }} onClick={() => setExpBatch(isExp ? null : batch.id)}>
                    <span style={{ fontSize: 18, color: P_.textDim, transform: isExp ? "rotate(90deg)" : "rotate(0)", transition: "transform .2s" }}>▸</span>
                    <input type="text" value={batch.name} onClick={e => e.stopPropagation()} onChange={e => updateBatch(batch.id, "name", e.target.value)}
                      style={{ ...ss.inp(140), fontWeight: 700, fontSize: 14, border: "none", background: "transparent", color: P_.text }} />
                    {tmpl && <span style={ss.badge(P_.accent)}>{tmpl.sizeLabel}</span>}
                    <span style={ss.badge(P_.green)}>{batch.substrate}</span>
                    <span style={ss.badge(P_.blue)}>{filled}/{tmpl?.totalFrames || "?"}</span>
                    {overflow > 0 && <span style={ss.badge(P_.red)}>+{overflow} overflow</span>}
                  </div>
                  <div style={ss.row}>
                    {batch.images.length > 0 && <button style={ss.sm("primary")} onClick={() => genPDF(batch)} disabled={generating}>{generating ? "..." : "↓ PDF"}</button>}
                    <button style={ss.tagX} onClick={() => setBatches(p => p.filter(x => x.id !== batch.id))}>✕</button>
                  </div>
                </div>
                {isExp && <>
                  <div style={{ ...ss.row, gap: 16, marginBottom: 14, padding: 14, background: P_.bg, borderRadius: 10 }}>
                    <div><div style={ss.lbl}>Template</div>
                      <select style={{ ...ss.sel, minWidth: 240 }} value={batch.templateId} onChange={e => updateBatch(batch.id, "templateId", parseInt(e.target.value))}>
                        {templates.map(t => <option key={t.id} value={t.id}>{t.name} ({t.sizeLabel}, {t.totalFrames} slots)</option>)}
                      </select></div>
                    <div><div style={ss.lbl}>Substrate</div>
                      <select style={{ ...ss.sel, minWidth: 130 }} value={batch.substrate} onChange={e => updateBatch(batch.id, "substrate", e.target.value)}>
                        {substrates.map(s => <option key={s} value={s}>{s}</option>)}
                      </select></div>
                    <div><div style={ss.lbl}>Order #</div>
                      <input type="text" value={batch.orderNumber || ""} onChange={e => updateBatch(batch.id, "orderNumber", e.target.value)}
                        placeholder="ORD-001" style={ss.inp(120)} /></div>
                    <div><div style={ss.lbl}>Customer</div>
                      <input type="text" value={batch.customerInfo || ""} onChange={e => updateBatch(batch.id, "customerInfo", e.target.value)}
                        placeholder="Customer name" style={ss.inp(160)} /></div>
                  </div>
                  <div style={ss.drop} onClick={() => triggerImgUpload(batch.id)}>
                    📸 Click to add photos — full resolution, cover-fit
                    {tmpl && <div style={{ fontSize: 11, color: P_.textDim, marginTop: 6 }}>{tmpl.totalFrames} slots available</div>}
                  </div>
                  {tmpl && batch.images.length > 0 && <div style={{ marginTop: 12 }}>
                    <div style={{ ...ss.lbl, marginBottom: 8 }}>Placement Preview ({filled}/{tmpl.totalFrames})</div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                      {tmpl.info.spreads.flatMap(s => s.imageFrames).map((frame, i) => {
                        const hasImg = i < batch.images.length;
                        const img = hasImg ? batch.images[i] : null;
                        return (
                          <div key={i} style={{ position: "relative", width: 56, height: 56, borderRadius: 5, overflow: "hidden", border: `1.5px solid ${hasImg ? P_.accent : P_.border}`, background: hasImg ? "none" : P_.bg }}>
                            {img && <img src={img.dataUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />}
                            <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, background: hasImg ? "rgba(0,0,0,0.6)" : "transparent", fontSize: 9, color: hasImg ? "#fff" : P_.textDim, textAlign: "center", padding: "2px 0" }}>{frame.label}</div>
                            {hasImg && <button onClick={() => rmImg(batch.id, i)}
                              style={{ position: "absolute", top: -2, right: -2, width: 16, height: 16, borderRadius: 8, background: P_.red, color: "#fff", border: "none", fontSize: 9, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>✕</button>}
                          </div>
                        );
                      })}
                    </div>
                  </div>}
                </>}
              </div>
            );
          })}
          {batches.length > 0 && batches.some(b => b.images.length > 0) && (
            <div style={{ textAlign: "right", marginTop: 14 }}>
              <button style={ss.btn("primary")} onClick={async () => { for (const b of batches) if (b.images.length) await genPDF(b); }} disabled={generating}>
                {generating ? "Generating..." : "↓ Generate All PDFs"}
              </button>
            </div>
          )}
        </>}

        {tab === "substrates" && <div style={ss.card}>
          <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 12 }}>Substrates</div>
          <div style={{ ...ss.row, gap: 8, marginBottom: 16 }}>
            {substrates.map((sub, i) => (<div key={i} style={ss.tag}><span>{sub}</span><button style={ss.tagX} onClick={() => saveSubs(substrates.filter((_, j) => j !== i))}>✕</button></div>))}
          </div>
          <div style={{ ...ss.row, gap: 10, padding: 14, background: P_.bg, borderRadius: 10 }}>
            <div><div style={ss.lbl}>Name</div><input type="text" value={newSub} onChange={e => setNewSub(e.target.value)} placeholder="Brushed Aluminum" style={ss.inp(180)}
              onKeyDown={e => { if (e.key === "Enter") { const s = newSub.trim(); if (s && !substrates.includes(s)) { saveSubs([...substrates, s]); setNewSub(""); } } }} /></div>
            <div style={{ paddingTop: 16 }}><button style={ss.btn("primary")} onClick={() => { const s = newSub.trim(); if (s && !substrates.includes(s)) { saveSubs([...substrates, s]); setNewSub(""); } }}>+ Add</button></div>
          </div>
        </div>}
      </div>
    </div>
  );
}
