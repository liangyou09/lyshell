import React from 'react'

const brushImage = new URL('../../assets/scroll/brush-jade-wood-v1.png', import.meta.url).href

/** 原图仅在 SVG 内取帧：笔毫、玉尾保持比例，中间木杆适应按钮宽度。 */
export const BrushArtwork: React.FC = () => (
  <span aria-hidden="true" className="brush-art">
    {[
      { part: 'tip', x: 24, width: 824 },
      { part: 'shaft', x: 848, width: 1027 },
      { part: 'cap', x: 1875, width: 273 }
    ].map(({ part, x, width }) => (
      <svg key={part} className={`brush-art-${part}`} viewBox={`${x} 219 ${width} 280`} preserveAspectRatio="none" focusable="false">
        <image href={brushImage} width="2172" height="724" />
      </svg>
    ))}
  </span>
)
