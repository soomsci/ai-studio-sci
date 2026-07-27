"""센서 없이 수집기 측정 상태 전이를 검증한다."""

from __future__ import annotations

import unittest
from types import SimpleNamespace

import main


class FakeSource:
    unit = "℃"

    def __init__(self) -> None:
        self.points = []
        self.events = []
        self.started_with = []
        self.running = False
        self.disconnected = False

    def start(self, _interval: float, keep_existing: bool = False) -> None:
        if self.running:
            raise main.sensor.SensorConnectionError("이미 측정 중입니다")
        if not keep_existing:
            self.points = []
            self.events = []
        self.started_with.append(keep_existing)
        self.running = True

    def stop(self):
        self.running = False
        if not self.points:
            self.points.append({"t": 1, "v": 20})
        return self.points, self.events

    def disconnect(self) -> None:
        self.running = False
        self.disconnected = True

    def latest_points(self):
        return list(self.points)

    def display_points(self):
        return list(self.points)

    def latest_events(self):
        return list(self.events)


class MeasurementLifecycleTest(unittest.TestCase):
    def setUp(self) -> None:
        main.SESSION.reset()
        source = FakeSource()
        channel = SimpleNamespace(
            source=source,
            sensor_name="Temperature",
            device_id="123-456",
            label="물",
            title="물(123-456)",
            to_dict=lambda: {
                "deviceId": "123-456", "label": "물", "title": "물(123-456)",
                "sensor": "Temperature", "unit": "℃", "count": len(source.points),
                "latestValue": source.points[-1]["v"] if source.points else None,
                "points": list(source.points), "nearLimit": False,
            },
        )
        main.SESSION.mode = "realtime"
        main.SESSION.channels = [channel]
        main.SESSION.meta = {"interval_sec": 10}
        self.source = source
        self.client = main.app.test_client()

    def tearDown(self) -> None:
        main.SESSION.reset()

    def test_stop_keeps_connection_and_continue_keeps_points(self) -> None:
        self.assertEqual(self.client.post("/api/start", json={}).status_code, 200)
        self.assertEqual(self.client.post("/api/start", json={}).status_code, 409)

        stopped = self.client.post("/api/stop")
        self.assertEqual(stopped.status_code, 200)
        self.assertFalse(self.source.disconnected)
        self.assertTrue(stopped.get_json()["hasData"])

        choice = self.client.post("/api/start", json={})
        self.assertEqual(choice.status_code, 409)
        self.assertTrue(choice.get_json()["needsRestartChoice"])

        resumed = self.client.post("/api/start", json={"restartMode": "continue"})
        self.assertEqual(resumed.status_code, 200)
        self.assertTrue(self.source.started_with[-1])
        self.assertEqual(len(self.source.points), 1)

    def test_new_measurement_clears_points(self) -> None:
        self.source.points = [{"t": 1, "v": 20}]
        main.SESSION.status = "stopped"

        response = self.client.post("/api/start", json={"restartMode": "new"})
        self.assertEqual(response.status_code, 200)
        self.assertFalse(self.source.started_with[-1])
        self.assertEqual(self.source.points, [])

    def test_uploaded_measurement_cannot_continue(self) -> None:
        self.source.points = [{"t": 1, "v": 20}]
        main.SESSION.status = "uploaded"
        main.SESSION.uploaded = True

        response = self.client.post("/api/start", json={"restartMode": "continue"})
        self.assertEqual(response.status_code, 409)
        self.assertIn("새로 재기", response.get_json()["error"])

    def test_stop_does_not_disconnect_real_sensor_source(self) -> None:
        class FakeDevice:
            def __init__(self) -> None:
                self.disconnect_count = 0

            def is_connected(self) -> bool:
                return True

            def disconnect(self) -> None:
                self.disconnect_count += 1

        source = main.sensor.PascoSensorSource("Temperature")
        source._device = FakeDevice()

        source.stop()
        self.assertEqual(source._device.disconnect_count, 0)

        device = source._device
        source.disconnect()
        self.assertEqual(device.disconnect_count, 1)
        self.assertIsNone(source._device)


if __name__ == "__main__":
    unittest.main()
