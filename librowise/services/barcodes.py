"""Pure-Python Code 128 encoder (subsets B and C, chosen automatically) rendering to SVG.

Subset C packs digit pairs into one symbol, so runs of digits (common in library barcodes such
as ``SW00001234`` or 14-digit patron cards) are switched to C when that makes the symbol
shorter. Output is a crisp, scalable SVG suitable for laser-printed labels and cards.
"""

from __future__ import annotations

from html import escape

# Bar/space module widths for symbol values 0..106 (106 = stop, 7 elements / 13 modules).
PATTERNS: tuple[str, ...] = (
    "212222", "222122", "222221", "121223", "121322", "131222", "122213", "122312", "132212", "221213",
    "221312", "231212", "112232", "122132", "122231", "113222", "123122", "123221", "223211", "221132",
    "221231", "213212", "223112", "312131", "311222", "321122", "321221", "312212", "322112", "322211",
    "212123", "212321", "232121", "111323", "131123", "131321", "112313", "132113", "132311", "211313",
    "231113", "231311", "112133", "112331", "132131", "113123", "113321", "133121", "313121", "211331",
    "231131", "213113", "213311", "213131", "311123", "311321", "331121", "312113", "312311", "332111",
    "314111", "221411", "431111", "111224", "111422", "121124", "121421", "141122", "141221", "112214",
    "112412", "122114", "122411", "142112", "142211", "241211", "221114", "413111", "241112", "134111",
    "111242", "121142", "121241", "114212", "124112", "124211", "411212", "421112", "421211", "212141",
    "214121", "412121", "111143", "111341", "131141", "114113", "114311", "411113", "411311", "113141",
    "114131", "311141", "411131", "211412", "211214", "211232", "2331112",
)
START_B, START_C, CODE_B, CODE_C, STOP = 104, 105, 100, 99, 106
QUIET_ZONE = 10  # modules each side (ISO/IEC 15417 minimum)


def _digit_run(data: str, i: int) -> int:
    n = 0
    while i + n < len(data) and data[i + n].isdigit():
        n += 1
    return n


def encode(data: str) -> list[int]:
    """Symbol values for ``data`` including start, check symbol and stop.

    Raises ``ValueError`` for characters outside printable ASCII (subset B covers 32-127).
    """
    if not data:
        raise ValueError("Cannot encode an empty barcode")
    for ch in data:
        if not 32 <= ord(ch) <= 127:
            raise ValueError(f"Character {ch!r} cannot be encoded in Code 128 subsets B/C")
    values: list[int] = []
    i, n = 0, len(data)
    lead = _digit_run(data, 0)
    if lead >= 4 or (lead == n and n % 2 == 0):
        subset = "C"
        values.append(START_C)
    else:
        subset = "B"
        values.append(START_B)
    while i < n:
        if subset == "C":
            if _digit_run(data, i) >= 2:
                values.append(int(data[i:i + 2]))
                i += 2
                continue
            values.append(CODE_B)
            subset = "B"
        run = _digit_run(data, i)
        # Switch to C for a run of >= 4 digits that ends the data, or >= 6 digits mid-data;
        # an odd run encodes its first digit in B so the remainder pairs up.
        if run >= 4 and (i + run == n or run >= 6):
            if run % 2:
                values.append(ord(data[i]) - 32)
                i += 1
            values.append(CODE_C)
            subset = "C"
            continue
        values.append(ord(data[i]) - 32)
        i += 1
    values.append(checksum(values))
    values.append(STOP)
    return values


def checksum(values: list[int]) -> int:
    """Modulo-103 check symbol over the start symbol and data symbols."""
    return (values[0] + sum(pos * v for pos, v in enumerate(values[1:], start=1))) % 103


def modules(data: str) -> str:
    """The barcode as a string of '1' (bar) and '0' (space) modules, without quiet zones."""
    out = []
    for v in encode(data):
        for k, w in enumerate(PATTERNS[v]):
            out.append(("1" if k % 2 == 0 else "0") * int(w))
    return "".join(out)


def svg(data: str, *, height: float = 40.0, module: float = 1.0, text: bool = True, font_size: float = 10.0,
        label: str | None = None) -> str:
    """Render ``data`` as an SVG barcode. Units are abstract; size the element with CSS."""
    bits = modules(data)
    quiet = QUIET_ZONE * module
    width = len(bits) * module + 2 * quiet
    text_h = font_size * 1.25 if text else 0
    rects = []
    x = 0
    while x < len(bits):
        if bits[x] == "1":
            start = x
            while x < len(bits) and bits[x] == "1":
                x += 1
            rects.append(f"M{quiet + start * module:g} 0h{(x - start) * module:g}v{height:g}h-{(x - start) * module:g}z")
        else:
            x += 1
    shown = escape(label if label is not None else data)
    caption = (f'<text x="{width / 2:g}" y="{height + text_h - font_size * 0.2:g}" font-size="{font_size:g}" '
               f'text-anchor="middle" font-family="ui-monospace, Consolas, monospace" fill="#000">{shown}</text>'
               if text else "")
    return (f'<svg xmlns="http://www.w3.org/2000/svg" class="barcode" viewBox="0 0 {width:g} {height + text_h:g}" '
            f'preserveAspectRatio="none" role="img" aria-label="Barcode {escape(data)}">'
            f'<rect width="100%" height="100%" fill="#fff"/>'
            f'<path fill="#000" shape-rendering="crispEdges" d="{"".join(rects)}"/>{caption}</svg>')
