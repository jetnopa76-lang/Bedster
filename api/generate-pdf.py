"""
Vercel Python serverless function: /api/generate-pdf
POST: accepts JSON with image data + placement coords, returns production PDF
GET: returns a test PDF to verify the function works
"""
from http.server import BaseHTTPRequestHandler
import json
import base64
from io import BytesIO

from reportlab.lib.units import inch
from reportlab.pdfgen import canvas
from reportlab.lib.utils import ImageReader
from pypdf import PdfReader, PdfWriter
from pypdf.generic import (
    ArrayObject, DictionaryObject, NameObject, TextStringObject,
    NumberObject, BooleanObject, FloatObject, DecodedStreamObject,
)
from PIL import Image


def place_image_cover_fit(c, img_bytes, x, y, fw, fh):
    try:
        pil_img = Image.open(BytesIO(img_bytes))
        if pil_img.mode == "RGBA":
            bg = Image.new("RGB", pil_img.size, (255, 255, 255))
            bg.paste(pil_img, mask=pil_img.split()[3])
            pil_img = bg
        elif pil_img.mode != "RGB":
            pil_img = pil_img.convert("RGB")

        iw, ih = pil_img.size
        fr = fw / fh
        ir = iw / ih
        if ir > fr:
            dh, dw = fh, fh * ir
            dx, dy = x - (dw - fw) / 2, y
        else:
            dw, dh = fw, fw / ir
            dx, dy = x, y - (dh - fh) / 2

        c.saveState()
        p = c.beginPath()
        p.rect(x, y, fw, fh)
        c.clipPath(p, stroke=0)
        c.drawImage(ImageReader(pil_img), dx, dy, dw, dh)
        c.restoreState()
    except Exception:
        c.setFillColorRGB(0.85, 0.85, 0.85)
        c.rect(x, y, fw, fh, stroke=0, fill=1)


def generate_pdf(tray_w_in, tray_h_in, placements_data):
    tw = tray_w_in * inch
    th = tray_h_in * inch
    filled = [p for p in placements_data if p.get("imageBase64")]

    # Step 1: Render image layer with ReportLab
    buf = BytesIO()
    c = canvas.Canvas(buf, pagesize=(tw, th))
    for p in filled:
        x = p["x"] * inch
        y = th - p["y"] * inch - p["h"] * inch
        w = p["w"] * inch
        h = p["h"] * inch
        img_data = p["imageBase64"]
        if "," in img_data:
            img_data = img_data.split(",")[1]
        place_image_cover_fit(c, base64.b64decode(img_data), x, y, w, h)
    c.showPage()
    c.save()

    # Step 2: Add OCG layers with pypdf
    buf.seek(0)
    reader = PdfReader(buf)
    writer = PdfWriter()
    writer.add_page(reader.pages[0])
    page = writer.pages[0]

    # OCG objects
    ocg_img = DictionaryObject({
        NameObject("/Type"): NameObject("/OCG"),
        NameObject("/Name"): TextStringObject("image"),
    })
    ocg_wi = DictionaryObject({
        NameObject("/Type"): NameObject("/OCG"),
        NameObject("/Name"): TextStringObject("White_Ink"),
    })
    ocg_img_ref = writer._add_object(ocg_img)
    ocg_wi_ref = writer._add_object(ocg_wi)

    # Overprint ExtGState
    gs_op = DictionaryObject({
        NameObject("/Type"): NameObject("/ExtGState"),
        NameObject("/OP"): BooleanObject(True),
        NameObject("/op"): BooleanObject(True),
        NameObject("/OPM"): NumberObject(1),
    })
    gs_ref = writer._add_object(gs_op)

    # Separation colorspace for White_Ink spot
    tint = DictionaryObject({
        NameObject("/FunctionType"): NumberObject(2),
        NameObject("/Domain"): ArrayObject([FloatObject(0), FloatObject(1)]),
        NameObject("/C0"): ArrayObject([FloatObject(0)] * 4),
        NameObject("/C1"): ArrayObject([
            FloatObject(0.15), FloatObject(1),
            FloatObject(1), FloatObject(0),
        ]),
        NameObject("/N"): NumberObject(1),
    })
    tint_ref = writer._add_object(tint)
    sep = ArrayObject([
        NameObject("/Separation"),
        NameObject("/White_Ink"),
        NameObject("/DeviceCMYK"),
        tint_ref,
    ])
    sep_ref = writer._add_object(sep)

    # Wrap original content in image layer BDC
    img_content = page["/Contents"].get_object().get_data()

    # Build White_Ink layer content
    wi = b"/GS_OP gs\n/CS_WI cs\n1 scn\n"
    for p in filled:
        x = p["x"] * 72
        y = th - p["y"] * 72 - p["h"] * 72
        w = p["w"] * 72
        h = p["h"] * 72
        wi += f"{x:.2f} {y:.2f} {w:.2f} {h:.2f} re f\n".encode()

    # Merge into single content stream with BDC/EMC
    merged = b"/OC /MC0 BDC\n" + img_content + b"\nEMC\n"
    merged += b"/OC /MC1 BDC\n" + wi + b"EMC\n"

    stream = DecodedStreamObject()
    stream.set_data(merged)
    cref = writer._add_object(stream)
    page[NameObject("/Contents")] = cref

    # Update page resources
    res = page["/Resources"].get_object()
    if not isinstance(res, DictionaryObject):
        res = DictionaryObject(res)
        page[NameObject("/Resources")] = res

    res[NameObject("/Properties")] = DictionaryObject({
        NameObject("/MC0"): ocg_img_ref,
        NameObject("/MC1"): ocg_wi_ref,
    })

    if "/ExtGState" in res:
        gsd = DictionaryObject(res["/ExtGState"].get_object())
    else:
        gsd = DictionaryObject()
    gsd[NameObject("/GS_OP")] = gs_ref
    res[NameObject("/ExtGState")] = gsd

    res[NameObject("/ColorSpace")] = DictionaryObject({
        NameObject("/CS_WI"): sep_ref,
    })

    # Catalog OCProperties
    writer._root_object[NameObject("/OCProperties")] = DictionaryObject({
        NameObject("/OCGs"): ArrayObject([ocg_img_ref, ocg_wi_ref]),
        NameObject("/D"): DictionaryObject({
            NameObject("/ON"): ArrayObject([ocg_img_ref, ocg_wi_ref]),
            NameObject("/OFF"): ArrayObject(),
            NameObject("/Order"): ArrayObject([ocg_img_ref, ocg_wi_ref]),
            NameObject("/Name"): TextStringObject("Layers"),
            NameObject("/BaseState"): NameObject("/ON"),
        }),
    })

    out = BytesIO()
    writer.write(out)
    return out.getvalue()


def generate_test_pdf():
    """Generate a small test PDF to verify the function works."""
    placements = [
        {"x": 1, "y": 1, "w": 3, "h": 3, "imageBase64": None},
        {"x": 5, "y": 1, "w": 3, "h": 3, "imageBase64": None},
    ]

    tw = 24 * inch
    th = 14.5 * inch

    buf = BytesIO()
    c = canvas.Canvas(buf, pagesize=(tw, th))
    for p in placements:
        x = p["x"] * inch
        y = th - p["y"] * inch - p["h"] * inch
        w = p["w"] * inch
        h = p["h"] * inch
        c.setFillColorRGB(0.85, 0.85, 0.85)
        c.rect(x, y, w, h, stroke=0, fill=1)
    c.showPage()
    c.save()

    buf.seek(0)
    reader = PdfReader(buf)
    writer = PdfWriter()
    writer.add_page(reader.pages[0])
    page = writer.pages[0]

    ocg_img = DictionaryObject({NameObject("/Type"): NameObject("/OCG"), NameObject("/Name"): TextStringObject("image")})
    ocg_wi = DictionaryObject({NameObject("/Type"): NameObject("/OCG"), NameObject("/Name"): TextStringObject("White_Ink")})
    ocg_img_ref = writer._add_object(ocg_img)
    ocg_wi_ref = writer._add_object(ocg_wi)

    gs_op = DictionaryObject({NameObject("/Type"): NameObject("/ExtGState"), NameObject("/OP"): BooleanObject(True), NameObject("/op"): BooleanObject(True), NameObject("/OPM"): NumberObject(1)})
    gs_ref = writer._add_object(gs_op)

    tint = DictionaryObject({NameObject("/FunctionType"): NumberObject(2), NameObject("/Domain"): ArrayObject([FloatObject(0), FloatObject(1)]), NameObject("/C0"): ArrayObject([FloatObject(0)]*4), NameObject("/C1"): ArrayObject([FloatObject(0.15), FloatObject(1), FloatObject(1), FloatObject(0)]), NameObject("/N"): NumberObject(1)})
    tint_ref = writer._add_object(tint)
    sep = ArrayObject([NameObject("/Separation"), NameObject("/White_Ink"), NameObject("/DeviceCMYK"), tint_ref])
    sep_ref = writer._add_object(sep)

    img_content = page["/Contents"].get_object().get_data()
    wi = b"/GS_OP gs\n/CS_WI cs\n1 scn\n"
    for p in placements:
        x, y, w, h = p["x"]*72, th - p["y"]*72 - p["h"]*72, p["w"]*72, p["h"]*72
        wi += f"{x:.2f} {y:.2f} {w:.2f} {h:.2f} re f\n".encode()

    merged = b"/OC /MC0 BDC\n" + img_content + b"\nEMC\n" + b"/OC /MC1 BDC\n" + wi + b"EMC\n"
    stream = DecodedStreamObject()
    stream.set_data(merged)
    cref = writer._add_object(stream)
    page[NameObject("/Contents")] = cref

    res = page["/Resources"].get_object()
    if not isinstance(res, DictionaryObject):
        res = DictionaryObject(res)
        page[NameObject("/Resources")] = res
    res[NameObject("/Properties")] = DictionaryObject({NameObject("/MC0"): ocg_img_ref, NameObject("/MC1"): ocg_wi_ref})
    gsd = res.get("/ExtGState", DictionaryObject())
    if not isinstance(gsd, DictionaryObject): gsd = DictionaryObject(gsd.get_object())
    gsd[NameObject("/GS_OP")] = gs_ref
    res[NameObject("/ExtGState")] = gsd
    res[NameObject("/ColorSpace")] = DictionaryObject({NameObject("/CS_WI"): sep_ref})

    writer._root_object[NameObject("/OCProperties")] = DictionaryObject({
        NameObject("/OCGs"): ArrayObject([ocg_img_ref, ocg_wi_ref]),
        NameObject("/D"): DictionaryObject({
            NameObject("/ON"): ArrayObject([ocg_img_ref, ocg_wi_ref]),
            NameObject("/OFF"): ArrayObject(),
            NameObject("/Order"): ArrayObject([ocg_img_ref, ocg_wi_ref]),
            NameObject("/Name"): TextStringObject("Layers"),
            NameObject("/BaseState"): NameObject("/ON"),
        }),
    })

    out = BytesIO()
    writer.write(out)
    return out.getvalue()


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        """GET returns a test PDF to verify layers work."""
        try:
            pdf_bytes = generate_test_pdf()
            self.send_response(200)
            self.send_header("Content-Type", "application/pdf")
            self.send_header("Content-Disposition", 'attachment; filename="test_layers.pdf"')
            self.send_header("Content-Length", str(len(pdf_bytes)))
            self.end_headers()
            self.wfile.write(pdf_bytes)
        except Exception as e:
            self.send_response(500)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": str(e)}).encode())

    def do_POST(self):
        try:
            content_length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(content_length)
            data = json.loads(body)

            pdf_bytes = generate_pdf(data["trayW"], data["trayH"], data["placements"])

            self.send_response(200)
            self.send_header("Content-Type", "application/pdf")
            self.send_header("Content-Disposition",
                f'attachment; filename="{data.get("filename", "imposition.pdf")}"')
            self.send_header("Content-Length", str(len(pdf_bytes)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(pdf_bytes)
        except Exception as e:
            self.send_response(500)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps({"error": str(e)}).encode())

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()
