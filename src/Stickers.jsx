import { useState, useEffect, useRef } from "react";

// Minimal QR code generator (alphanumeric mode, error correction L)
// Based on https://github.com/nayuki/QR-Code-generator (public domain)
function generateQR(text) {
  // Use the canvas-based approach with a CDN lib for reliability
  // We'll render QR as an SVG path for clean scaling
  const modules = qrEncode(text);
  return modules;
}

// Simplified QR encoder — generates module matrix
function qrEncode(text) {
  // For simplicity and reliability, we'll use a dynamic script load
  // But since we need it synchronous for rendering, we'll use a
  // pre-computed approach with the qr-creator pattern
  
  // Actually, let's embed a minimal QR encoder
  // This handles up to ~100 chars which is enough for our piece codes
  
  // We'll generate QR as SVG string instead
  return text; // placeholder — actual QR rendering done via canvas in component
}

export default function StickersPage() {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [qrLibReady, setQrLibReady] = useState(false);
  const canvasRefs = useRef({});

  useEffect(() => {
    // Load QR library
    const script = document.createElement("script");
    script.src = "https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js";
    script.onload = () => setQrLibReady(true);
    script.onerror = () => {
      // Fallback: try another CDN
      const s2 = document.createElement("script");
      s2.src = "https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.min.js";
      s2.onload = () => setQrLibReady(true);
      document.head.appendChild(s2);
    };
    document.head.appendChild(script);

    // Parse URL params
    try {
      const params = new URLSearchParams(window.location.search);
      const encoded = params.get("d");
      if (encoded) {
        const json = JSON.parse(atob(encoded));
        setData(json);
      } else {
        setError("No sticker data found. Scan a traveler QR code to access this page.");
      }
    } catch (e) {
      setError("Invalid sticker data: " + e.message);
    }
  }, []);

  // Generate QR codes once library is loaded
  useEffect(() => {
    if (!qrLibReady || !data) return;

    data.pieces.forEach((piece, i) => {
      const el = document.getElementById(`qr-${i}`);
      if (!el || el.children.length > 0) return;
      
      const qrText = `${data.orderNumber || "N/A"}|${i + 1}|${piece.fileName}|${data.sizeLabel}|${data.substrate}`;
      
      if (window.QRCode) {
        new window.QRCode(el, {
          text: qrText,
          width: 80,
          height: 80,
          correctLevel: window.QRCode.CorrectLevel.L,
        });
      } else if (window.qrcode) {
        // qrcode-generator fallback
        const qr = window.qrcode(0, 'L');
        qr.addData(qrText);
        qr.make();
        el.innerHTML = qr.createSvgTag(2, 0);
      }
    });
  }, [qrLibReady, data]);

  const handlePrint = () => window.print();

  if (error) {
    return (
      <div style={{ fontFamily: "sans-serif", padding: 40, textAlign: "center", color: "#666" }}>
        <div style={{ fontSize: 48, marginBottom: 16 }}>◫</div>
        <h2>Imposition Studio — Stickers</h2>
        <p>{error}</p>
      </div>
    );
  }

  if (!data) {
    return (
      <div style={{ fontFamily: "sans-serif", padding: 40, textAlign: "center", color: "#666" }}>
        <div style={{ fontSize: 48, marginBottom: 16 }}>◫</div>
        <p>Loading...</p>
      </div>
    );
  }

  const stickerW = 1.5; // inches
  const stickerH = 1.5;
  const cols = 5;

  return (
    <div style={{ fontFamily: "'Helvetica Neue', Helvetica, Arial, sans-serif" }}>
      {/* Screen-only header */}
      <div className="no-print" style={{ background: "#0A0E13", color: "#E8EDF5", padding: "16px 24px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <div style={{ fontSize: 18, fontWeight: 700 }}>◫ Sticker Sheet</div>
          <div style={{ fontSize: 12, color: "#94A0B4" }}>
            Order: {data.orderNumber || "N/A"} • {data.batchName} • {data.sizeLabel} {data.substrate} • {data.pieces.length} pieces
          </div>
        </div>
        <button onClick={handlePrint} style={{
          padding: "8px 20px", borderRadius: 8, border: "none", cursor: "pointer",
          background: "linear-gradient(135deg, #D946EF, #A21CAF)", color: "#fff",
          fontWeight: 600, fontSize: 14,
        }}>🖨 Print Stickers</button>
      </div>

      {/* Printable sticker grid */}
      <div style={{ padding: "20px", maxWidth: `${cols * stickerW + 1}in`, margin: "0 auto" }}>
        <div style={{
          display: "grid",
          gridTemplateColumns: `repeat(${cols}, ${stickerW}in)`,
          gap: "4px",
          justifyContent: "center",
        }}>
          {data.pieces.map((piece, i) => (
            <div key={i} style={{
              width: `${stickerW}in`,
              height: `${stickerH}in`,
              border: "0.5px solid #ccc",
              borderRadius: 4,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              padding: 4,
              pageBreakInside: "avoid",
              boxSizing: "border-box",
            }}>
              <div id={`qr-${i}`} style={{ width: 80, height: 80 }} />
              <div style={{ fontSize: 7, color: "#333", textAlign: "center", marginTop: 3, lineHeight: 1.2, maxWidth: "100%", overflow: "hidden" }}>
                <strong>{data.orderNumber || "N/A"}</strong>
                <br />
                #{i + 1} • {data.sizeLabel} • {data.substrate}
                <br />
                <span style={{ color: "#888" }}>{piece.fileName.substring(0, 20)}</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      <style>{`
        @media print {
          .no-print { display: none !important; }
          @page { margin: 0.25in; size: letter; }
          body { margin: 0; }
        }
      `}</style>
    </div>
  );
}
