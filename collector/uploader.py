# uploader.py — Firestore 업로드 (세션 F)
#
# docs/SPEC.md §5 데이터 계약을 그대로 따른다. 스키마를 바꾸지 않는다.
# 서비스 계정 키(비밀정보)는 코드에 넣지 않고 collector/serviceAccount.json에서 읽는다.
# 이 파일은 .gitignore(collector/*.json)로 커밋에서 제외되어 있다.
#
# 사용법:
#   python uploader.py --dry-run          # 네트워크 없이 스키마 검증만 (mock 데이터)
#   python uploader.py                    # 실제 업로드 (mock 데이터, 서비스 계정 키 필요)

from __future__ import annotations

import argparse
import json
import os
from dataclasses import dataclass, field
from datetime import datetime, timezone

# firebase_admin은 --dry-run에서는 필요 없으므로, 실제 업로드 시점에만 import한다.
# (서비스 계정 키가 없는 개발 환경에서도 dry-run 검증은 항상 가능해야 한다)

SERVICE_ACCOUNT_PATH = os.path.join(os.path.dirname(__file__), "serviceAccount.json")

MAX_POINTS = 5000  # §5.2, §5.4 — 이 이상은 Firestore 보안 규칙이 쓰기를 거부한다
WARN_POINTS = 270  # §5.2 — "정상 범위"의 대략적 상한(10초 간격 × 45분)
MAX_DOC_BYTES = 1_000_000  # Firestore 문서 1개 제한(1MiB). 여유를 두고 확인한다
VALID_EXP_NO = (1, 2, 3)
VALID_SOURCE = ("sensor", "manual", "mock")


class SchemaError(ValueError):
    """§5 데이터 계약을 어긴 값이 들어왔을 때 발생시킨다."""


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


def validate(ds: Dataset) -> None:
    """§5.2·§5.4를 코드로도 확인한다. Firestore 규칙이 최종 방어선이지만,
    수집기 단계에서 먼저 걸러야 학생이 현장에서 헤매지 않는다."""

    if ds.exp_no not in VALID_EXP_NO:
        raise SchemaError(f"expNo는 1|2|3만 허용합니다: {ds.exp_no}")
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

    size = len(json.dumps(to_firestore_payload(ds, skip_timestamps=True)).encode("utf-8"))
    if size > MAX_DOC_BYTES:
        raise SchemaError(
            f"문서 크기가 약 {size:,}바이트로 1MB 제한을 넘습니다. "
            "points를 줄이거나 측정을 나누세요(§5.2)."
        )


def to_firestore_payload(ds: Dataset, skip_timestamps: bool = False) -> dict:
    """§5.1 필드 이름·형태를 그대로 맞춘 dict를 만든다."""
    payload = {
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
    }
    if skip_timestamps:
        # 문서 크기 추정용 — 실제 업로드 시의 Timestamp 필드는 대략 값으로 대체한다
        payload["startedAt"] = ds.started_at.isoformat()
        payload["createdAt"] = "server-timestamp"
    else:
        payload["startedAt"] = ds.started_at
    return payload


def upload_dataset(ds: Dataset) -> str:
    """실제 Firestore에 업로드한다. 반환값은 생성된 datasetId."""
    validate(ds)

    import firebase_admin
    from firebase_admin import credentials, firestore

    if not firebase_admin._apps:
        if not os.path.exists(SERVICE_ACCOUNT_PATH):
            raise FileNotFoundError(
                f"서비스 계정 키가 없습니다: {SERVICE_ACCOUNT_PATH}\n"
                "Firebase 콘솔 → 프로젝트 설정 → 서비스 계정 → 새 비공개 키 생성으로 받은 "
                "JSON 파일을 collector/serviceAccount.json으로 저장하세요."
            )
        cred = credentials.Certificate(SERVICE_ACCOUNT_PATH)
        firebase_admin.initialize_app(cred)

    db = firestore.client()
    payload = to_firestore_payload(ds)
    payload["createdAt"] = firestore.SERVER_TIMESTAMP

    doc_ref = (
        db.collection("classes")
        .document(ds.class_id)
        .collection("datasets")
        .document()
    )
    doc_ref.set(payload)
    return doc_ref.id


def dry_run(ds: Dataset) -> None:
    """네트워크·자격증명 없이 §5 스키마 검증만 수행한다."""
    validate(ds)
    preview = to_firestore_payload(ds, skip_timestamps=True)
    print("[dry-run] 스키마 검증 통과. 실제로는 아래와 같은 문서가 생성됩니다:")
    print(json.dumps(preview, ensure_ascii=False, indent=2, default=str))


def _mock_dataset() -> Dataset:
    """§5 스키마 준수 확인용 mock 데이터 (CLAUDE.md 지시 — 실제 센서 없이 검증)."""
    now = datetime.now(timezone.utc)
    return Dataset(
        class_id="demo-class",
        group_id="group-4",
        owner_uid="anon-uid-test",
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
    else:
        dataset_id = upload_dataset(ds)
        print(f"업로드 완료: classes/{ds.class_id}/datasets/{dataset_id}")


if __name__ == "__main__":
    main()
