"""
짐캐리 (JimCarry) - NVIDIA LLM 호출 모듈

Dobum_Etri 의 1-2) Data_Argument_nvidia.py 의 NVIDIA OpenAI 호환 호출 방식을
그대로 따른다.
    - base_url : https://integrate.api.nvidia.com/v1
    - api_key  : 환경변수 NVIDIA_API_KEY
    - 스트리밍 응답 처리

제공 함수
    - generate_schedule() : 페르소나 기반 일정 생성 (스트리밍 출력)
    - chat()              : 범용 chat 호출 (스트리밍/비스트리밍)
    - chat_json()         : JSON 출력을 강제해 파싱해서 반환 (장소 추출 등에 사용)
"""

import json
import os
import re


# NVIDIA OpenAI 호환 API 클라이언트
#   주의: API Key 는 코드에 직접 넣지 말고 환경변수(NVIDIA_API_KEY)로 관리한다.
DEFAULT_MODEL = "openai/gpt-oss-120b"
NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1"


def get_client():
    """NVIDIA API 클라이언트를 생성한다."""
    # openai 는 실제 호출 시점에만 필요하므로 지연 import 한다.
    try:
        from openai import OpenAI
    except ImportError as e:
        raise ImportError(
            "openai 패키지가 필요합니다. 'pip install -r requirements.txt' 로 설치하세요."
        ) from e

    api_key = os.environ.get("NVIDIA_API_KEY")
    if not api_key:
        raise ValueError(
            "NVIDIA_API_KEY 환경변수가 설정되어 있지 않습니다.\n"
            "  export NVIDIA_API_KEY=\"nvapi-...\" 형태로 설정하거나 .env 파일을 사용하세요."
        )
    return OpenAI(base_url=NVIDIA_BASE_URL, api_key=api_key)


def chat(
    system_prompt: str,
    user_prompt: str,
    model: str = DEFAULT_MODEL,
    temperature: float = 0.6,
    max_tokens: int = 4096,
    stream_to_stdout: bool = False,
) -> str:
    """
    범용 chat 호출. system/user 메시지를 보내고 응답 텍스트를 반환한다.
    항상 스트리밍으로 받아오되, stream_to_stdout 이 True 면 화면에도 실시간 출력한다.
    """
    client = get_client()

    completion = client.chat.completions.create(
        model=model,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        temperature=temperature,
        top_p=1,
        max_tokens=max_tokens,
        stream=True,
    )

    content_parts = []
    finish_reason = None

    for chunk in completion:
        if not getattr(chunk, "choices", None):
            continue

        choice = chunk.choices[0]
        delta = choice.delta

        if getattr(choice, "finish_reason", None) is not None:
            finish_reason = choice.finish_reason

        # reasoning_content 는 최종 결과가 아니므로 저장하지 않는다.
        content = getattr(delta, "content", None)
        if content is not None:
            content_parts.append(content)
            if stream_to_stdout:
                print(content, end="", flush=True)

    if stream_to_stdout:
        print()  # 줄바꿈 마무리

    if finish_reason == "length":
        print(
            "\n[안내] 모델이 최대 출력 토큰을 모두 사용해 응답이 잘렸을 수 있습니다. "
            "max_tokens 를 늘려 다시 시도하세요."
        )

    return "".join(content_parts).strip()


def generate_schedule(
    persona: str,
    user_request: str,
    model: str = DEFAULT_MODEL,
    temperature: float = 0.6,
    max_tokens: int = 4096,
    stream_to_stdout: bool = True,
) -> str:
    """
    페르소나(system_instruction)와 사용자 요청을 받아 부산 여행 일정을 생성한다.
    (chat() 의 얇은 래퍼 — 기본적으로 화면에 실시간 출력)
    """
    return chat(
        system_prompt=persona,
        user_prompt=user_request,
        model=model,
        temperature=temperature,
        max_tokens=max_tokens,
        stream_to_stdout=stream_to_stdout,
    )


def _extract_json(text: str):
    """
    모델 응답 문자열에서 JSON(객체/배열)만 추출해 파싱한다.
    ```json 코드펜스나 앞뒤 설명이 섞여 있어도 최대한 복구한다.
    """
    if not text:
        return None

    cleaned = text.strip().replace("```json", "").replace("```", "").strip()

    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        pass

    # 본문에서 첫 번째 { ... } 또는 [ ... ] 블록을 추출 시도
    for pattern in (r"\{.*\}", r"\[.*\]"):
        match = re.search(pattern, cleaned, re.DOTALL)
        if match:
            try:
                return json.loads(match.group(0))
            except json.JSONDecodeError:
                continue
    return None


def chat_json(
    system_prompt: str,
    user_prompt: str,
    model: str = DEFAULT_MODEL,
    temperature: float = 0.1,
    max_tokens: int = 4096,
):
    """
    JSON 출력을 기대하는 호출. 응답을 파싱해 dict/list 로 반환한다.
    파싱 실패 시 None 을 반환한다. (구조화 데이터 추출용, 낮은 temperature)
    """
    raw = chat(
        system_prompt=system_prompt,
        user_prompt=user_prompt,
        model=model,
        temperature=temperature,
        max_tokens=max_tokens,
        stream_to_stdout=False,
    )
    return _extract_json(raw)
