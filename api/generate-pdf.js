function jpegDimensions(buf) {
  let i = 2;
  while (i < buf.length - 1) {
    if (buf[i] !== 0xFF) break;
    const marker = buf[i + 1];
    if (marker === 0xC0 || marker === 0xC1 || marker === 0xC2) {
      return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
    }
    const len = buf.readUInt16BE(i + 2);
    i += 2 + len;
  }
  return { width: 1000, height: 1000 };
}

function buildPDF(trayWIn, trayHIn, placements) {
  const PW = trayWIn * 72;
  const PH = trayHIn * 72;
  const parts = [];
  let pos = 0;
  const offsets = {};

  function writeStr(s) {
    const buf = Buffer.from(s, 'utf-8');
    parts.push(buf);
    pos += buf.length;
  }
  function writeBuf(buf) {
    parts.push(buf);
    pos += buf.length;
  }
  function markObj(n) {
    offsets[n] = pos;
  }

  const images = placements.map((p, idx) => {
    const dim = jpegDimensions(p.jpegBytes);
    return { ...p, imgW: dim.width, imgH: dim.height, idx };
  });

  const IMG_START = 10;
  const TOTAL_OBJS = IMG_START + images.length;

  let cs = '/OC /MC0 BDC\n';
  images.forEach((img, i) => {
    const fwPt = img.w * 72, fhPt = img.h * 72;
    const xPt = img.x * 72, yPt = PH - img.y * 72 - fhPt;
    const frameRatio = fwPt / fhPt, imgRatio = img.imgW / img.imgH;
    let drawW, drawH, drawX, drawY;
    if (imgRatio > frameRatio) {
      drawH = fhPt; drawW = fhPt * imgRatio;
      drawX = xPt - (drawW - fwPt) / 2; drawY = yPt;
    } else {
      drawW = fwPt; drawH = fwPt / imgRatio;
      drawX = xPt; drawY = yPt - (drawH - fhPt) / 2;
    }
    cs += `q\n${xPt.toFixed(2)} ${yPt.toFixed(2)} ${fwPt.toFixed(2)} ${fhPt.toFixed(2)} re W n\n`;
    cs += `${drawW.toFixed(2)} 0 0 ${drawH.toFixed(2)} ${drawX.toFixed(2)} ${drawY.toFixed(2)} cm\n/Img${i} Do\nQ\n`;
  });
  cs += 'EMC\n';
  cs += '/OC /MC1 BDC\n/GS_OP gs\n/CS_WI cs\n1 scn\n';
  images.forEach(img => {
    const x = img.x * 72, y = PH - img.y * 72 - img.h * 72;
    cs += `${x.toFixed(2)} ${y.toFixed(2)} ${(img.w * 72).toFixed(2)} ${(img.h * 72).toFixed(2)} re f\n`;
  });
  cs += 'EMC\n';

  const csBytes = Buffer.from(cs, 'utf-8');
  let xoEntries = '';
  images.forEach((_, i) => { xoEntries += `/Img${i} ${IMG_START + i} 0 R `; });

  writeStr('%PDF-1.5\n%\xe2\xe3\xcf\xd3\n');
  markObj(1); writeStr(`1 0 obj\n<< /Type /Catalog /Pages 2 0 R /OCProperties << /OCGs [5 0 R 6 0 R] /D << /ON [5 0 R 6 0 R] /OFF [] /Order [5 0 R 6 0 R] /Name (Layers) /BaseState /ON >> >> >>\nendobj\n`);
  markObj(2); writeStr(`2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n`);
  markObj(3); writeStr(`3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PW} ${PH}] /Contents 4 0 R /Resources << /XObject << ${xoEntries}>> /ColorSpace << /CS_WI 9 0 R >> /Properties << /MC0 5 0 R /MC1 6 0 R >> /ExtGState << /GS_OP 7 0 R >> >> >>\nendobj\n`);
  markObj(4); writeStr(`4 0 obj\n<< /Length ${csBytes.length} >>\nstream\n`); writeBuf(csBytes); writeStr('\nendstream\nendobj\n');
  markObj(5); writeStr('5 0 obj\n<< /Type /OCG /Name (image) >>\nendobj\n');
  markObj(6); writeStr('6 0 obj\n<< /Type /OCG /Name (White_Ink) >>\nendobj\n');
  markObj(7); writeStr('7 0 obj\n<< /Type /ExtGState /OP true /op true /OPM 1 >>\nendobj\n');
  markObj(8); writeStr('8 0 obj\n<< /FunctionType 2 /Domain [0 1] /C0 [0 0 0 0] /C1 [0.15 1 1 0] /N 1 >>\nendobj\n');
  markObj(9); writeStr('9 0 obj\n[/Separation /White_Ink /DeviceCMYK 8 0 R]\nendobj\n');

  images.forEach((img, i) => {
    const n = IMG_START + i;
    markObj(n);
    writeStr(`${n} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${img.imgW} /Height ${img.imgH} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${img.jpegBytes.length} >>\nstream\n`);
    writeBuf(img.jpegBytes);
    writeStr('\nendstream\nendobj\n');
  });

  const xrefPos = pos;
  writeStr(`xref\n0 ${TOTAL_OBJS + 1}\n0000000000 65535 f \n`);
  for (let i = 1; i <= TOTAL_OBJS; i++) {
    writeStr(`${String(offsets[i] || 0).padStart(10, '0')} 00000 n \n`);
  }
  writeStr(`trailer\n<< /Size ${TOTAL_OBJS + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`);

  return Buffer.concat(parts);
}

function buildTestPDF() {
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
  cs += 'EMC\n/OC /MC1 BDC\n/GS_OP gs\n/CS_WI cs\n1 scn\n';
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

export default function (req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method === 'GET') {
    try {
      const pdf = buildTestPDF();
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'attachment; filename="test_layers.pdf"');
      return res.status(200).send(pdf);
    } catch (e) {
      return res.status(500).json({ error: e.message, stack: e.stack });
    }
  }

  if (req.method === 'POST') {
    try {
      const { trayW, trayH, placements, filename } = req.body;

      const decoded = placements.map(function (p) {
        var b64 = p.imageBase64;
        if (b64.indexOf(',') !== -1) b64 = b64.split(',')[1];
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
      res.setHeader('Content-Disposition', 'attachment; filename="' + (filename || 'imposition.pdf') + '"');
      return res.status(200).send(pdf);
    } catch (e) {
      return res.status(500).json({ error: e.message, stack: e.stack });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
