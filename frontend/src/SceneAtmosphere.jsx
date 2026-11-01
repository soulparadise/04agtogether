import React from 'react';
import './scene-atmosphere.css';

// Coordinates follow the approved 1672 × 941 illustration. Reusing its pixels
// keeps the sign's lettering, glow and perspective aligned with the background.
// Seeded distribution stays stable across React renders, without a visible grid.
const noise = value => {
  const sample = Math.sin(value * 127.1 + 311.7) * 43758.5453;
  return sample - Math.floor(sample);
};
const drops = Array.from({ length: 340 }, (_, index) => ({
  x: noise(index + 1) * 1800 - 60,
  y: noise(index + 501) * 1200 - 180,
  length: 4 + noise(index + 901) * 9,
  opacity: .2 + noise(index + 1201) * .5,
  duration: 1.9 + noise(index + 1501) * 1.1,
  delay: -noise(index + 1801) * 8
}));

export default function SceneAtmosphere() {
  return <div className="scene-atmosphere" aria-hidden="true">
    <svg className="scene-light" viewBox="0 0 1672 941" preserveAspectRatio="xMidYMid slice">
      <defs>
        <clipPath id="noir-shcha-shape"><polygon points="858,242 902,230 904,283 894,290 892,277 859,287" /></clipPath>
        <clipPath id="noir-a-shape"><polygon points="1098,183 1133,174 1137,230 1098,242" /></clipPath>
        <filter id="noir-neon-mask">
          <feColorMatrix values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  1 0 0 0 0" />
          <feComponentTransfer><feFuncA type="gamma" amplitude="1" exponent="4" offset="0" /></feComponentTransfer>
        </filter>
        <mask id="noir-shcha" maskUnits="userSpaceOnUse" x="850" y="220" width="65" height="80"><image href="/assets/cyberpunk-noir.webp" width="1672" height="941" clipPath="url(#noir-shcha-shape)" filter="url(#noir-neon-mask)" /></mask>
        <mask id="noir-a" maskUnits="userSpaceOnUse" x="1090" y="165" width="55" height="85"><image href="/assets/cyberpunk-noir.webp" width="1672" height="941" clipPath="url(#noir-a-shape)" filter="url(#noir-neon-mask)" /></mask>
        <radialGradient id="noir-mist"><stop stopColor="#dc92bf" stopOpacity=".95" /><stop offset=".45" stopColor="#a96eaa" stopOpacity=".6" /><stop offset="1" stopColor="#8f6eac" stopOpacity="0" /></radialGradient>
        <filter id="noir-mist-noise" x="-25%" y="-50%" width="150%" height="200%">
          <feTurbulence type="fractalNoise" baseFrequency=".009 .019" numOctaves="3" seed="12" />
          <feColorMatrix values="0 0 0 0 .83  0 0 0 0 .58  0 0 0 0 .76  1.9 0 0 0 -.52" />
          <feComposite in2="SourceGraphic" operator="in" />
          <feGaussianBlur stdDeviation="3" />
        </filter>
        <radialGradient id="noir-warm"><stop stopColor="#ff9a37" stopOpacity=".28" /><stop offset="1" stopColor="#ff751b" stopOpacity="0" /></radialGradient>
        <radialGradient id="noir-pink"><stop stopColor="#ff2d91" stopOpacity=".2" /><stop offset="1" stopColor="#ff2d91" stopOpacity="0" /></radialGradient>
        <filter id="noir-dim"><feComponentTransfer><feFuncR type="linear" slope=".32" /><feFuncG type="linear" slope=".32" /><feFuncB type="linear" slope=".32" /></feComponentTransfer></filter>
      </defs>
      <image className="letter-flicker letter-shcha" href="/assets/cyberpunk-noir.webp" width="1672" height="941" mask="url(#noir-shcha)" filter="url(#noir-dim)" />
      <image className="letter-flicker letter-a" href="/assets/cyberpunk-noir.webp" width="1672" height="941" mask="url(#noir-a)" filter="url(#noir-dim)" />
      <g className="window-warmth"><ellipse cx="840" cy="535" rx="170" ry="150" fill="url(#noir-warm)" /><ellipse cx="1080" cy="543" rx="105" ry="210" fill="url(#noir-warm)" /></g>
      <g className="wet-reflection"><ellipse cx="910" cy="855" rx="300" ry="70" fill="url(#noir-pink)" /><ellipse cx="1100" cy="860" rx="160" ry="55" fill="url(#noir-warm)" /></g>
      <g className="mist-drift mist-back"><ellipse cx="545" cy="717" rx="270" ry="95" fill="url(#noir-mist)" filter="url(#noir-mist-noise)" /></g>
      <g className="mist-drift mist-front"><ellipse cx="755" cy="802" rx="350" ry="85" fill="url(#noir-mist)" filter="url(#noir-mist-noise)" /></g>
    </svg>
    <svg className="scene-rain" viewBox="0 0 1672 941" preserveAspectRatio="xMidYMid slice">
      <defs><linearGradient id="noir-rain-streak" x1="0" y1="0" x2="0" y2="1"><stop stopColor="#b8a7c5" stopOpacity="0" /><stop offset=".75" stopColor="#cdb9d4" stopOpacity=".85" /><stop offset="1" stopColor="#cdb9d4" stopOpacity=".2" /></linearGradient></defs>
      <g className="rain-far">{drops.map((drop, index) => <path key={index} style={{ opacity:drop.opacity, animationDuration: `${drop.duration}s`, animationDelay: `${drop.delay}s` }} d={`M${drop.x} ${drop.y}l-${drop.length * .11} ${drop.length}`} />)}</g>
      <g className="rain-near">{drops.filter((_, index) => index % 13 === 0).map((drop, index) => <path key={index} style={{ opacity:drop.opacity * .7, animationDuration: `${drop.duration * .7}s`, animationDelay: `${drop.delay}s` }} d={`M${drop.x + 60} ${drop.y - 90}l-2 ${drop.length + 6}`} />)}</g>
    </svg>
  </div>;
}
