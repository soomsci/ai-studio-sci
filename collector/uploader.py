# uploader.py — Firestore 업로드 (세션 F)
#
# docs/SPEC.md §5 데이터 계약을 그대로 따른다. 스키마를 바꾸지 않는다.
#
# 관리자 권한(firebase-admin + 서비스 계정 키)은 쓰지 않는다. 그 키는 보안 규칙을
# 전부 우회하는 권한이라, 모둠 노트북마다 이 파일이 깔리면 학생 누구나 전 학급
# 데이터를 지울 수 있는 위험이 있었다. 대신 학생이 웹앱에서 쓰는 것과 똑같은
# 방식 — Firebase 익명 인증 + Firestore 보안 규칙 — 을 그대로 통과한다.
#
# collector/firebase-config.json에 apiKey·projectId를 둔다. 이 키는 비밀값이
# 아니다(웹앱 소스에도 그대로 들어간다). .gitignore(collector/*.json)로
# 실제 파일은 커밋에서 제외되고, 본보기는 firebase-config.example.json에 둔다.
#
# 사용법:
#   python uploader.py --dry-run          # 네트워크 없이 스키마 검증만 (mock 데이터)
#   python uploader.py                    # 실제 업로드 (mock 데이터, firebase-config.json 필요)

from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone
from urllib.parse import quote

# PyInstaller onefile로 빌드하면 __file__은 실행할 때마다 임시로 풀리는 폴더를
# 가리켜서, 그 기준으로 찾으면 실행 파일 옆에 둔 firebase-config.json을 못 찾는다.
# frozen 상태면 실행 파일(sys.executable) 위치를 기준으로 삼는다.
if getattr(sys, "frozen", False):
    _BASE_DIR = os.path.dirname(sys.executable)
else:
    _BASE_DIR = os.path.dirname(os.path.abspath(__file__))

CONFIG_PATH = os.path.join(_BASE_DIR, "firebase-config.json")

MAX_POINTS = 5000  # §5.2, §5.4 — 이 이상은 Firestore 보안 규칙이 쓰기를 거부한다
WARN_POINTS = 270  # §5.2 — "정상 범위"의 대략적 상한(10초 간격 × 45분)
MAX_DOC_BYTES = 1_000_000  # Firestore 문서 1개 제한(1MiB). 여유를 두고 확인한다
VALID_EXP_NO = (1, 2, 3, 4)  # §5.1 v2.0 — 4 = 비열(실험 4)
VALID_SOURCE = ("sensor", "manual", "mock")

IDENTITY_TOOLKIT_URL = "https://identitytoolkit.googleapis.com/v1/accounts:signUp"


class SchemaError(ValueError):
    """§5 데이터 계약을 어긴 값이 들어왔을 때 발생시킨다."""


class UploadError(RuntimeError):
    """설정·로그인·네트워크·서버 거부 등 업로드 자체가 실패했을 때 발생시킨다.
    메시지는 학생이 다음에 뭘 해야 할지 알 수 있도록 한국어로 쓴다."""


@dataclass
class Dataset:
    """§5.1 classes/{classId}/datasets/{datasetId} 문서 1개에 대응한다."""

    class_id: str
    group_id: str
    owner_uid: str
    exp_no: int
    title: str
    condition: str
    sensor: str
    unit: str
    started_at: datetime
    interval_sec: float
    points: list[dict]  # [{ "t": number, "v": number }]
    events: list[dict] = field(default_factory=list)  # [{ "t": number, "label": string }]
    source: str = "sensor"  # "sensor" | "manual" | "mock"
    status: str = "submitted"  # "draft" | "submitted"


def load_config() -> dict:
    """collector/firebase-config.json을 읽는다. 비밀값이 아니므로 서비스 계정 키와
    달리 그냥 파일로 두고 읽는다."""
    if not os.path.exists(CONFIG_PATH):
        raise UploadError(
            f"설정 파일이 없습니다: {CONFIG_PATH}\n"
            "collector/firebase-config.example.json을 복사해 firebase-config.json으로 "
            "저장하고, apiKey·projectId를 채우세요."
        )
    with open(CONFIG_PATH, encoding="utf-8") as f:
        config = json.load(f)
    for key in ("apiKey", "projectId"):
        if not config.get(key):
            raise UploadError(f"firebase-config.json에 {key} 값이 비어 있습니다")
    return config


def validate(ds: Dataset) -> None:
    """§5.2·§5.4를 코드로도 확인한다. Firestore 보안 규칙이 최종 방어선이지만,
    수집기 단계에서 먼저 걸러야 학생이 현장에서 헤매지 않는다."""

    if ds.exp_no not in VALID_EXP_NO:
        raise SchemaError(f"expNo는 {'|'.join(map(str, VALID_EXP_NO))}만 허용합니다: {ds.exp_no}")
    if ds.source not in VALID_SOURCE:
        raise SchemaError(f"source는 sensor|manual|mock만 허용합니다: {ds.source}")
    for name in ("class_id", "group_id", "owner_uid", "title", "condition", "sensor", "unit"):
        if not getattr(ds, name):
            raise SchemaError(f"{name}은(는) 비어 있을 수 없습니다")

    if len(ds.points) > MAX_POINTS:
        raise SchemaError(
            f"points가 {len(ds.points)}개입니다. {MAX_POINTS}개를 넘으면 "
            "Firestore 보안 규칙이 쓰기를 거부합니다(§5.4)."
        )
    if len(ds.points) > WARN_POINTS:
        print(
            f"[경고] points가 {len(ds.points)}개로 정상 범위(약 {WARN_POINTS}개)를 "
            "넘었습니다. 측정 간격을 늘리는 것을 고려하세요(§5.2)."
        )
    for p in ds.points:
        if "t" not in p or "v" not in p:
            raise SchemaError(f"points 원소는 t·v 필드가 모두 있어야 합니다: {p}")
    for e in ds.events:
        if "t" not in e or "label" not in e:
            raise SchemaError(f"events 원소는 t·label 필드가 모두 있어야 합니다: {e}")

    # §5.2 — t는 측정 시작으로부터 경과 초(절대 시각 아님). 음수·역행 여부만 가볍게 확인한다.
    if any(p["t"] < 0 for p in ds.points):
        raise SchemaError("points의 t(경과 초)에 음수가 있습니다")

    size = len(json.dumps(_dataset_payload(ds, datetime.now(timezone.utc)), default=str).encode("utf-8"))
    if size > MAX_DOC_BYTES:
        raise SchemaError(
            f"문서 크기가 약 {size:,}바이트로 1MB 제한을 넘습니다. "
            "points를 줄이거나 측정을 나누세요(§5.2)."
        )


def _dataset_payload(ds: Dataset, created_at: datetime) -> dict:
    """§5.1 필드 이름·형태를 그대로 맞춘 dict를 만든다(REST 변환 전 단계)."""
    return {
        "expNo": ds.exp_no,
        "groupId": ds.group_id,
        "ownerUid": ds.owner_uid,
        "title": ds.title,
        "condition": ds.condition,
        "sensor": ds.sensor,
        "unit": ds.unit,
        "intervalSec": ds.interval_sec,
        "points": ds.points,
        "events": ds.events,
        "source": ds.source,
        "status": ds.status,
        "startedAt": ds.started_at,
        "createdAt": created_at,
    }


def _to_value(v):
    """파이썬 값을 Firestore REST의 타입 명시 형식으로 바꾼다."""
    if isinstance(v, bool):
        return {"booleanValue": v}
    if isinstance(v, int):
        return {"integerValue": str(v)}
    if isinstance(v, float):
        return {"doubleValue": v}
    if isinstance(v, str):
        return {"stringValue": v}
    if isinstance(v, datetime):
        ts = v.astimezone(timezone.utc).isoformat()
        if ts.endswith("+00:00"):
            ts = ts[:-6] + "Z"
        return {"timestampValue": ts}
    if isinstance(v, dict):
        return {"mapValue": {"fields": {k: _to_value(vv) for k, vv in v.items()}}}
    if isinstance(v, (list, tuple)):
        return {"arrayValue": {"values": [_to_value(vv) for vv in v]}}
    if v is None:
        return {"nullValue": None}
    raise TypeError(f"Firestore REST 변환을 지원하지 않는 타입입니다: {type(v)}")


def _requests_module():
    try:
        import requests
    except ModuleNotFoundError as exc:
        raise UploadError(
            "requests 패키지가 설치되지 않았습니다. pip install -r requirements.txt를 실행하세요."
        ) from exc
    return requests


def _error_message(res) -> str:
    try:
        return res.json().get("error", {}).get("message", "")
    except ValueError:
        return res.text


def sign_in_anonymously(api_key: str) -> tuple[str, str]:
    """Firebase 익명 인증. 반환값은 (idToken, localId) — localId를 ownerUid로 쓴다."""
    requests = _requests_module()
    try:
        res = requests.post(
            IDENTITY_TOOLKIT_URL,
            params={"key": api_key},
            json={"returnSecureToken": True},
            timeout=15,
        )
    except requests.RequestException as exc:
        raise UploadError(f"로그인 서버에 연결하지 못했습니다. 인터넷 연결을 확인하세요. ({exc})") from exc

    if res.status_code != 200:
        raise UploadError(
            "익명 로그인에 실패했어요. firebase-config.json의 apiKey가 맞는지 확인하세요. "
            f"(원래 메시지: {_error_message(res)})"
        )
    body = res.json()
    return body["idToken"], body["localId"]


def _friendly_write_error(res) -> str:
    message = _error_message(res)
    if res.status_code in (401, 403):
        return (
            "서버가 업로드를 거부했어요. 학급 아이디·모둠 아이디가 맞는지, "
            "선생님이 이 학급을 이미 만들어 두었는지 확인하고 다시 시도하세요. "
            f"(원래 메시지: {message})"
        )
    return f"서버 오류({res.status_code})로 업로드에 실패했어요. (원래 메시지: {message})"


def upload_dataset(
    ds: Dataset,
    api_key: str,
    project_id: str,
    id_token: str | None = None,
    local_id: str | None = None,
) -> str:
    """실제 Firestore에 업로드한다. 반환값은 생성된 datasetId.

    id_token·local_id를 안 주면 여기서 새로 익명 로그인한다. 채널이 여러 개라
    문서를 여러 번 올릴 때는, 호출하는 쪽(main.py)이 한 번만 로그인해서 같은
    토큰을 여러 채널에 재사용한다(idToken은 1시간 동안 유효하다).
    """
    validate(ds)

    if id_token is None or local_id is None:
        id_token, local_id = sign_in_anonymously(api_key)
    ds.owner_uid = local_id  # 보안 규칙: ownerUid == request.auth.uid (§5.4)

    requests = _requests_module()
    fields = {k: _to_value(v) for k, v in _dataset_payload(ds, datetime.now(timezone.utc)).items()}
    url = (
        f"https://firestore.googleapis.com/v1/projects/{quote(project_id, safe='')}"
        f"/databases/(default)/documents/classes/{quote(ds.class_id, safe='')}/datasets"
    )
    try:
        res = requests.post(
            url,
            headers={"Authorization": f"Bearer {id_token}"},
            json={"fields": fields},
            timeout=15,
        )
    except requests.RequestException as exc:
        raise UploadError(f"서버에 연결하지 못했습니다. 인터넷 연결을 확인하세요. ({exc})") from exc

    if res.status_code != 200:
        raise UploadError(_friendly_write_error(res))

    name = res.json().get("name", "")
    return name.rsplit("/", 1)[-1]


def dry_run(ds: Dataset) -> None:
    """네트워크·설정 파일 없이 §5 스키마 검증만 수행한다."""
    validate(ds)
    preview = _dataset_payload(ds, datetime.now(timezone.utc))
    print("[dry-run] 스키마 검증 통과. 실제로는 아래와 같은 문서가 생성됩니다:")
    print(json.dumps(preview, ensure_ascii=False, indent=2, default=str))


def _mock_dataset() -> Dataset:
    """§5 스키마 준수 확인용 mock 데이터 (CLAUDE.md 지시 — 실제 센서 없이 검증)."""
    now = datetime.now(timezone.utc)
    return Dataset(
        class_id="demo-class",
        group_id="group-4",
        owner_uid="anon-uid-test",  # 실제 업로드 시 upload_dataset()이 로그인 결과로 덮어쓴다
        exp_no=1,
        title="3교시 창문 닫음",
        condition="닫음",
        sensor="CO2",
        unit="ppm",
        started_at=now,
        interval_sec=10,
        points=[{"t": i * 10, "v": 600 + i * 5} for i in range(20)],
        events=[{"t": 50, "label": "창문 열기"}],
        source="mock",
        status="submitted",
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="datasets 문서 업로드 (mock 데이터 테스트용)")
    parser.add_argument(
        "--dry-run", action="store_true", help="Firestore에 쓰지 않고 스키마 검증만 한다"
    )
    args = parser.parse_args()

    ds = _mock_dataset()
    if args.dry_run:
        dry_run(ds)
        return

    config = load_config()
    dataset_id = upload_dataset(ds, config["apiKey"], config["projectId"])
    print(f"업로드 완료: classes/{ds.class_id}/datasets/{dataset_id}")


if __name__ == "__main__":
    main()
