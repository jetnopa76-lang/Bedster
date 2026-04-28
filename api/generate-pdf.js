const { Buffer } = require('buffer');

/**
 * Vercel Node.js serverless function: /api/generate-pdf
 * 
 * POST: accepts JSON with image data + placement coords, returns production PDF
 * GET: returns a test PDF to verify layers work
 * 
 * PDF structure (matches working ReportLab output):
 *   - OCG layer "image" with JPEG images placed via XObject
 *   - OCG layer "White_Ink" with Separation spot color + overprint
 *   - Both layers wrapped in /OC BDC...EMC marked content
 *   - Single page, both layers on same page
 */

function buildPDF(trayWIn, trayHIn, placements) {
  // placements: [{x, y, w, h, jpegBytes}] — all in inches, jpegBytes is Buffer
  const PW = trayWIn * 72;
  const PH = trayHIn * 72;

  // Collect all parts as buffers
  const parts = [];
  let pos = 0;
  const offsets = {};

  function write(data) {
    const buf = typeof data === 'string' ? Buffer.from(data, 'binary') : data;
    parts.push(buf);
    pos += buf.length;
  }

  function writeStr(s) {
    const buf = Buffer.from(s, 'utf-8');
    parts.push(buf);
    pos += buf.length;
  }

  function markObj(n) {
    offsets[n] = pos;
  }

  // Get JPEG dimensions from JFIF/EXIF header
  function jpegDimensions(buf) {
    let i = 2;
    while (i < buf.length - 1) {
      if (buf[i] !== 0xFF) break;
      const marker = buf[i + 1];
      if (marker === 0xC0 || marker === 0xC1 || marker === 0xC2) {
        const h = buf.readUInt16BE(i + 5);
        const w = buf.readUInt16BE(i + 7);
        return { width: w, height: h };
      }
      const len = buf.readUInt16BE(i + 2);
      i += 2 + len;
    }
    return { width: 1000, height: 1000 };
  }

  // Decode base64 images and get dimensions
  const images = placements.map((p, idx) => {
    const jpegBuf = p.jpegBytes;
    const dim = jpegDimensions(jpegBuf);
    return { ...p, jpegBuf, imgW: dim.width, imgH: dim.height, idx };
  });

  // Object layout:
  // 1: Catalog
  // 2: Pages
  // 3: Page
  // 4: Content stream
  // 5: OCG "image"
  // 6: OCG "White_Ink"
  // 7: ExtGState overprint
  // 8: Tint function
  // 9: Separation colorspace array
  // 10+: Image XObjects
  const IMG_START = 10;
  const TOTAL_OBJS = IMG_START + images.length;

  // Build content stream
  let cs = '/OC /MC0 BDC\n';
  images.forEach((img, i) => {
    const fwPt = img.w * 72;
    const fhPt = img.h * 72;
    const xPt = img.x * 72;
    const yPt = PH - img.y * 72 - fhPt;

    // Cover-fit calculation
    const frameRatio = fwPt / fhPt;
    const imgRatio = img.imgW / img.imgH;
    let drawW, drawH, drawX, drawY;
    if (imgRatio > frameRatio) {
      drawH = fhPt; drawW = fhPt * imgRatio;
      drawX = xPt - (drawW - fwPt) / 2; drawY = yPt;
    } else {
      drawW = fwPt; drawH = fwPt / imgRatio;
      drawX = xPt; drawY = yPt - (drawH - fhPt) / 2;
    }

    cs += 'q\n';
    cs += `${xPt.toFixed(2)} ${yPt.toFixed(2)} ${fwPt.toFixed(2)} ${fhPt.toFixed(2)} re W n\n`;
    cs += `${drawW.toFixed(2)} 0 0 ${drawH.toFixed(2)} ${drawX.toFixed(2)} ${drawY.toFixed(2)} cm\n`;
    cs += `/Img${i} Do\n`;
    cs += 'Q\n';
  });
  cs += 'EMC\n';

  // White_Ink layer
  cs += '/OC /MC1 BDC\n';
  cs += '/GS_OP gs\n';
  cs += '/CS_WI cs\n';
  cs += '1 scn\n';
  images.forEach(img => {
    const x = img.x * 72;
    const y = PH - img.y * 72 - img.h * 72;
    const w = img.w * 72;
    const h = img.h * 72;
    cs += `${x.toFixed(2)} ${y.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re f\n`;
  });
  cs += 'EMC\n';

  const csBytes = Buffer.from(cs, 'utf-8');

  // Build XObject resource entries
  let xoEntries = '';
  images.forEach((_, i) => {
    xoEntries += `/Img${i} ${IMG_START + i} 0 R `;
  });

  // === Write PDF ===
  writeStr('%PDF-1.5\n%\xe2\xe3\xcf\xd3\n');

  // 1: Catalog
  markObj(1);
  writeStr(`1 0 obj\n<< /Type /Catalog /Pages 2 0 R /OCProperties << /OCGs [5 0 R 6 0 R] /D << /ON [5 0 R 6 0 R] /OFF [] /Order [5 0 R 6 0 R] /Name (Layers) /BaseState /ON >> >> >>\nendobj\n`);

  // 2: Pages
  markObj(2);
  writeStr(`2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n`);

  // 3: Page
  markObj(3);
  writeStr(`3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PW} ${PH}] /Contents 4 0 R /Resources << /XObject << ${xoEntries}>> /ColorSpace << /CS_WI 9 0 R >> /Properties << /MC0 5 0 R /MC1 6 0 R >> /ExtGState << /GS_OP 7 0 R >> >> >>\nendobj\n`);

  // 4: Content stream
  markObj(4);
  writeStr(`4 0 obj\n<< /Length ${csBytes.length} >>\nstream\n`);
  write(csBytes);
  writeStr('\nendstream\nendobj\n');

  // 5: OCG "image"
  markObj(5);
  writeStr('5 0 obj\n<< /Type /OCG /Name (image) >>\nendobj\n');

  // 6: OCG "White_Ink"
  markObj(6);
  writeStr('6 0 obj\n<< /Type /OCG /Name (White_Ink) >>\nendobj\n');

  // 7: ExtGState overprint
  markObj(7);
  writeStr('7 0 obj\n<< /Type /ExtGState /OP true /op true /OPM 1 >>\nendobj\n');

  // 8: Tint transform: tint [0..1] -> CMYK [C15 M100 Y100 K0]
  markObj(8);
  writeStr('8 0 obj\n<< /FunctionType 2 /Domain [0 1] /C0 [0 0 0 0] /C1 [0.15 1 1 0] /N 1 >>\nendobj\n');

  // 9: Separation colorspace
  markObj(9);
  writeStr('9 0 obj\n[/Separation /White_Ink /DeviceCMYK 8 0 R]\nendobj\n');

  // 10+: Image XObjects (JPEG streams)
  images.forEach((img, i) => {
    const objNum = IMG_START + i;
    markObj(objNum);
    writeStr(`${objNum} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${img.imgW} /Height ${img.imgH} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${img.jpegBuf.length} >>\nstream\n`);
    write(img.jpegBuf);
    writeStr('\nendstream\nendobj\n');
  });

  // Cross-reference table
  const xrefPos = pos;
  writeStr(`xref\n0 ${TOTAL_OBJS + 1}\n`);
  writeStr('0000000000 65535 f \n');
  for (let i = 1; i <= TOTAL_OBJS; i++) {
    writeStr(`${String(offsets[i] || 0).padStart(10, '0')} 00000 n \n`);
  }
  writeStr(`trailer\n<< /Size ${TOTAL_OBJS + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`);

  return Buffer.concat(parts);
}

function buildTestPDF() {
  // Simple test with gray rectangles — no images needed
  const PW = 24 * 72, PH = 14.5 * 72;
  const rects = [
    { x: 1, y: 1, w: 3, h: 3 },
    { x: 5, y: 1, w: 3, h: 3 },
    { x: 9, y: 1, w: 3, h: 3 },
  ];

  let cs = '/OC /MC0 BDC\n';
  rects.forEach(r => {
    const x = r.x * 72, y = PH - r.y * 72 - r.h * 72, w = r.w * 72, h = r.h * 72;
    cs += `q 0.85 0.85 0.85 rg ${x.toFixed(2)} ${y.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re f Q\n`;
  });
  cs += 'EMC\n';
  cs += '/OC /MC1 BDC\n/GS_OP gs\n/CS_WI cs\n1 scn\n';
  rects.forEach(r => {
    const x = r.x * 72, y = PH - r.y * 72 - r.h * 72, w = r.w * 72, h = r.h * 72;
    cs += `${x.toFixed(2)} ${y.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re f\n`;
  });
  cs += 'EMC\n';

  const csBytes = Buffer.from(cs, 'utf-8');
  const parts = [];
  let pos = 0;
  const offsets = {};
  function writeStr(s) { const b = Buffer.from(s, 'utf-8'); parts.push(b); pos += b.length; }
  function markObj(n) { offsets[n] = pos; }

  writeStr('%PDF-1.5\n%\xe2\xe3\xcf\xd3\n');
  markObj(1); writeStr('1 0 obj\n<< /Type /Catalog /Pages 2 0 R /OCProperties << /OCGs [5 0 R 6 0 R] /D << /ON [5 0 R 6 0 R] /OFF [] /Order [5 0 R 6 0 R] /Name (Layers) /BaseState /ON >> >> >>\nendobj\n');
  markObj(2); writeStr('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n');
  markObj(3); writeStr(`3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PW} ${PH}] /Contents 4 0 R /Resources << /ColorSpace << /CS_WI 9 0 R >> /Properties << /MC0 5 0 R /MC1 6 0 R >> /ExtGState << /GS_OP 7 0 R >> >> >>\nendobj\n`);
  markObj(4); writeStr(`4 0 obj\n<< /Length ${csBytes.length} >>\nstream\n`); parts.push(csBytes); pos += csBytes.length; writeStr('\nendstream\nendobj\n');
  markObj(5); writeStr('5 0 obj\n<< /Type /OCG /Name (image) >>\nendobj\n');
  markObj(6); writeStr('6 0 obj\n<< /Type /OCG /Name (White_Ink) >>\nendobj\n');
  markObj(7); writeStr('7 0 obj\n<< /Type /ExtGState /OP true /op true /OPM 1 >>\nendobj\n');
  markObj(8); writeStr('8 0 obj\n<< /FunctionType 2 /Domain [0 1] /C0 [0 0 0 0] /C1 [0.15 1 1 0] /N 1 >>\nendobj\n');
  markObj(9); writeStr('9 0 obj\n[/Separation /White_Ink /DeviceCMYK 8 0 R]\nendobj\n');

  const TOTAL = 9;
  const xp = pos;
  writeStr(`xref\n0 ${TOTAL + 1}\n0000000000 65535 f \n`);
  for (let i = 1; i <= TOTAL; i++) writeStr(`${String(offsets[i] || 0).padStart(10, '0')} 00000 n \n`);
  writeStr(`trailer\n<< /Size ${TOTAL + 1} /Root 1 0 R >>\nstartxref\n${xp}\n%%EOF`);

  return Buffer.concat(parts);
}

module.exports = async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // GET: return test PDF
  if (req.method === 'GET') {
    try {
      const pdf = buildTestPDF();
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'attachment; filename="test_layers.pdf"');
      return res.status(200).send(pdf);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // POST: generate imposition PDF
  if (req.method === 'POST') {
    try {
      const { trayW, trayH, placements, filename } = req.body;

      // Decode base64 images to JPEG buffers
      const decoded = placements.map(p => {
        let b64 = p.imageBase64;
        if (b64.includes(',')) b64 = b64.split(',')[1];
        return {
          x: p.x,
          y: p.y,
          w: p.w,
          h: p.h,
          jpegBytes: Buffer.from(b64, 'base64'),
        };
      });

      const pdf = buildPDF(trayW, trayH, decoded);

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${filename || 'imposition.pdf'}"`);
      return res.status(200).send(pdf);
    } catch (e) {
      return res.status(500).json({ error: e.message, stack: e.stack });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
