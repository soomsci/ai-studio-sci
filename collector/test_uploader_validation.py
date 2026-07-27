"""수집기 데이터 개수 경계값을 센서 없이 검증한다."""

from __future__ import annotations

import unittest
from datetime import datetime, timezone

import uploader


def dataset_with(points: list[dict]) -> uploader.Dataset:
    return uploader.Dataset(
        class_id="class-1",
        group_id="g1",
        owner_uid="user-1",
        exp_no=1,
        title="검증용 측정",
        condition="창문 닫음",
        sensor="CO2",
        unit="ppm",
        started_at=datetime.now(timezone.utc),
        interval_sec=10,
        points=points,
    )


class DatasetPointBoundaryTest(unittest.TestCase):
    def test_zero_points_are_rejected(self) -> None:
        with self.assertRaisesRegex(uploader.SchemaError, "하나도 없습니다"):
            uploader.validate(dataset_with([]))

    def test_one_point_is_allowed(self) -> None:
        uploader.validate(dataset_with([{"t": 0, "v": 500}]))

    def test_more_than_5000_points_are_rejected(self) -> None:
        points = [{"t": i, "v": 500} for i in range(uploader.MAX_POINTS + 1)]
        with self.assertRaisesRegex(uploader.SchemaError, "5000개"):
            uploader.validate(dataset_with(points))


if __name__ == "__main__":
    unittest.main()
