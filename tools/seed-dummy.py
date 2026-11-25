#!/usr/bin/env python3
"""リハーサル用。手書き風のダミーテーマを8枚ボードに入れる。サーバ起動中に実行する。"""
import base64, io, json, random, urllib.request
from PIL import Image, ImageDraw, ImageFont

BASE = "http://localhost:5173"
FONT = "/System/Library/Fonts/ヒラギノ角ゴシック W6.ttc"

THEMES = [
    ("製造ラインの異常検知にLLMは効くのか", "すずき", "s1", "r1"),
    ("社内RAGが育たない問題", "やまだ", "s1", "r2"),
    ("評価をどう自動化するか", "さとう", "s1", "r3"),
    ("Bedrock vs 自前GPU 結局いくら", "いとう", "s2", "r1"),
    ("非エンジニアにAIを配る順番", "なかむら", "s2", "r4"),
    ("エージェントの権限設計", "こばやし", "s3", "r2"),
    ("生成AIの社内浸透、何から？", "", None, None),
    ("設計書からコードは書けるか", "たなか", None, None),
]


def sketch(text: str) -> str:
    W, H = 1200, 900
    img = Image.new("RGB", (W, H), (250, 249, 244))
    d = ImageDraw.Draw(img)
    d.rectangle([18, 18, W - 18, H - 18], outline=(205, 200, 188), width=6)
    for y in range(160, H - 80, 120):
        d.line([70, y, W - 70, y], fill=(226, 224, 214), width=3)
    f = ImageFont.truetype(FONT, 78)
    line, lines = "", []
    for ch in text:
        if d.textlength(line + ch, font=f) > W - 180:
            lines.append(line)
            line = ch
        else:
            line += ch
    lines.append(line)
    y = 200
    for ln in lines:
        d.text((90 + random.randint(-6, 6), y), ln, font=f, fill=(32, 36, 52))
        y += 120
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=85)
    return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()


def send(path: str, obj: dict, method: str) -> dict:
    req = urllib.request.Request(
        BASE + path, method=method, data=json.dumps(obj).encode(),
        headers={"content-type": "application/json"},
    )
    return json.load(urllib.request.urlopen(req))


def main() -> None:
    board = json.load(urllib.request.urlopen(BASE + "/api/board"))
    for i, (title, host, slot, room) in enumerate(THEMES):
        photo = send("/api/photo", {"dataUrl": sketch(title)}, "POST")["photo"]
        board["cards"].append({
            "id": f"dummy{i}", "photo": photo, "title": title,
            "host": host, "slot": slot, "room": room,
        })
    board = send("/api/board", board, "PUT")
    print(f"入れました: {len(board['cards'])} 枚 / rev {board['rev']}")


if __name__ == "__main__":
    main()
