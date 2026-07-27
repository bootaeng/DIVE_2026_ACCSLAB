# DIVE 2026 — 부산교통공사 × 짐캐리 데이터 융합 프로젝트

부산 도시철도 데이터와 짐배송(짐캐리) 데이터를 융합한 DIVE 2026 해커톤 프로젝트입니다.

## 폴더 구조

```
├─ code/
│  ├─ backend/          # Node.js API 서버 + Python 서비스 (AI 어시스턴트, ML)
│  ├─ frontend-react/   # React(Vite) 프론트엔드
│  ├─ nocarrier-core/   # 혼잡도 예측·경로 탐색 ML 코어 (Python)
│  └─ sdbwork/          # 실험·프로토타입 작업 공간
├─ docs/                # 기획 제안서, 발표자료, 회의록, 노선도
├─ icon/                # 앱 아이콘
├─ _archive/            # 사용하지 않는 과거 스크립트·컴포넌트 보관
└─ 참가자_제공_데이터/   # (git 미포함) 해커톤 제공 원본 데이터
```

## 실행 준비

1. **환경변수**: `code/backend/.env.example`을 `code/backend/.env`로 복사한 뒤 각 API 키를 발급받아 채워 넣으세요. 실제 키는 절대 커밋하지 마세요.
2. **데이터**: `참가자_제공_데이터/` 폴더(해커톤 제공 데이터)와 `code/nocarrier-core/data/`는 저장소에 포함되지 않습니다. 팀 내부 채널로 별도 공유받아 같은 경로에 배치해야 백엔드가 정상 동작합니다.

```bash
# 백엔드
cd code/backend && npm install && node server.js

# 프론트엔드
cd code/frontend-react && npm install && npm run dev
```
