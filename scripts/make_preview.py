"""从本地出图里挑两张做 README 预览图：压到 800px 宽以内、单张 <130KB。"""
import os

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, "docs")

# (源文件, 输出名, 目标宽度, JPEG 质量)
JOBS = [
    (r"D:\work_space_ds\gemini-images\gemini-20261108-102519-01.webp", "preview-cat-astronaut.jpg", 620, 82),
    (r"D:\work_space_ds\gemini-images\gemini-20261108-103337-01.webp", "preview-ink-mountain.jpg", 800, 88),
]

os.makedirs(OUT_DIR, exist_ok=True)

for src, name, target_width, quality in JOBS:
    image = Image.open(src)
    if image.mode not in ("RGB", "L"):
        image = image.convert("RGB")
    width, height = image.size
    if width > target_width:
        image = image.resize((target_width, round(height * target_width / width)), Image.LANCZOS)
        width, height = image.size
    path = os.path.join(OUT_DIR, name)
    image.convert("RGB").save(path, "JPEG", quality=quality, optimize=True, progressive=True)
    print(f"{name}  {width}x{height}  {os.path.getsize(path) / 1024:.0f} KB")
