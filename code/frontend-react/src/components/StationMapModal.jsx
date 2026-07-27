import { useState, useEffect, useRef } from 'react'
import { displayStationName } from '../utils/lines'
import officialCoords from '../utils/officialMapCoords.json'

// 공식 노선도 SVG의 viewBox 크기 (클릭 핫스팟 % 좌표 계산용)
const OFFICIAL_W = 2777.95
const OFFICIAL_H = 849.163

// 이름 기준 유니크 역 목록 (환승역은 노선/ID를 합쳐 하나로)
function getUniqueStations(stations) {
  const unique = []
  const seen = new Set()
  stations.forEach(s => {
    const name = s.name.trim()
    if (seen.has(name)) return
    seen.add(name)
    const same = stations.filter(st => st.name.trim() === name)
    unique.push({
      ...s,
      name,
      allLines: same.map(st => st.line),
      allIds: same.map(st => st.id),
    })
  })
  return unique.sort((a, b) => a.name.localeCompare(b.name, 'ko'))
}

/**
 * 부산 도시철도 노선도에서 역을 클릭해 선택하는 공용 모달.
 * - actions: [{ label, base, hover, onSelect(station) }] — 선택 바의 액션 버튼들
 * - resolveHighlight(station): 강조 색상 클래스(선택된 출발/도착/숙소 등) 반환, 없으면 null
 */
export default function StationMapModal({
  stations,
  onClose,
  title = '🗺️ 부산 도시철도 노선망 지도',
  subtitle = '부산 도시철도 전 노선(1~4호선·동해선·부산김해경전철)의 연결 구조를 보여주는 노선도입니다.',
  hint,
  legend = true,
  actions = [],
  resolveHighlight = () => null,
}) {
  const [zoom, setZoom] = useState(0.5)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [selectedNode, setSelectedNode] = useState(null)
  const dragRef = useRef({ active: false, moved: false, sx: 0, sy: 0, px: 0, py: 0 })
  const viewportRef = useRef(null)

  const clampZoom = (z) => Math.min(4, Math.max(0.3, z))
  const zoomIn = () => setZoom(z => clampZoom(z * 1.25))
  const zoomOut = () => setZoom(z => clampZoom(z / 1.25))
  const resetView = () => { setZoom(0.5); setPan({ x: 0, y: 0 }) }

  // 휠 확대/축소 (passive 리스너 회피)
  useEffect(() => {
    const el = viewportRef.current
    if (!el) return
    const handler = (e) => {
      e.preventDefault()
      setZoom(z => Math.min(4, Math.max(0.3, z * (e.deltaY < 0 ? 1.12 : 1 / 1.12))))
    }
    el.addEventListener('wheel', handler, { passive: false })
    return () => el.removeEventListener('wheel', handler)
  }, [])

  const onMapDown = (e) => {
    dragRef.current = { active: true, moved: false, sx: e.clientX, sy: e.clientY, px: pan.x, py: pan.y }
  }
  const onMapMove = (e) => {
    const d = dragRef.current
    if (!d.active) return
    const dx = e.clientX - d.sx, dy = e.clientY - d.sy
    if (Math.abs(dx) + Math.abs(dy) > 4) d.moved = true
    setPan({ x: d.px + dx, y: d.py + dy })
  }
  const onMapUp = () => { dragRef.current.active = false }

  const close = () => { setSelectedNode(null); onClose() }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4 animate-fade-in" onClick={close}>
      <div className="relative max-w-6xl w-full bg-white border border-[#e8ebee] rounded-2xl p-6 shadow-2xl flex flex-col max-h-[90vh]" onClick={(e) => e.stopPropagation()}>
        <div className="flex justify-between items-center mb-2">
          <div>
            <h3 className="text-lg font-bold text-[#191f28]">{title}</h3>
            <p className="text-xs text-[#6b7684] mt-0.5">{subtitle}</p>
          </div>
          <button
            onClick={close}
            className="bg-[#f2f4f6] hover:bg-[#e8ebee] text-[#6b7684] hover:text-[#191f28] rounded-lg px-3 py-1.5 text-xs transition-all cursor-pointer border border-[#e8ebee]"
          >
            ✕ 닫기
          </button>
        </div>

        <div
          ref={viewportRef}
          className="relative flex-1 overflow-hidden rounded-xl bg-white border border-[#e8ebee] select-none"
          style={{ height: '68vh', minHeight: 500 }}
          onMouseDown={onMapDown}
          onMouseMove={onMapMove}
          onMouseUp={onMapUp}
          onMouseLeave={onMapUp}
        >
          {/* Zoom controls */}
          <div className="absolute top-3 right-3 z-20 flex flex-col gap-1.5">
            <button type="button" onClick={zoomIn} title="확대" className="w-9 h-9 rounded-lg bg-white/95 shadow-sm border border-[#d1d6db] text-[#191f28] text-lg font-bold hover:bg-[#e8ebee] cursor-pointer leading-none">＋</button>
            <button type="button" onClick={zoomOut} title="축소" className="w-9 h-9 rounded-lg bg-white/95 shadow-sm border border-[#d1d6db] text-[#191f28] text-lg font-bold hover:bg-[#e8ebee] cursor-pointer leading-none">－</button>
            <button type="button" onClick={resetView} title="원래대로" className="w-9 h-9 rounded-lg bg-white/95 shadow-sm border border-[#d1d6db] text-[#191f28] text-sm font-bold hover:bg-[#e8ebee] cursor-pointer leading-none">⟲</button>
            <span className="text-[9px] text-[#8b95a1] text-center mt-0.5 bg-white/70 rounded">{Math.round(zoom * 100)}%</span>
          </div>

          {/* Selection action bar */}
          {selectedNode && (
            <div className="absolute top-3 left-1/2 -translate-x-1/2 z-20 bg-white/95 backdrop-blur-md border border-[#e8ebee] px-3 py-2 rounded-xl shadow flex items-center gap-2 text-xs animate-fade-in">
              <span className="font-bold text-[#191f28]">{displayStationName(selectedNode.name)}역</span>
              <span className="text-[10px] text-[#6b7684] hidden sm:inline">{selectedNode.allLines.join(', ')}</span>
              {actions.map((a, i) => (
                <button
                  key={i}
                  onClick={() => { a.onSelect(selectedNode); setSelectedNode(null) }}
                  className={`${a.base} text-white font-bold py-1 px-2.5 rounded-lg cursor-pointer border-none`}
                >
                  {a.label}
                </button>
              ))}
              <button onClick={() => setSelectedNode(null)} className="text-[#8b95a1] hover:text-[#191f28] text-[11px] cursor-pointer bg-transparent border-none">✕</button>
            </div>
          )}

          {/* Zoom/pan viewport */}
          <div className="absolute inset-0 flex items-center justify-center" style={{ cursor: dragRef.current.active ? 'grabbing' : 'grab' }}>
            <div style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, transformOrigin: 'center center' }}>
              <div className="relative" style={{ width: 2200 }}>
                <img
                  src="/busan_subway_map.svg"
                  alt="부산 도시철도 노선도"
                  className="w-full h-auto block"
                  draggable="false"
                />
                {getUniqueStations(stations).map(s => {
                  const c = officialCoords[s.name.trim()]
                  if (!c) return null
                  const isSelected = selectedNode && selectedNode.name === s.name
                  const highlight = resolveHighlight(s)
                  return (
                    <button
                      key={`off-${s.name}`}
                      type="button"
                      title={`${displayStationName(s.name)}역 (${s.allLines.join(', ')})`}
                      onClick={() => { if (!dragRef.current.moved) setSelectedNode(s) }}
                      className={`absolute -translate-x-1/2 -translate-y-1/2 rounded-full cursor-pointer border-2 transition-all duration-150 ${
                        highlight
                          ? highlight
                          : isSelected
                            ? 'w-7 h-7 bg-amber-400/80 border-amber-200'
                            : 'w-6 h-6 bg-transparent border-transparent hover:border-[#3182f6] hover:bg-[#3182f6]/25'
                      }`}
                      style={{ left: `${(c.x / OFFICIAL_W) * 100}%`, top: `${(c.y / OFFICIAL_H) * 100}%` }}
                    />
                  )
                })}
              </div>
            </div>
          </div>

          <div className="absolute bottom-2 left-2 z-20 text-xxs text-gray-700 bg-white/85 px-2 py-1 rounded-md border border-gray-200">
            {hint || '🔍 휠 또는 ＋／－ 확대·축소, 드래그로 이동 · 역 클릭 → 선택'}
          </div>
        </div>

        {legend && (
          <div className="mt-4 flex justify-between items-center text-xxs text-[#8b95a1]">
            <span>* 1호선(주황) · 2호선(초록) · 3호선(갈색) · 4호선(파랑) · 동해선(하늘) · 부산김해경전철(보라)</span>
            <span>제공: 부산교통공사</span>
          </div>
        )}
      </div>
    </div>
  )
}
