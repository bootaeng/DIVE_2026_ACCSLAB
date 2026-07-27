"""
짐캐리 (JimCarry) - 부산 여행 일정 생성기 (CLI)

부산교통공사 해커톤 · 짐캐리 어플
------------------------------------------------------------
'짐 때문에 이동이 불편한 부산 여행자'에게서
    1) 짐 무게
    2) 짐 처리 상황 (당장 해치우고 싶은 정도)
    3) 여행 스타일
을 입력받아 페르소나를 구성한 뒤(persona.py),
NVIDIA LLM(nvidia_client.py)에게 부산 여행 일정을 짜도록 요청한다.

여행 시작일 기준 부산 날씨 예보(weather.py, Open-Meteo)와 사용자가
미리 정해둔 계획을 페르소나에 반영해 일정을 설계한다.

실행:
    export NVIDIA_API_KEY="nvapi-..."       # 또는 .env 사용 후 --env 옵션
    python jimcarry.py                      # 대화형 입력
"""

import argparse
import os
import sys

from persona import (
    TravelerInput,
    build_persona,
    build_user_request,
    LUGGAGE_WEIGHT_OPTIONS,
    LUGGAGE_URGENCY_OPTIONS,
    TRAVEL_STYLE_OPTIONS,
)
from nvidia_client import generate_schedule, DEFAULT_MODEL


def load_dotenv(path: str = ".env") -> None:
    """
    외부 라이브러리 없이 간단한 .env 파서.
    KEY=VALUE 형식만 읽어 os.environ 에 채운다. (이미 설정된 값은 덮어쓰지 않음)
    """
    if not os.path.exists(path):
        return
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            key, value = key.strip(), value.strip().strip('"').strip("'")
            if key and key not in os.environ:
                os.environ[key] = value


def _print_options(title: str, options: dict) -> None:
    print(f"\n{title}")
    for idx, (key, label) in enumerate(options.items(), start=1):
        print(f"  {idx}. {label}")


def _choose_single(title: str, options: dict) -> str:
    """번호로 하나를 고르게 하고, 선택된 옵션의 key 를 반환한다."""
    keys = list(options.keys())
    _print_options(title, options)
    while True:
        raw = input("번호 선택: ").strip()
        if raw.isdigit() and 1 <= int(raw) <= len(keys):
            return keys[int(raw) - 1]
        print("  올바른 번호를 입력하세요.")


def _choose_multiple(title: str, options: dict) -> list:
    """여러 개를 쉼표로 고르게 하고, 선택된 key 목록을 반환한다."""
    keys = list(options.keys())
    _print_options(title + " (복수 선택 가능, 예: 1,3)", options)
    while True:
        raw = input("번호 선택: ").strip()
        parts = [p.strip() for p in raw.split(",") if p.strip()]
        if parts and all(p.isdigit() and 1 <= int(p) <= len(keys) for p in parts):
            # 중복 제거하면서 순서 유지
            chosen = []
            for p in parts:
                k = keys[int(p) - 1]
                if k not in chosen:
                    chosen.append(k)
            return chosen
        print("  올바른 번호를 입력하세요. (예: 1 또는 1,3)")


def collect_input_interactive() -> TravelerInput:
    """대화형으로 사용자 입력을 수집한다."""
    print("=" * 60)
    print(" 짐캐리 (JimCarry) · 부산 여행 일정 도우미")
    print(" 짐 걱정 없이 부산을 즐기도록 일정을 짜드립니다.")
    print("=" * 60)

    weight = _choose_single("[1] 짐이 얼마나 무거우신가요?", LUGGAGE_WEIGHT_OPTIONS)
    urgency = _choose_single("[2] 지금 짐을 어떻게 하고 싶으신가요?", LUGGAGE_URGENCY_OPTIONS)
    styles = _choose_multiple("[3] 어떤 여행을 원하시나요?", TRAVEL_STYLE_OPTIONS)

    # 부가 정보 (엔터로 건너뛰기 가능)
    days_raw = input("\n[4] 여행 일수 (기본 1일, 엔터=1): ").strip()
    days = int(days_raw) if days_raw.isdigit() and int(days_raw) > 0 else 1

    start_area = input("[5] 출발/현재 위치 (예: 부산역, 김해공항 / 엔터=생략): ").strip()
    companions = input("[6] 동행 (예: 혼자, 친구, 가족 / 엔터=생략): ").strip()

    travel_date = input("[7] 여행 시작일 YYYY-MM-DD (엔터=오늘부터, 날씨 예보에 사용): ").strip()

    # 계획 유무 → 있으면 자유 텍스트로 받기
    plan = ""
    yn = input("[8] 이미 정해둔 계획이 있나요? (y/N): ").strip().lower()
    if yn in ("y", "yes", "ㅇ"):
        print("    계획을 자유롭게 입력하세요. (여러 줄 가능, 다 쓰면 빈 줄에서 엔터)")
        lines = []
        while True:
            try:
                line = input("    > ")
            except EOFError:
                break
            if line.strip() == "":
                break
            lines.append(line)
        plan = "\n".join(lines).strip()

    return TravelerInput(
        luggage_weight=weight,
        luggage_urgency=urgency,
        travel_style=styles,
        travel_days=days,
        start_area=start_area,
        companions=companions,
        travel_date=travel_date,
        existing_plan=plan,
    )


def run(traveler: TravelerInput, model: str, extra_note: str = "",
        show_persona: bool = False, weather_summary: str = "") -> str:
    """페르소나 구성 → LLM 일정 생성."""
    persona = build_persona(traveler, weather_summary=weather_summary)
    user_request = build_user_request(traveler, extra_note=extra_note)

    if show_persona:
        print("\n" + "-" * 60)
        print("[구성된 페르소나]")
        print("-" * 60)
        print(persona)

    print("\n" + "=" * 60)
    print(" 부산 여행 일정 생성 중... (NVIDIA LLM)")
    print("=" * 60 + "\n")

    schedule = generate_schedule(persona, user_request, model=model, stream_to_stdout=True)
    return schedule


def main() -> int:
    parser = argparse.ArgumentParser(description="짐캐리 · 부산 여행 일정 생성기")
    parser.add_argument("--model", default=DEFAULT_MODEL, help=f"NVIDIA 모델명 (기본: {DEFAULT_MODEL})")
    parser.add_argument("--env", default=".env", help=".env 파일 경로 (기본: .env)")
    parser.add_argument("--show-persona", action="store_true", help="구성된 페르소나를 함께 출력")
    parser.add_argument("--note", default="", help="추가 요청사항")
    # 비대화형(스크립트/백엔드 테스트)용 옵션
    parser.add_argument("--weight", choices=list(LUGGAGE_WEIGHT_OPTIONS), help="짐 무게 (비대화형)")
    parser.add_argument("--urgency", choices=list(LUGGAGE_URGENCY_OPTIONS), help="짐 처리 상황 (비대화형)")
    parser.add_argument("--style", help="여행 스타일 (쉼표 구분, 예: food,healing) (비대화형)")
    parser.add_argument("--days", type=int, default=1, help="여행 일수 (비대화형)")
    parser.add_argument("--start", default="", help="출발/현재 위치 (비대화형)")
    parser.add_argument("--companions", default="", help="동행 (비대화형)")
    parser.add_argument("--date", default="", help="여행 시작일 YYYY-MM-DD (날씨 예보용, 비대화형)")
    parser.add_argument("--plan", default="", help="이미 정해둔 계획 텍스트 (비대화형)")
    # 날씨 옵션
    parser.add_argument("--no-weather", action="store_true", help="날씨 조회를 건너뜀")
    args = parser.parse_args()

    # .env 로드 (NVIDIA_API_KEY 등)
    load_dotenv(args.env)

    # 비대화형 모드: 필수 옵션이 주어지면 입력 프롬프트 없이 실행
    if args.weight and args.urgency:
        styles = [s.strip() for s in (args.style or "").split(",") if s.strip()]
        invalid = [s for s in styles if s not in TRAVEL_STYLE_OPTIONS]
        if invalid:
            parser.error(f"알 수 없는 여행 스타일: {invalid}. 선택지: {list(TRAVEL_STYLE_OPTIONS)}")
        traveler = TravelerInput(
            luggage_weight=args.weight,
            luggage_urgency=args.urgency,
            travel_style=styles,
            travel_days=max(1, args.days),
            start_area=args.start,
            companions=args.companions,
            travel_date=args.date,
            existing_plan=args.plan,
        )
    else:
        traveler = collect_input_interactive()

    # 날씨 조회 (Open-Meteo, 키 불필요). 실패해도 일정 생성은 계속.
    weather_summary = ""
    if not args.no_weather:
        try:
            from weather import get_busan_weather, format_for_persona
            print("\n부산 날씨 예보 조회 중... (Open-Meteo)")
            forecast = get_busan_weather(days=traveler.travel_days, start_date=traveler.travel_date)
            weather_summary = format_for_persona(forecast)
            if weather_summary:
                print(weather_summary)
            else:
                print("  (예보를 가져오지 못해 날씨 없이 진행합니다.)")
        except Exception as e:
            print(f"  [날씨 조회 오류] {e} — 날씨 없이 진행합니다.")

    try:
        schedule = run(traveler, model=args.model, extra_note=args.note,
                       show_persona=args.show_persona, weather_summary=weather_summary)
    except ValueError as e:
        # NVIDIA_API_KEY 미설정 등
        print(f"\n[오류] {e}", file=sys.stderr)
        return 1
    except Exception as e:  # API 오류 등
        print(f"\n[API 오류] 일정 생성 중 문제가 발생했습니다: {e}", file=sys.stderr)
        return 1

    # (지도 시각화는 별도 모듈에서 담당하므로 이 프로그램에서는 다루지 않는다.)
    _ = schedule  # 생성된 일정 텍스트는 반환/후속 처리에 사용할 수 있다.

    print("\n" + "=" * 60)
    print(" 완료! 즐거운 부산 여행 되세요 🧳🌊")
    print("=" * 60)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
