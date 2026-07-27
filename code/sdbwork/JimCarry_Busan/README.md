# 짐캐리 (JimCarry) · 부산 여행 일정 생성기

부산교통공사 해커톤 프로젝트. **짐 때문에 이동이 불편한 부산 여행자**를 위해,
사용자의 상황을 페르소나로 구성한 뒤 NVIDIA LLM 이 짐 부담을 최소화한 부산 여행 일정을 짜준다.

> 페르소나 구성 방식과 NVIDIA API 호출 방식은 `Dobum_Etri` 프로젝트
> (`2) QnA_Generation.py` 의 페르소나, `1-2) Data_Argument_nvidia.py` 의 NVIDIA 호출)를 참고했다.

> 지도 시각화는 **별도 모듈(다른 조원 담당)** 로 분리되어 이 프로그램에는 포함하지 않는다.
> 이 프로그램은 생성된 일정 텍스트를 반환/출력하는 데까지 담당한다.

## 흐름

```
입력(짐·스타일·시작일·계획) ─▶ weather.py(부산 예보) ┐
                                                    ├─▶ persona.build_persona() ─▶ NVIDIA LLM ─▶ 부산 여행 일정
계획 텍스트 ─────────────────────────────────────────┘
```

## 파일 구성

| 파일 | 역할 |
|------|------|
| `persona.py` | 입력(짐/스타일 + 날씨 + 계획)을 받아 LLM 페르소나 문자열 생성 |
| `weather.py` | Open-Meteo 로 부산 일자별 날씨 예보 조회 (API 키 불필요) |
| `nvidia_client.py` | NVIDIA OpenAI 호환 API 호출 (`chat` / `chat_json` / `generate_schedule`) |
| `jimcarry.py` | CLI 진입점 — 입력 → (날씨) → 페르소나 → 일정 |

### 입력 항목
필수(짐 무게·짐 상황·여행 스타일)에 더해, 대화형 실행 시 **여행 시작일**(날씨 예보용)과
**이미 정해둔 계획 유무**를 묻고, 계획이 있으면 자유 텍스트로 입력받아 페르소나에 반영한다.
날씨는 Open-Meteo 로 자동 조회되어, 비 오는 날은 실내 코스·짐 보관 강화 등으로 일정이 조정된다.

## 설치 & 실행

```bash
pip install -r requirements.txt          # openai

# 키 설정: cp .env.example .env  후 .env 편집 (또는 export)
export NVIDIA_API_KEY="nvapi-..."         # 일정 생성 (필수)

# 대화형 실행 (시작일·계획을 묻고 날씨 자동 반영)
python jimcarry.py

# 페르소나도 함께 확인
python jimcarry.py --show-persona
```

### 비대화형 실행 (데모/테스트용)

```bash
python jimcarry.py \
  --weight heavy \
  --urgency now \
  --style food,healing \
  --days 2 \
  --start 부산역 \
  --companions 친구 \
  --date 2026-07-25 \
  --plan "토요일 광안리 야경, 밀면 점심"
```

## 입력 선택지

- **짐 무게**: `light` / `medium` / `heavy`
- **짐 처리 상황**: `now`(당장 맡기고 싶음) / `soon`(체크인 전 잠깐) / `carry`(들고 다녀도 됨) / `deliver`(미리 배송)
- **여행 스타일**: `activity` / `food` / `healing` / `photo` / `culture` / `shopping`

## 옵션

| 옵션 | 설명 |
|------|------|
| `--date YYYY-MM-DD` | 여행 시작일 (날씨 예보 기준, 비대화형) |
| `--plan "..."` | 이미 정해둔 계획 텍스트 (비대화형) |
| `--no-weather` | 날씨 조회를 건너뜀 |
| `--show-persona` | 구성된 페르소나를 함께 출력 |
| `--model` | NVIDIA 모델명 변경 |

날씨는 Open-Meteo(무료·키 불필요)를 쓰므로 별도 키가 필요 없다. 조회 실패 시 자동으로 날씨 없이 진행한다.

## 모델

기본 모델은 `openai/gpt-oss-120b` (NVIDIA NIM). `--model` 로 변경할 수 있다.

## 백엔드 연동

각 단계가 순수 함수라 백엔드에서 조합해 쓸 수 있다:
`get_busan_weather()` → `build_persona()` → `generate_schedule()`.
반환된 일정 텍스트를 지도 모듈 등 다른 컴포넌트로 넘겨 후속 처리할 수 있다.
