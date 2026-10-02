import type { CSSProperties } from 'react';

const icons: Record<string, string> = {
  claude: '/harness-icons/anthropic.svg',
  opencode: '/harness-icons/opencode.svg',
  gemini: '/harness-icons/gemini.svg',
  'cursor-agent': '/harness-icons/cursor.svg',
};

const monograms: Record<string, string> = {
  codex: 'C',
  muse: 'M',
  antigravity: 'A',
  zcode: 'Z',
};

export function HarnessIcon({ harness, size = 18, label }: { harness: string; size?: number; label?: string }) {
  const key = harness.toLowerCase();
  const icon = icons[key];
  const fallback = monograms[key] ?? (['auto', 'automatic', 'unknown'].includes(key) ? '◇' : '?');
  const style: CSSProperties = { width: size, height: size, flex: `0 0 ${size}px` };

  return (
    <span
      aria-hidden={label ? undefined : true}
      aria-label={label}
      role={label ? 'img' : undefined}
      title={label}
      style={{ ...style, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', verticalAlign: 'middle' }}
    >
      {icon ? (
        <img src={icon} alt="" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
      ) : (
        <span style={{ fontSize: size * 0.72, lineHeight: 1, fontWeight: 600 }}>{fallback}</span>
      )}
    </span>
  );
}
