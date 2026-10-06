"""실제 센서·서버 없이 업로드 재시도와 저장 한도를 검사한다."""
import io
import asyncio
import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import main
import sensor
import uploader


class ImprovementsTest(unittest.TestCase):
    def tearDown(self):
        main.SESSION.reset()

    def test_upload_response_loss_and_uid_change(self):
        ds = uploader._mock_dataset()
        stored = {}
        posts = []

        def post(_url, **kwargs):
            posts.append(kwargs["params"]["documentId"])
            if not stored:
                stored.update(kwargs["json"]["fields"])
                raise OSError("응답 유실")
            return SimpleNamespace(status_code=409)

        requests = SimpleNamespace(
            RequestException=OSError, post=post,
            get=lambda *_args, **_kwargs: SimpleNamespace(status_code=200, json=lambda: {"fields": stored}),
        )
        with patch.object(uploader, "_requests_module", return_value=requests):
            with self.assertRaises(uploader.UploadError):
                uploader.upload_dataset(ds, "key", "project", "token", "uid1", "fixed")
            # Firestore는 빈 배열·시각을 정규화해 돌려줄 수 있다.
            stored["events"] = uploader._to_value(ds.events)
            self.assertEqual(uploader.upload_dataset(ds, "key", "project", "token2", "uid2", "fixed"), "fixed")
            self.assertEqual(stored["ownerUid"], {"stringValue": "uid1"})
            ds.title = "다른 측정"
            with self.assertRaises(uploader.UploadError):
                uploader.upload_dataset(ds, "key", "project", "token2", "uid2", "fixed")
        self.assertEqual(posts, ["fixed"] * 3)

    def test_partial_upload_retry_and_repeat(self):
        main.SESSION.mode = "realtime"
        main.SESSION.status = "stopped"
        main.SESSION.meta = dict(class_id="class", group_id="g1", owner_uid="placeholder",
                                 exp_no=4, condition="가열", interval_sec=1)
        sources = []
        for number in range(2):
            source = SimpleNamespace(
                unit="℃", latest_points=lambda: [{"t": 0, "v": 20}],
                latest_events=lambda: [], disconnect=lambda: None,
            )
            sources.append(SimpleNamespace(source=source, title=str(number), sensor_name="Temperature",
                                           device_id=str(number), label=str(number)))
        main.SESSION.channels = sources
        seen = []
        fail = True

        def upload(_ds, *_args, dataset_id):
            nonlocal fail
            seen.append(dataset_id)
            if len(seen) == 2 and fail:
                fail = False
                raise uploader.UploadError("두 번째 채널 실패")
            return dataset_id

        with patch.object(uploader, "load_config", return_value={"apiKey": "key", "projectId": "project"}), \
             patch.object(uploader, "sign_in_anonymously", return_value=("token", "uid")), \
             patch.object(uploader, "upload_dataset", side_effect=upload):
            client = main.app.test_client()
            first = client.post("/api/upload")
            self.assertEqual(first.status_code, 500)
            self.assertEqual(len(first.get_json()["results"]), 1)
            self.assertEqual(client.post("/api/upload").status_code, 200)
            self.assertEqual(client.post("/api/upload").status_code, 200)
        self.assertEqual(len(seen), 3)
        self.assertEqual(seen[1], seen[2])
        self.assertNotEqual(seen[0], seen[1])
        self.assertEqual(len(main.SESSION.upload_results), 2)

    def test_manual_and_csv_limits_preserve_original(self):
        source = sensor.ManualInputSource("HeartRate")
        source.start()
        for number in range(uploader.MAX_POINTS):
            source.add_point(80, number)
        self.assertEqual(len(source.latest_points()), 5000)
        with self.assertRaises(ValueError):
            source.add_point(80, 5000)
        with self.assertRaises(ValueError):
            source.load_csv(io.StringIO("t,v\n" + "0,80\n" * 5001))
        self.assertEqual(len(source.latest_points()), 5000)
        for contents in ("t,v\n0,nan", "t,v\n1,80\n0,80", "t,v\n-1,80"):
            with self.assertRaises(ValueError):
                source.load_csv(io.StringIO(contents))
            self.assertEqual(len(source.latest_points()), 5000)

    def test_last_bucket_and_coordinated_stop(self):
        for source_type in (sensor.PascoSensorSource, sensor.StandardBleHeartRateSource):
            source = source_type("Temperature" if source_type is sensor.PascoSensorSource else "HeartRate")
            other = sensor.PascoSensorSource("Temperature")
            main.SESSION.channels = [SimpleNamespace(source=source), SimpleNamespace(source=other)]
            source.on_limit = main.SESSION.stop_at_limit
            source._points = [{"t": float(n), "v": 20} for n in range(4999)]
            source._bucket = [(4999, 21)]
            source._flush_bucket()
            source._flush_bucket()  # 종료 때 빈 버킷이 점을 더 만들지 않는다.
            self.assertEqual(len(source.latest_points()), 5000)
            self.assertEqual(source.latest_points()[-1]["v"], 21)
            self.assertTrue(main.SESSION.limit_reached.is_set())
            self.assertTrue(other._limit_stop.is_set())
            main.SESSION.channels = []
            main.SESSION.limit_reached.clear()

    def test_poll_stops_before_reading_a_5001st_point(self):
        source = sensor.PascoSensorSource("Temperature")
        source._points = [{"t": float(n), "v": 20} for n in range(4999)]
        source._start_time = time.monotonic() - 4999
        reads = []
        source._device = SimpleNamespace(
            read_data=lambda _measurement: reads.append(21) or 21,
            CommunicationError=OSError, MeasurementNotFound=KeyError, DeviceNotConnected=RuntimeError,
        )
        source._poll_loop(0)
        self.assertEqual(len(reads), 1)
        self.assertEqual(len(source.latest_points()), 5000)

    def test_heart_rate_notifications_stop_at_limit(self):
        source = sensor.StandardBleHeartRateSource()
        source._points = [{"t": float(n), "v": 80} for n in range(4999)]
        handlers = []

        async def start_notify(_uuid, handler):
            handlers.append(handler)

        source._client = SimpleNamespace(is_connected=True, start_notify=start_notify)
        with patch.object(sensor, "_run_hr_coro", side_effect=asyncio.run):
            source.start(1, keep_existing=True)
        source._next_flush = 0
        handlers[0](None, bytearray([0, 80]))
        handlers[0](None, bytearray([0, 90]))
        self.assertEqual(len(source.latest_points()), 5000)
        self.assertEqual(source._bucket, [])

    def test_manual_api_reports_limit_without_accepting_overflow(self):
        main.SESSION.mode = "manual"
        main.SESSION.manual_source = sensor.ManualInputSource("HeartRate")
        main.SESSION.manual_source.start()
        main.SESSION.manual_source._points = [{"t": 0, "v": 80}] * 4999
        client = main.app.test_client()
        response = client.post("/api/manual-point", json={"value": 80})
        self.assertTrue(response.get_json()["limitReached"])
        self.assertEqual(main.SESSION.status, "stopped")
        self.assertEqual(client.post("/api/manual-point", json={"value": 80}).status_code, 400)
        self.assertEqual(len(main.SESSION.manual_source.latest_points()), 5000)


if __name__ == "__main__":
    unittest.main()
