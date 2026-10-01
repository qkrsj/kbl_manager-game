"""
KM27 로딩 화면 표지 이미지 만들기 — 선수 사진 3장을 오려서(배경 제거) 2K 표지처럼 한 장으로 합성

사용법 (게임 폴더에서):
    pip install "rembg[cpu]" pillow numpy scipy
    python apps/web/scripts/make_cover.py 가운데선수.jpg 왼쪽선수.jpg 오른쪽선수.jpg

결과: apps/web/public/splash/player.png  (로딩 화면이 자동으로 사용)
 - 가운데 선수는 앞에 크게, 양옆 선수는 뒤에 약간 작고 어둡게 배치
 - 배경 제거 모델(u2net)은 처음 실행할 때 자동으로 내려받음(약 170MB)
 - 실제 선수 사진은 저작권·초상권이 있으니 개인적으로만 사용 (이 폴더 이미지는 git에 안 올라감)
"""
import sys, os
if len(sys.argv) != 4:
    print(__doc__); sys.exit(1)
BYUN, LEE, HUR = sys.argv[1], sys.argv[2], sys.argv[3]   # 가운데, 왼쪽, 오른쪽
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "public", "splash", "player.png")
from rembg import remove, new_session
from PIL import Image, ImageFilter, ImageEnhance, ImageChops
import numpy as np
sess=new_session("u2net")

def cutout(f):
    im=Image.open(f).convert('RGB')
    big=im.resize((im.width*5, im.height*5), Image.LANCZOS)
    big=big.filter(ImageFilter.UnsharpMask(radius=3, percent=70, threshold=2))
    m=remove(big, session=sess, only_mask=True)
    m=m.point(lambda v: 0 if v<20 else (255 if v>235 else v)).filter(ImageFilter.GaussianBlur(1.2))
    # 가장 큰 덩어리(선수+공)만 남기고, 원본 사진에 찍힌 다른 사람 손 등 떨어진 조각 제거
    from scipy import ndimage
    arr=np.array(m)
    lab,n=ndimage.label(arr>60)
    if n>1:
        sizes=ndimage.sum(np.ones_like(arr), lab, range(1,n+1))
        keep=1+int(np.argmax(sizes))
        arr=np.where(lab==keep, arr, 0).astype(np.uint8)
        m=Image.fromarray(arr)
    rgba=big.convert('RGBA'); rgba.putalpha(m)
    return rgba.crop(rgba.getbbox())

def grade(im, bright=1.0, contrast=1.08, sat=1.1):
    a=im.getchannel('A'); rgb=im.convert('RGB')
    rgb=ImageEnhance.Contrast(rgb).enhance(contrast)
    rgb=ImageEnhance.Color(rgb).enhance(sat)
    rgb=ImageEnhance.Brightness(rgb).enhance(bright)
    out=rgb.convert('RGBA'); out.putalpha(a); return out

def rim(im, color, radius=10, strength=0.85):
    a=im.getchannel('A')
    glow=a.filter(ImageFilter.GaussianBlur(radius)).point(lambda v:int(v*strength))
    layer=Image.new('RGBA', im.size, color+(0,)); layer.putalpha(glow)
    return layer

def scale_h(im, h):
    return im.resize((round(im.width*h/im.height), h), Image.LANCZOS)

byun, lee, hur = cutout(BYUN), cutout(LEE), cutout(HUR)
W,H=2200,1500
canvas=Image.new('RGBA',(W,H),(0,0,0,0))

def place(im, cx, bottom, h, bright, glowc):
    im=grade(scale_h(im,h), bright=bright)
    x=round(cx-im.width/2); y=bottom-im.height
    # 바닥 그림자
    sh=Image.new('L',(im.width, 60),0); sw=Image.new('L',(int(im.width*0.8),40),150)
    sh.paste(sw,(int(im.width*0.1),10)); sh=sh.filter(ImageFilter.GaussianBlur(14))
    shadow=Image.new('RGBA',sh.size,(0,0,0,0)); shadow.putalpha(sh)
    canvas.alpha_composite(shadow,(x, bottom-40))
    pad=40
    g=rim(im.crop((0,0,im.width,im.height)), glowc)
    gp=Image.new('RGBA',(im.width+pad*2, im.height+pad*2),(0,0,0,0)); gp.alpha_composite(g,(pad,pad))
    gp=gp.filter(ImageFilter.GaussianBlur(6))
    canvas.alpha_composite(gp,(x-pad,y-pad))
    canvas.alpha_composite(im,(x,y))
    return (x,y,im.width,im.height)

# 뒤쪽 두 명 (살짝 어둡고 작게) → 앞쪽 가운데 (림라이트: 왼쪽 파랑, 오른쪽·가운데 빨강)
print('lee', place(lee, 620, 1420, 1250, 0.86, (90,170,255)))
print('hur', place(hur, 1600, 1430, 1180, 0.86, (255,90,90)))
print('byun', place(byun, 1100, 1495, 1420, 1.0, (255,60,80)))
bb=canvas.getbbox(); print('bbox', bb)
canvas=canvas.crop((max(0,bb[0]-20), max(0,bb[1]-20), min(W,bb[2]+20), H))
# 하단 페이드: 원본 사진 가장자리에서 잘린 발끝·바닥 조각이 코트 바닥에 자연스럽게 묻히도록
a=np.array(canvas.getchannel('A')).astype(np.float32)
h=a.shape[0]; fade_start=int(h*0.86)
ramp=np.ones(h,dtype=np.float32); ramp[fade_start:]=np.linspace(1,0,h-fade_start)**1.4
canvas.putalpha(Image.fromarray((a*ramp[:,None]).astype(np.uint8)))
canvas.save(OUT, optimize=True)
print('저장:', OUT, canvas.size)
