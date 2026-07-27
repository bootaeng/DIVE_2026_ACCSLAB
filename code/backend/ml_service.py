# -*- coding: utf-8 -*-
"""캐리로그 ML 서비스 — nocarrier-core 래퍼 (port 3300).

배리어프리 라우팅의 자원충돌점수를 nocarrier-core의 학습된 파이프라인으로 계산한다:
  Component A  : LightGBM 혼잡도 예측 (실측 2025 승하차 학습, MAE 31.65)
  Component A' : STL 이벤트 스파이크 감지
  Component B  : 자원충돌점수 (혼잡 리스크 + 엘리베이터 여유도 + 대체경로 리스크 가중합)

엔드포인트
  GET  /health          → 모델/데이터 로드 상태
  POST /route-conflict  → {"stations":[113,119,...], "timestamp":"ISO(선택)"}
                          경로 상 역별 충돌점수 + 경로 종합점수(0~100)
"""
from __future__ import annotations

import os
import sys
from datetime import datetime
from pathlib import Path

# nocarrier-core는 상대경로(config/, data/, artifacts/) 기준으로 동작한다
NOCARRIER_DIR = Path(__file__).resolve().parent.parent / "nocarrier-core"
os.chdir(NOCARRIER_DIR)
sys.path.insert(0, str(NOCARRIER_DIR / "src"))

from flask import Flask, jsonify, request  # noqa: E402

from nocarrier.api import load_resources  # noqa: E402
from nocarrier.pipeline.steps import forecast_congestion_step, score_conflict_step  # noqa: E402

app = Flask(__name__)
RESOURCES = load_resources()  # 학습 아티팩트·데이터 1회 로드 (실패 시 기동 자체가 실패)
KNOWN_IDS = set(int(x) for x in RESOURCES.stations["station_id"].tolist())


def _score_station(station_id: int, ts: datetime) -> dict | None:
    """역 하나의 LightGBM 혼잡 예측 + 자원충돌점수. 모델 커버리지 밖 역은 None."""
    if station_id not in KNOWN_IDS:
        return None
    try:
        congestion = forecast_congestion_step(RESOURCES, station_id, ts)
        conflict = score_conflict_step(RESOURCES, station_id, ts, congestion.level)
    except Exception:
        return None  # 베이스라인/피처 없는 역(보조노선 등)은 건너뜀
    return {
        "stationId": station_id,
        "name": congestion.station_name,
        "predictedVolume": round(float(congestion.predicted_volume), 1),
        "congestionLevel": congestion.level.value,          # low|medium|high|severe
        "eventSpike": bool(congestion.is_event_spike),
        "conflictScore": round(float(conflict.score), 3),    # 0.0~1.0
        "conflictLevel": conflict.level.value,
        "factors": conflict.contributing_factors,
    }


@app.get("/health")
def health():
    return jsonify({
        "ok": True,
        "engine": "nocarrier-core",
        "congestionModel": "lightgbm_congestion_v1 (MAE 31.65)",
        "stations": len(KNOWN_IDS),
    })


@app.post("/route-conflict")
def route_conflict():
    body = request.get_json(silent=True) or {}
    raw_ids = body.get("stations") or []
    try:
        station_ids = [int(s) for s in raw_ids]
    except (TypeError, ValueError):
        return jsonify({"error": "stations는 역번호(int) 배열이어야 합니다."}), 400
    if not station_ids:
        return jsonify({"error": "stations가 비어 있습니다."}), 400

    ts = datetime.now()
    raw_ts = str(body.get("timestamp", "")).strip()
    if raw_ts:
        try:
            ts = datetime.fromisoformat(raw_ts)
        except ValueError:
            pass  # 형식이 틀리면 현재 시각 사용

    # 중복 역(환승으로 같은 역이 두 번 등장 등)은 한 번만 계산
    seen: set[int] = set()
    stations = []
    for sid in station_ids:
        if sid in seen:
            continue
        seen.add(sid)
        result = _score_station(sid, ts)
        if result:
            stations.append(result)

    if not stations:
        return jsonify({"error": "모델 커버리지에 있는 역이 없습니다.", "stations": []}), 404

    scores = [s["conflictScore"] for s in stations]
    mean_score = sum(scores) / len(scores)
    max_score = max(scores)
    # 경로 종합: 평균 60% + 최악 병목 40% (병목 하나가 경로 전체 체감을 좌우)
    route_score = round((0.6 * mean_score + 0.4 * max_score) * 100)

    worst = max(stations, key=lambda s: s["conflictScore"])
    return jsonify({
        "engine": "lightgbm",
        "timestamp": ts.isoformat(timespec="seconds"),
        "routeScore": route_score,             # 0~100 (높을수록 충돌 위험)
        "meanScore": round(mean_score * 100),
        "maxScore": round(max_score * 100),
        "worstStation": {"stationId": worst["stationId"], "name": worst["name"], "score": round(worst["conflictScore"] * 100)},
        "coverage": {"scored": len(stations), "requested": len(set(station_ids))},
        "stations": stations,
    })


if __name__ == "__main__":
    if sys.stdout.encoding and sys.stdout.encoding.lower() not in ("utf-8", "utf8"):
        sys.stdout.reconfigure(errors="replace")
        sys.stderr.reconfigure(errors="replace")
    port = int(os.environ.get("ML_PORT", 3300))
    print(f"🧠 CarryLog ML Service (nocarrier-core / LightGBM) on http://localhost:{port}")
    app.run(host="127.0.0.1", port=port, threaded=True)
