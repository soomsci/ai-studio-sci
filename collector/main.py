# main.py — 로컬 웹 화면 (세션 F)
#
# 모둠 노트북에서 이 파일(또는 PyInstaller로 묶은 실행 파일)을 실행하면
# 로컬 웹 서버가 뜨고, 브라우저로 http://127.0.0.1:5050 에 접속해 측정한다.
# 학생용 웹앱(public/index.html)과는 별개의 도구다 — 센서 연결·측정·Firestore
# 업로드만 담당한다.
#
# 여러 센서를 동시에 잴 수 있다(§12 세션 F 확장, 예: 물·식용유 온도 동시 비교).
# 센서 1대 = "채널" 1개. 채널은 번호(예: "117-880")로 정확히 지정해 연결한다 —
# sensor.py의 connect()가 스캔 순서(found[0])에 의존하지 않도록 되어 있다.
#
# 실행: python main.py

from __future__ import annotations

import os
import threading
import uuid
import math
from datetime import datetime, timezone

from flask import Flask, jsonify, render_template, request

import sensor
import uploader

app = Flask(__name__)

# 저장 간격 하한(2026-07-27, 실시간 그래프 요청). 0.1초까지 열려 있으면 45분
# 측정에 27,000점이 쌓여 §5.2 5,000점 한도로 업로드가 통째로 거부된다.
# 0.5초여도 45분×0.5초=5,400점이라 아슬아슬하지만, 기본값 10초는 그대로 안전하다.
MIN_INTERVAL_SEC = 0.5

# 4,500점에서 미리 알리고, 5,000점에서 모든 센서에 함께 종료 신호를 보낸다.
NEAR_LIMIT_POINTS = int(uploader.MAX_POINTS * 0.9)


class _Channel:
    """실시간 센서 1대. 센서 종류·번호·이름표·제목을 함께 들고 있어서,
    화면과 업로드 양쪽에서 "이 값이 어느 센서 것인지"를 항상 알 수 있다."""

    def __init__(self, sensor_name: str, device_id: str, label: str, title: str):
        if sensor_name in sensor.STANDARD_BLE_SENSORS:
            self.source = sensor.StandardBleHeartRateSource(sensor_name)
        else:
            self.source = sensor.PascoSensorSource(sensor_name)
        self.sensor_name = sensor_name
        self.device_id = device_id
        self.label = label
        self.title = title

    def to_dict(self) -> dict:
        committed = self.source.latest_points()  # 저장(업로드)될 값 — §5.2 개수 한도 기준
        display = self.source.display_points()  # 화면 실시간 그래프용 — 확정 값 + 지금 구간 원시값
        return {
            "deviceId": self.device_id,
            "label": self.label,
            "title": self.title,
            "sensor": self.sensor_name,
            "unit": self.source.unit,
            "count": len(committed),
            "latestValue": display[-1]["v"] if display else None,
            "points": display,  # 화면의 실시간 그래프가 채널별로 선을 그리는 데 쓴다
            "nearLimit": len(committed) >= NEAR_LIMIT_POINTS,
            "connected": bool(getattr(self.source, "is_connected", lambda: True)()),
            "measuring": bool(getattr(self.source, "is_measuring", lambda: False)()),
            "error": getattr(self.source, "last_error", None),
        }


class _Session:
    def __init__(self) -> None:
        self.reset()

    def reset(self) -> None:
        # 설정을 다시 시작하면 기존 폴링 스레드와 블루투스 연결을 먼저 정리한다.
        for channel in getattr(self, "channels", []):
            channel.source.disconnect()
        self.mode: str | None = None  # "realtime" | "manual"
        self.channels: list[_Channel] = []  # mode == "realtime"
        self.manual_source = None  # mode == "manual" — sensor.ManualInputSource
        self.manual_sensor_name: str | None = None
        self.meta: dict = {}  # 학급·모둠·실험번호·조건·측정 간격 — 채널이 공유한다
        self.started_at: datetime | None = None
        self.status = "idle"  # idle | measuring | stopped | uploaded | error
        self.uploaded = False
        self.upload_datasets = None
        self.upload_results = []
        self.limit_reached = threading.Event()

    def stop_at_limit(self) -> None:
        # 센서 콜백에서는 기다리지 않고 모든 채널에 함께 종료 신호를 보낸다.
        self.limit_reached.set()
        for channel in self.channels:
            channel.source.request_stop()

    def has_data(self) -> bool:
        if self.mode == "realtime":
            return any(ch.source.latest_points() for ch in self.channels)
        return bool(self.manual_source and self.manual_source.latest_points())


# 노트북 1대 = 그 순간 모둠 1개가 쓰는 도구라, 세션을 전역 상태 하나로 둔다.
# 여러 모둠이 같은 프로세스를 동시에 쓰는 상황은 다루지 않는다(§11 세션 F 범위 밖).
SESSION = _Session()
LOCK = threading.Lock()


@app.route("/")
def index():
    return render_template("index.html", sensors=sensor.available_sensors())


@app.route("/api/setup", methods=["POST"])
def api_setup():
    """학급 코드·모둠 번호·실험번호·조건·측정 간격(공유 값)을 정하고 측정 방법을 고른다.

    학급 아이디를 직접 입력받지 않는다 — 사람이 옮겨 적을 수 없는 문자열이라
    오타가 나고, Firestore는 없는 학급 밑에도 조용히 문서를 만들어 버려서
    측정이 통째로 사라진 것처럼 된다(§5.2 v2.2). 그래서 웹앱과 똑같이 학급
    코드로 joinCodes → classes를 조회해 실제로 있는 학급인지 여기서 먼저
    확인한다(측정 시작 전에 — 45분 재고 나서 알면 너무 늦다).
    """
    data = request.get_json(force=True) or {}
    try:
        exp_no = int(data.get("expNo", 0))
    except (TypeError, ValueError):
        return jsonify(ok=False, error="실험 번호가 올바르지 않습니다"), 400

    mode = data.get("mode")
    if mode not in ("realtime", "manual"):
        return jsonify(ok=False, error="측정 방법을 골라야 합니다"), 400

    join_code = (data.get("joinCode") or "").strip()
    try:
        group_no = int(data.get("groupNo", 0))
    except (TypeError, ValueError):
        return jsonify(ok=False, error="모둠을 골라 주세요"), 400
    if not join_code:
        return jsonify(ok=False, error="학급 코드를 입력하세요"), 400
    if not (1 <= group_no <= 8):
        return jsonify(ok=False, error="모둠을 골라 주세요"), 400

    try:
        interval_sec = float(data.get("intervalSec") or 10)
    except (TypeError, ValueError):
        return jsonify(ok=False, error="측정 간격이 올바르지 않습니다"), 400
    if not math.isfinite(interval_sec) or interval_sec < MIN_INTERVAL_SEC:
        return jsonify(ok=False, error=f"측정 간격은 {MIN_INTERVAL_SEC}초 이상이어야 해요"), 400

    try:
        config = uploader.load_config()
        id_token, _local_id = uploader.sign_in_anonymously(config["apiKey"])
        class_info = uploader.lookup_class_by_join_code(id_token, config["projectId"], join_code)
    except uploader.UploadError as exc:
        return jsonify(ok=False, error=str(exc)), 400

    with LOCK:
        SESSION.reset()
        SESSION.meta = {
            "class_id": class_info["classId"],
            "group_id": f"g{group_no}",
            "owner_uid": f"collector-{os.getpid()}",  # 업로드 시점에 실제 로그인 결과로 덮어씀
            "exp_no": exp_no,
            "condition": (data.get("condition") or "").strip(),
            "interval_sec": interval_sec,
            "title": (data.get("title") or "").strip(),  # 수동 입력 모드에서만 쓴다
        }
        SESSION.mode = mode

        if mode == "manual":
            name = data.get("sensor")
            if name not in sensor.MANUAL_ONLY_SENSORS:
                SESSION.reset()
                return jsonify(ok=False, error=f"알 수 없는 센서입니다: {name}"), 400
            SESSION.manual_source = sensor.ManualInputSource(name)
            SESSION.manual_sensor_name = name

    return jsonify(ok=True, mode=mode, className=class_info["className"])


@app.route("/api/scan")
def api_scan():
    """주변에서 지정한 종류의 센서를 찾는다. 같은 교실에서 다른 모둠도 동시에
    센서를 켜면 여러 대가 함께 잡힐 수 있으므로, 번호(deviceId)를 반드시
    같이 돌려줘야 한다 — 학생이 자기 모둠 센서 번호와 맞춰 골라야
    옆 모둠 것에 잘못 연결되지 않는다(세션 G가 실물 센서로 확인)."""
    sensor_type = request.args.get("type", "")
    try:
        if sensor_type in sensor.STANDARD_BLE_SENSORS:
            devices = sensor.scan_standard_ble_heart_rate()
        elif sensor_type in sensor.PASCO_SENSORS:
            devices = sensor.scan_sensors(sensor_type)
        else:
            return jsonify(ok=False, error=f"알 수 없는 센서 종류입니다: {sensor_type}"), 400
    except sensor.SensorConnectionError as exc:
        return jsonify(ok=False, error=str(exc)), 500
    return jsonify(ok=True, devices=devices)


@app.route("/api/channels", methods=["POST"])
def api_add_channel():
    """실시간 센서 1대를 번호로 지정해 연결하고 채널로 추가한다."""
    data = request.get_json(force=True) or {}
    sensor_name = data.get("sensorType")
    device_id = (data.get("deviceId") or "").strip()
    label = (data.get("label") or "").strip()
    title = (data.get("title") or "").strip() or f"{label}({device_id})"

    if sensor_name not in sensor.PASCO_SENSORS and sensor_name not in sensor.STANDARD_BLE_SENSORS:
        return jsonify(ok=False, error=f"알 수 없는 센서 종류입니다: {sensor_name}"), 400
    if not device_id or not label:
        return jsonify(ok=False, error="센서 번호와 이름표를 모두 입력하세요"), 400

    with LOCK:
        if SESSION.mode != "realtime":
            return jsonify(ok=False, error="먼저 1단계에서 실시간 측정을 선택하세요"), 400
        if SESSION.status == "measuring":
            return jsonify(ok=False, error="측정 중에는 센서를 추가할 수 없습니다"), 409
        if SESSION.status == "error":
            return jsonify(ok=False, error="오류가 난 센서 연결을 먼저 해제해 주세요"), 409
        if any(ch.device_id == device_id for ch in SESSION.channels):
            return jsonify(ok=False, error=f"센서 {device_id}는 이미 추가했습니다"), 400

        channel = _Channel(sensor_name, device_id, label, title)
        try:
            channel.source.connect(device_id)
        except sensor.SensorConnectionError as exc:
            return jsonify(ok=False, error=str(exc)), 500

        channel.device_id = channel.source.device_id or device_id
        channel.source.on_limit = SESSION.stop_at_limit
        SESSION.channels.append(channel)
        channels = [ch.to_dict() for ch in SESSION.channels]

    return jsonify(ok=True, channels=channels)


@app.route("/api/start", methods=["POST"])
def api_start():
    """측정을 시작한다. 센서를 연결한 뒤에야 "이 실험은 빨리/천천히 재야겠다"를
    판단할 수 있으므로, 측정 간격은 1단계(설정)가 아니라 이 시점에 화면에서
    다시 보내는 값을 쓴다 — 안 보내면 1단계에서 정한 값을 그대로 쓴다."""
    data = request.get_json(silent=True) or {}
    with LOCK:
        if SESSION.status == "measuring":
            return jsonify(ok=False, error="이미 측정 중입니다"), 409
        if SESSION.status == "error":
            return jsonify(
                ok=False,
                error="센서 연결 오류가 있어 다시 시작할 수 없어요. 연결을 해제하고 다시 검색해 주세요.",
            ), 409

        restart_mode = data.get("restartMode")
        if (
            SESSION.mode == "realtime"
            and SESSION.status in ("stopped", "uploaded")
            and restart_mode not in ("continue", "new")
        ):
            return jsonify(
                ok=False,
                error="이어서 잴지 새로 잴지 골라 주세요",
                needsRestartChoice=True,
                hasUnsavedData=SESSION.has_data() and not SESSION.uploaded,
                uploaded=SESSION.uploaded,
            ), 409
        if SESSION.mode == "realtime" and restart_mode == "continue" and SESSION.uploaded:
            return jsonify(
                ok=False,
                error="이미 서버로 보낸 측정은 이어 잴 수 없습니다. 새로 재기를 골라 주세요.",
            ), 409

        if "intervalSec" in data:
            try:
                interval_sec = float(data["intervalSec"])
            except (TypeError, ValueError):
                return jsonify(ok=False, error="측정 간격이 올바르지 않습니다"), 400
            if not math.isfinite(interval_sec) or interval_sec < MIN_INTERVAL_SEC:
                return jsonify(ok=False, error=f"측정 간격은 {MIN_INTERVAL_SEC}초 이상이어야 합니다"), 400
            SESSION.meta["interval_sec"] = interval_sec
        if restart_mode == "continue" and (SESSION.upload_datasets is not None or SESSION.limit_reached.is_set()):
            return jsonify(ok=False, error="업로드를 시도했거나 저장 한도에 도달한 측정은 새로 재기를 골라 주세요."), 409
        keep_existing = restart_mode == "continue"
        SESSION.limit_reached.clear()
        started_sources = []
        try:
            if SESSION.mode == "realtime":
                if not SESSION.channels:
                    return jsonify(ok=False, error="먼저 센서를 하나 이상 추가하세요"), 400
                for ch in SESSION.channels:
                    ch.source.start(SESSION.meta["interval_sec"], keep_existing=keep_existing)
                    started_sources.append(ch.source)
            elif SESSION.mode == "manual":
                if SESSION.manual_source is None:
                    return jsonify(ok=False, error="먼저 센서를 선택하세요"), 400
                SESSION.manual_source.start(keep_existing=keep_existing)
            else:
                return jsonify(ok=False, error="먼저 1단계를 채우세요"), 400
        except sensor.SensorConnectionError as exc:
            # 여러 센서 중 하나가 시작에 실패하면 앞에서 시작한 센서도 함께 멈춘다.
            for source in started_sources:
                source.stop()
            return jsonify(ok=False, error=str(exc)), 400
        if not keep_existing:
            SESSION.started_at = datetime.now(timezone.utc)
        SESSION.uploaded = False
        if not keep_existing:
            SESSION.upload_datasets = None
            SESSION.upload_results = []
        SESSION.status = "measuring"
    return jsonify(ok=True)


@app.route("/api/event", methods=["POST"])
def api_event():
    """모든 채널(또는 수동 입력)에 같은 순간을 함께 기록한다 — 여러 그래프를
    같은 시점 기준으로 비교해야 하기 때문이다."""
    label = ((request.get_json(force=True) or {}).get("label") or "").strip()
    if not label:
        return jsonify(ok=False, error="이벤트 이름을 입력하세요"), 400
    with LOCK:
        if SESSION.status != "measuring":
            return jsonify(ok=False, error="측정 중이 아닙니다"), 400
        if SESSION.mode == "realtime":
            for ch in SESSION.channels:
                ch.source.record_event(label)
        elif SESSION.manual_source is not None:
            SESSION.manual_source.record_event(label)
    return jsonify(ok=True)


@app.route("/api/manual-point", methods=["POST"])
def api_manual_point():
    """수동 입력 모드 전용 — 값 하나를 추가한다(심박수·폐활량 등)."""
    data = request.get_json(force=True) or {}
    with LOCK:
        if SESSION.mode != "manual" or SESSION.manual_source is None:
            return jsonify(ok=False, error="수동 입력 모드가 아닙니다"), 400
        try:
            value = float(data["value"])
        except (KeyError, TypeError, ValueError):
            return jsonify(ok=False, error="숫자 값을 입력하세요"), 400
        if SESSION.upload_datasets is not None:
            return jsonify(ok=False, error="업로드를 시도한 측정은 새로 시작해 주세요."), 409
        try:
            SESSION.manual_source.add_point(value)
        except (ValueError, RuntimeError) as exc:
            return jsonify(ok=False, error=str(exc)), 400
        SESSION.status = "measuring"
        if len(SESSION.manual_source.latest_points()) >= uploader.MAX_POINTS:
            SESSION.limit_reached.set()
            SESSION.status = "stopped"
        limit_reached = SESSION.limit_reached.is_set()
    return jsonify(ok=True, limitReached=limit_reached)


@app.route("/api/csv-upload", methods=["POST"])
def api_csv_upload():
    """수동 입력 모드 전용 — CSV로 points를 한 번에 채운다."""
    with LOCK:
        if SESSION.mode != "manual" or SESSION.manual_source is None:
            return jsonify(ok=False, error="수동 입력 모드가 아닙니다"), 400
        if SESSION.upload_datasets is not None:
            return jsonify(ok=False, error="업로드를 시도한 측정은 새로 시작해 주세요."), 409
        file = request.files.get("file")
        if not file:
            return jsonify(ok=False, error="파일이 없습니다"), 400
        try:
            SESSION.manual_source.load_csv(file.read())
        except ValueError as exc:
            return jsonify(ok=False, error=str(exc)), 400
        SESSION.started_at = SESSION.started_at or datetime.now(timezone.utc)
        SESSION.status = "measuring"
        count = len(SESSION.manual_source.latest_points())
        SESSION.limit_reached.clear()
        if count >= uploader.MAX_POINTS:
            SESSION.limit_reached.set()
            SESSION.status = "stopped"
    return jsonify(ok=True, count=count, limitReached=SESSION.limit_reached.is_set())


@app.route("/api/status")
def api_status():
    with LOCK:
        if SESSION.mode == "realtime":
            fatal_error = next(
                (getattr(ch.source, "fatal_error", None) for ch in SESSION.channels
                 if getattr(ch.source, "fatal_error", None)),
                None,
            )
            if SESSION.status == "measuring" and fatal_error:
                # 한 채널이 끊기면 비교 시각이 어긋나므로 다른 채널도 함께 멈춘다.
                for channel in SESSION.channels:
                    try:
                        channel.source.stop()
                    except sensor.SensorConnectionError:
                        pass
                SESSION.status = "error"
            if SESSION.status == "measuring" and SESSION.limit_reached.is_set():
                try:
                    for channel in SESSION.channels:
                        channel.source.stop()
                    SESSION.status = "stopped"
                except sensor.SensorConnectionError as exc:
                    SESSION.status = "error"
                    fatal_error = str(exc)
            channels = [ch.to_dict() for ch in SESSION.channels]
            return jsonify(
                ok=True, status=SESSION.status, channels=channels,
                hasData=SESSION.has_data(), uploaded=SESSION.uploaded,
                error=fatal_error, limitReached=SESSION.limit_reached.is_set(),
            )
        points = SESSION.manual_source.latest_points() if SESSION.manual_source else []
        return jsonify(
            ok=True, status=SESSION.status, points=points,
            nearLimit=len(points) >= NEAR_LIMIT_POINTS,
            limitReached=SESSION.limit_reached.is_set(),
            hasData=bool(points), uploaded=SESSION.uploaded,
        )


@app.route("/api/stop", methods=["POST"])
def api_stop():
    with LOCK:
        if SESSION.status != "measuring":
            return jsonify(ok=False, error="측정 중이 아닙니다"), 409
        if SESSION.mode == "realtime":
            if not SESSION.channels:
                return jsonify(ok=False, error="측정 중이 아닙니다"), 400
            counts = []
            errors = []
            for channel in SESSION.channels:
                try:
                    counts.append(len(channel.source.stop()[0]))
                except sensor.SensorConnectionError as exc:
                    errors.append(str(exc))
            if errors:
                SESSION.status = "error"
                return jsonify(ok=False, error=errors[0], counts=counts), 500
            SESSION.status = "stopped"
            return jsonify(ok=True, counts=counts, hasData=SESSION.has_data())
        if SESSION.manual_source is None:
            return jsonify(ok=False, error="측정 중이 아닙니다"), 400
        points, _events = SESSION.manual_source.stop()
        SESSION.status = "stopped"
    return jsonify(ok=True, count=len(points), hasData=bool(points))


@app.route("/api/disconnect", methods=["POST"])
def api_disconnect():
    """측정과 BLE 연결을 완전히 끝내고 1단계로 돌아간다.

    아직 보내지 않은 값이 있으면 화면에서 한 번 더 확인받는다. 측정 중에는 먼저
    종료하게 해 마지막 버킷을 저장하고, 오류 상태에서는 강제 확인 뒤 정리할 수 있다.
    """
    data = request.get_json(silent=True) or {}
    force = bool(data.get("force"))
    with LOCK:
        if SESSION.status == "measuring":
            return jsonify(ok=False, error="측정을 먼저 종료해 주세요."), 409
        if SESSION.has_data() and not SESSION.uploaded and not force:
            return jsonify(
                ok=False,
                error="아직 서버로 보내지 않은 측정값이 있어요.",
                needsDisconnectConfirm=True,
            ), 409
        try:
            SESSION.reset()
        except sensor.SensorConnectionError as exc:
            return jsonify(ok=False, error=str(exc)), 500
    return jsonify(ok=True)


def _build_dataset(meta: dict, title: str, sensor_name: str, unit: str,
                    points: list[dict], events: list[dict], source_kind: str) -> uploader.Dataset:
    return uploader.Dataset(
        class_id=meta["class_id"],
        group_id=meta["group_id"],
        owner_uid=meta["owner_uid"],
        exp_no=meta["exp_no"],
        title=title,
        condition=meta["condition"],
        sensor=sensor_name,
        unit=unit,
        started_at=SESSION.started_at or datetime.now(timezone.utc),
        interval_sec=meta["interval_sec"],
        points=points,
        events=events,
        source=source_kind,
        status="submitted",
    )


@app.route("/api/upload", methods=["POST"])
def api_upload():
    """실시간 모드는 채널마다 datasets 문서 1개(§5.2 — 측정 1회 = 문서 1개,
    센서 하나당 sensor·unit은 단수). 수동 모드는 기존처럼 문서 1개.

    학생과 똑같이 익명 로그인 뒤 그 자격으로 올린다(관리자 권한을 쓰지 않는다).
    채널이 여러 개면 로그인은 한 번만 하고 같은 토큰을 재사용한다."""
    with LOCK:
        if SESSION.uploaded:
            return jsonify(ok=True, results=SESSION.upload_results,
                           datasetId=SESSION.upload_results[0]["datasetId"] if SESSION.upload_results else None)
        if SESSION.mode == "realtime" and SESSION.status == "measuring":
            return jsonify(ok=False, error="측정을 먼저 종료한 뒤 서버로 보내 주세요"), 409
        try:
            config = uploader.load_config()
            if SESSION.upload_datasets is None:
                meta = SESSION.meta
                if SESSION.mode == "realtime":
                    candidates = [
                        ({"deviceId": ch.device_id, "label": ch.label}, _build_dataset(
                            meta, ch.title, ch.sensor_name, ch.source.unit,
                            ch.source.latest_points(), ch.source.latest_events(), "sensor"))
                        for ch in SESSION.channels
                    ]
                elif SESSION.manual_source is not None:
                    candidates = [({}, _build_dataset(
                        meta, meta.get("title") or SESSION.manual_sensor_name or "측정",
                        SESSION.manual_sensor_name, SESSION.manual_source.unit,
                        SESSION.manual_source.latest_points(), SESSION.manual_source.latest_events(), "manual"))]
                else:
                    candidates = []
                if not candidates:
                    return jsonify(ok=False, error="측정 데이터가 없습니다"), 400
                for _, ds in candidates:
                    uploader.validate(ds)
                # 측정값과 문서 번호를 첫 전송 전에 고정한다. 부분 실패에도 그대로 재사용한다.
                SESSION.upload_datasets = [(info, ds, uuid.uuid4().hex) for info, ds in candidates]

            id_token, local_id = uploader.sign_in_anonymously(config["apiKey"])
            completed = {r["datasetId"] for r in SESSION.upload_results}
            for info, ds, dataset_id in SESSION.upload_datasets:
                if dataset_id in completed:
                    continue
                uploader.upload_dataset(ds, config["apiKey"], config["projectId"],
                                        id_token, local_id, dataset_id=dataset_id)
                SESSION.upload_results.append({**info, "datasetId": dataset_id})
        except uploader.SchemaError as exc:
            return jsonify(ok=False, error=str(exc)), 400
        except uploader.UploadError as exc:
            return jsonify(ok=False, error=str(exc), results=SESSION.upload_results), 500

        SESSION.uploaded = True
        SESSION.status = "uploaded"
        return jsonify(ok=True, results=SESSION.upload_results,
                       datasetId=SESSION.upload_results[0]["datasetId"])



def main() -> None:
    app.run(host="127.0.0.1", port=5050, debug=False)


if __name__ == "__main__":
    main()
