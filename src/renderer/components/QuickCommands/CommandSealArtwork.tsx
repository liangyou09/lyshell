import React from 'react'

const seal = new URL('../../assets/scroll/command-seal-white-jade-v1.png', import.meta.url).href
const greySeal = new URL('../../assets/scroll/command-seal-grey-jade-v1.png', import.meta.url).href

const SealImages: React.FC = () => <>
  <image className="command-seal-image-light" href={seal} width="2100" height="749" />
  <image className="command-seal-image-dark" href={greySeal} width="2100" height="749" />
</>

/** 浅色白玉、深色灰玉；只拉伸空白签面，圆角两端保持固定尺寸。 */
export const CommandSealArtwork: React.FC = () => (
  <span className="command-seal-art" aria-hidden="true">
    <svg className="command-seal-end" viewBox="20 225 95 298" preserveAspectRatio="none">
      <SealImages />
    </svg>
    <svg className="command-seal-middle" viewBox="115 225 1870 298" preserveAspectRatio="none">
      <SealImages />
    </svg>
    <svg className="command-seal-end" viewBox="1985 225 95 298" preserveAspectRatio="none">
      <SealImages />
    </svg>
  </span>
)
