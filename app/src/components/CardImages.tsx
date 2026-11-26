import { useEffect, useState } from 'react';
import { imageUrl } from '../db';
import type { Card } from '../types';

export const cardTitle = (c: Card) => `${c.subject} ${c.exam} 問${c.number}${c.sub ? `(${c.sub})` : ''}`;

/** kind="q": 問題（原本）、kind="g": 語呂入り。原本がないページは語呂入りで代用 */
export function CardImages({ card, kind }: { card: Card; kind: 'q' | 'g' }) {
  const [urls, setUrls] = useState<string[]>([]);
  useEffect(() => {
    let alive = true;
    (async () => {
      const paths = card.pieces.map((p) => (kind === 'q' ? p.q ?? null : p.g ?? null)).filter((x): x is string => !!x);
      const list = (await Promise.all(paths.map(imageUrl))).filter((x): x is string => !!x);
      if (alive) setUrls(list);
    })();
    return () => { alive = false; };
  }, [card, kind]);
  if (urls.length === 0) return <p className="muted">{kind === 'g' ? '語呂はありません' : '画像がありません'}</p>;
  return (
    <div className="images">
      {urls.map((u) => <img key={u} src={u} alt="" />)}
    </div>
  );
}
