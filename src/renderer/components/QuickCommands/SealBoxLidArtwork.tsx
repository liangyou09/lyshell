import React from 'react'

const lid = new URL('../../assets/scroll/seal-box-lid-ash-v1.png', import.meta.url).href

/** 仅在渲染时取图：两端圆角保留比例，中段木纹随侧栏宽度伸缩。 */
export const SealBoxLidArtwork: React.FC = () => (
  <span className="seal-box-lid-art" aria-hidden="true">
    <svg className="seal-box-lid-end" viewBox="0 255 140 220" preserveAspectRatio="none">
      <image href={lid} width="2171" height="724" />
    </svg>
    <svg className="seal-box-lid-middle" viewBox="140 255 1891 220" preserveAspectRatio="none">
      <image href={lid} width="2171" height="724" />
    </svg>
    <svg className="seal-box-lid-end" viewBox="2031 255 140 220" preserveAspectRatio="none">
      <image href={lid} width="2171" height="724" />
    </svg>
  </span>
)
