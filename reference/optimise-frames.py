import os, sys
from PIL import Image

SRC = r"./assets"          # the original renders, left untouched
DST = r"./public/frames"   # what the page actually loads
WIDTH = 1600          # plenty for a cover-fit canvas on a 1440p viewport
QUALITY = 72

os.makedirs(DST, exist_ok=True)

names = sorted(n for n in os.listdir(SRC) if n.lower().endswith(".jpg"))
src_total = dst_total = 0

for i, name in enumerate(names, 1):
    sp = os.path.join(SRC, name)
    dp = os.path.join(DST, name)
    src_total += os.path.getsize(sp)
    with Image.open(sp) as im:
        im = im.convert("RGB")
        w, h = im.size
        if w > WIDTH:
            im = im.resize((WIDTH, round(h * WIDTH / w)), Image.LANCZOS)
        im.save(dp, "JPEG", quality=QUALITY, optimize=True, progressive=True)
    dst_total += os.path.getsize(dp)
    if i % 30 == 0:
        print(f"  {i}/{len(names)}", flush=True)

with Image.open(os.path.join(DST, names[0])) as im:
    dims = im.size

print(f"frames      : {len(names)}")
print(f"dimensions  : 1920x1080 -> {dims[0]}x{dims[1]}")
print(f"total size  : {src_total/1048576:.1f} MB -> {dst_total/1048576:.1f} MB")
print(f"per frame   : {src_total/len(names)/1024:.0f} KB -> {dst_total/len(names)/1024:.0f} KB")
print(f"decoded RAM : {90*1920*1080*4/1048576:.0f} MB -> {90*dims[0]*dims[1]*4/1048576:.0f} MB")
