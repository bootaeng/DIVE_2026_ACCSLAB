// Shared subway-line helpers (centralized so RoutingEngine / NudgeSimulator agree)

export const LINE_ORDER = ['1호선', '2호선', '3호선', '4호선', '동해선', '부산김해경전철']

// Line color palette (공식 부산 도시철도 노선도 기준)
export function getLineColor(line = '') {
  if (line.includes('1호선')) return '#f06a00' // 주황
  if (line.includes('2호선')) return '#41ad49' // 초록
  if (line.includes('3호선')) return '#bb8c00' // 갈색/황토
  if (line.includes('4호선')) return '#2e5fc4' // 파랑
  if (line.includes('동해선')) return '#4e9fd4' // 하늘
  if (line.includes('경전철')) return '#8246aa' // 보라
  return '#6366f1'
}

// Group raw station list by their `line` field, sorted by station id within each line.
// Returns an object keyed by line name → array of stations.
export function groupStationsByLine(stations = []) {
  const groups = {}
  stations.forEach((s) => {
    if (!s || !s.line) return
    if (!groups[s.line]) groups[s.line] = []
    groups[s.line].push(s)
  })
  Object.keys(groups).forEach((line) => {
    groups[line].sort((a, b) => parseInt(a.id, 10) - parseInt(b.id, 10))
  })
  return groups
}

// 표시용 역명 — 데이터 구분용 괄호(예: "부전(동해선)")를 떼고 "부전"처럼 자연스럽게.
// 노선 정보는 별도 라벨로 함께 표시되므로 중복을 피한다.
export function displayStationName(name = '') {
  return name.replace(/\([^)]*\)/g, '').trim()
}

// Distinct line names present in the data, ordered by LINE_ORDER then any extras.
export function getLineList(stations = []) {
  const present = new Set(stations.map((s) => s.line).filter(Boolean))
  const ordered = LINE_ORDER.filter((l) => present.has(l))
  const extras = [...present].filter((l) => !LINE_ORDER.includes(l))
  return [...ordered, ...extras]
}
