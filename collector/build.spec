# -*- mode: python ; coding: utf-8 -*-
# build.spec — PyInstaller 빌드 설정 (세션 F)
#
# 실행: pyinstaller build.spec
# 결과물: dist/과학데이터스튜디오_수집기(.exe)  (하나의 실행 파일)
#
# 주의:
#   - Python 3.11에서 빌드한다 (CLAUDE.md: pasco 라이브러리 요구사항).
#   - 빌드 전에 collector/firebase-config.json을 만들어 둬야 한다
#     (firebase-config.example.json 참고). 있으면 이 파일이 실행 파일 안에
#     통째로 묶여서, 학생에게 실행 파일 하나만 주면 된다. 서비스 계정 키가
#     아니라 apiKey·projectId뿐이라(비밀값 아님, 익명 인증+보안 규칙 안에서만
#     동작) 실행 파일에 넣어도 안전하다 — 세션 G 확인.
#     실행 파일 옆에 firebase-config.json을 따로 두면 그쪽이 항상 우선한다
#     (uploader.py의 _config_candidates() 순서) — 다시 빌드하지 않고도
#     교사가 키를 바꿀 여지를 남겨 둔 것이다.
#   - templates/ · static/ 폴더(로컬 웹 화면)는 실행 파일 안에 함께 담는다.
#   - firebase-admin(관리자 권한)은 더 이상 쓰지 않는다 — 익명 인증 + Firestore
#     REST API(requests)로 바꿔서 빌드 결과물도 훨씬 작아졌다.

import os

here = os.path.dirname(os.path.abspath(SPEC))

_datas = [
    (os.path.join(here, "templates"), "templates"),
    (os.path.join(here, "static"), "static"),
]
_config_path = os.path.join(here, "firebase-config.json")
if os.path.exists(_config_path):
    _datas.append((_config_path, "."))  # 번들 루트(sys._MEIPASS)에 그대로 둔다
else:
    print(
        "[build.spec] 경고: firebase-config.json이 없어 실행 파일 안에 못 담습니다. "
        "firebase-config.example.json을 복사해 만든 뒤 다시 빌드하면 파일 하나로 배포할 수 있습니다."
    )

a = Analysis(
    ["main.py"],
    pathex=[here],
    binaries=[],
    datas=_datas,
    hiddenimports=[
        # pasco·requests는 동적 import(지연 import)로 쓰는 곳이 있어
        # PyInstaller가 자동으로 못 찾을 수 있으므로 명시한다.
        "pasco",
        "pasco.pasco_ble_device",
        "requests",
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name="과학데이터스튜디오_수집기",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,  # 오류 메시지를 학생이 볼 수 있게 콘솔 창을 남긴다
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
