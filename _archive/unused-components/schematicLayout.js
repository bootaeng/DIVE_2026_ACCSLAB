// 직선형(스키매틱) 노선도 좌표 생성 — 공식 부산 도시철도 노선도(네이버) 배치를 재현
//
// 방식: 환승역/종점/굴절점을 "컨트롤 포인트"로 두고(그리드 단위, y는 아래로=남쪽),
// 그 사이 역들은 직선 구간 위에 인덱스 비율로 균등 배치한다. 환승역은 여러 노선에서
// 동일 좌표(ANCHORS)를 공유하므로 노선들이 정확히 만난다.
// 좌표는 공식 노선도 이미지에서 읽은 상대 위치(≈ px/20)이며, 마지막에 캔버스에 맞춰
// 종횡비를 보존하며 자동으로 스케일·센터링한다.

// 환승·공유역 앵커 (그리드; x: 좌→우, y: 위(북)→아래(남))
const ANCHORS = {
  '서면': [50.6, 47],
  '부전': [50.6, 43.75],
  '연산': [50.6, 36.5],
  '교대': [50.6, 34],
  '동래': [50.6, 32],
  '미남': [46.75, 33],
  '거제': [47, 36.5],
  '수영': [68, 40.75],
  '벡스코': [73, 33.5],
  '덕천': [33.6, 30.5],
  '사상': [33.6, 45],
  '대저': [23.25, 35]
}

// 노선별 컨트롤 포인트 [역명, x, y] — 역 id 순서대로(종점·굴절·환승)
const LINE_CONTROLS = {
  '1호선': [
    ['다대포해수욕장', 31, 77], ['하단', 32.25, 64], ['남포', 50.6, 61],
    ['서면', 50.6, 47], ['부전', 50.6, 43.75], ['연산', 50.6, 36.5],
    ['교대', 50.6, 34], ['동래', 50.6, 32], ['노포', 50.6, 13.5]
  ],
  '2호선': [
    ['장산', 86.5, 30.9], ['벡스코', 73, 33.5], ['수영', 68, 40.75],
    ['남천', 68, 51], ['지게골', 59, 55], ['전포', 52, 49],
    ['서면', 50.6, 47], ['사상', 33.6, 45], ['덕천', 33.6, 30.5], ['양산', 33.6, 14.5]
  ],
  '3호선': [
    ['수영', 68, 40.75], ['연산', 50.6, 36.5], ['거제', 47, 36.5],
    ['미남', 46.75, 33], ['덕천', 33.6, 30.5], ['대저', 23.25, 35]
  ],
  '4호선': [
    ['미남', 46.75, 33], ['동래', 50.6, 32], ['반여농산물시장', 69.25, 32], ['안평', 69.25, 14.5]
  ],
  // 동해선 부전/동래는 1·4호선과 별개 역(간접환승) → 살짝 떨어뜨려 배치
  '동해선': [
    ['부전(동해선)', 47, 45], ['거제', 47, 36.5], ['교대', 50.6, 34], ['동래(동해선)', 54, 33],
    ['벡스코', 73, 33.5], ['신해운대', 78, 32], ['태화강', 78, 11.75]
  ],
  '부산김해경전철': [
    ['사상', 33.6, 45], ['대저', 23.25, 35], ['김해시청', 16.5, 25], ['가야대', 14.5, 14.5]
  ]
}

// stations: [{id, name, line}], returns { [name]: {x, y} } in canvas coords
export function computeSchematicLayout(stations, W, H, PAD) {
  const raw = {}

  const byLine = {}
  stations.forEach((s) => {
    if (!s || !s.line) return
    ;(byLine[s.line] = byLine[s.line] || []).push(s)
  })

  Object.keys(byLine).forEach((line) => {
    const list = byLine[line].slice().sort((a, b) => parseInt(a.id, 10) - parseInt(b.id, 10))
    const controls = LINE_CONTROLS[line]

    if (!controls) {
      list.forEach((s, i) => {
        const t = list.length > 1 ? i / (list.length - 1) : 0
        if (raw[s.name] === undefined) raw[s.name] = { x: 50, y: 12 + t * 66 }
      })
      return
    }

    const ctrl = controls
      .map((c) => ({ x: c[1], y: c[2], idx: list.findIndex((s) => s.name === c[0]) }))
      .filter((c) => c.idx >= 0)
      .sort((a, b) => a.idx - b.idx)
    if (ctrl.length === 0) return

    for (let c = 0; c < ctrl.length - 1; c++) {
      const A = ctrl[c]
      const B = ctrl[c + 1]
      for (let i = A.idx; i <= B.idx; i++) {
        const t = B.idx === A.idx ? 0 : (i - A.idx) / (B.idx - A.idx)
        const name = list[i].name
        if (raw[name] === undefined) {
          raw[name] = { x: A.x + (B.x - A.x) * t, y: A.y + (B.y - A.y) * t }
        }
      }
    }
    const first = ctrl[0]
    const last = ctrl[ctrl.length - 1]
    for (let i = 0; i < first.idx; i++) {
      const n = list[i].name
      if (raw[n] === undefined) raw[n] = { x: first.x, y: first.y }
    }
    for (let i = last.idx + 1; i < list.length; i++) {
      const n = list[i].name
      if (raw[n] === undefined) raw[n] = { x: last.x, y: last.y }
    }
  })

  // 앵커(환승역)는 항상 정확한 공유 좌표로 확정
  Object.keys(ANCHORS).forEach((name) => {
    raw[name] = { x: ANCHORS[name][0], y: ANCHORS[name][1] }
  })

  // 종횡비 보존하며 캔버스에 맞게 스케일 + 센터링
  const names = Object.keys(raw)
  if (names.length === 0) return {}
  const xs = names.map((n) => raw[n].x)
  const ys = names.map((n) => raw[n].y)
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)
  const spanX = maxX - minX || 1
  const spanY = maxY - minY || 1
  const usableW = W - 2 * PAD
  const usableH = H - 2 * PAD
  const scale = Math.min(usableW / spanX, usableH / spanY)
  const offX = PAD + (usableW - spanX * scale) / 2
  const offY = PAD + (usableH - spanY * scale) / 2

  const layout = {}
  names.forEach((n) => {
    layout[n] = {
      x: offX + (raw[n].x - minX) * scale,
      y: offY + (raw[n].y - minY) * scale
    }
  })
  return layout
}
