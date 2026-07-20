# -*- mode: python ; coding: utf-8 -*-
# build.spec — PyInstaller 빌드 설정 (세션 F)
#
# 실행: pyinstaller build.spec
# 결과물: dist/과학데이터스튜디오_수집기(.exe)  (하나의 실행 파일)
#
# 주의:
#   - Python 3.11에서 빌드한다 (CLAUDE.md: pasco 라이브러리 요구사항).
#   - collector/firebase-config.json(apiKey·projectId — 비밀값 아님)은 실행 파일에
#     포함하지 않는다. 실행 파일과 같은 폴더에 따로 두고 실행해야 한다.
#   - templates/ 폴더(로컬 웹 화면)는 실행 파일 안에 함께 담는다.
#   - firebase-admin(관리자 권한)은 더 이상 쓰지 않는다 — 익명 인증 + Firestore
#     REST API(requests)로 바꿔서 빌드 결과물도 훨씬 작아졌다.

import os

here = os.path.dirname(os.path.abspath(SPEC))

a = Analysis(
    ["main.py"],
    pathex=[here],
    binaries=[],
    datas=[
        (os.path.join(here, "templates"), "templates"),
    ],
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
